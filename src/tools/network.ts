import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";
import { normalizeUrl } from "../page/collect.ts";
import { ToolError } from "../shared/errors.ts";
import { isTextualMime } from "../shared/mime.ts";
import {
  addRule,
  buildHar,
  clearRules,
  headersOf,
  listRules,
  removeRule,
  responseBody,
  urlPattern,
} from "../browser/network.ts";
import { shownUrl, untrusted } from "../shared/output.ts";
import { documentOrder, type NetworkEntry, type PendingRequest, type Tab } from "../browser/tab.ts";
import type { Request } from "playwright-core";
import {
  clipToFile,
  defineTool,
  tabParam,
  timeoutParam,
  type ToolDeps,
  type ToolInput,
} from "./common.ts";

const requestInput = {
  tab: tabParam
    .optional()
    .describe("Tab to take from_request from, and the page to run in for via page."),
  from_request: z
    .number()
    .int()
    .optional()
    .describe(
      "Id of a captured request (from network) to replay; needs tab, the tab it was captured in.",
    ),
  url: z.string().optional().describe("Request URL. Required unless from_request is given."),
  method: z
    .string()
    .optional()
    .describe("HTTP method. Default GET, or the replayed request's method."),
  headers: z.record(z.string(), z.string()).optional().describe("Headers to set or override."),
  remove_headers: z
    .array(z.string())
    .optional()
    .describe("Header names to drop from a replayed request."),
  query: z
    .record(z.string(), z.string())
    .optional()
    .describe("Query parameters to set or override on the URL."),
  body: z
    .string()
    .optional()
    .describe("Request body. For JSON, pass the JSON text and a content-type header."),
  via: z
    .enum(["browser", "page"])
    .optional()
    .describe("Where the request is sent from. Default browser."),
  save: z
    .boolean()
    .optional()
    .describe("Always save the response body to a file and return its path. Default false."),
  timeout_ms: timeoutParam(30_000),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(200_000)
    .optional()
    .describe("Character budget for the body in the result. Default 8000."),
};

async function sendRequest({ manager, store }: ToolDeps, input: ToolInput<typeof requestInput>) {
  const tab = input.tab ? manager.getTab(input.tab) : undefined;
  const source =
    input.from_request === undefined
      ? undefined
      : tab?.network.find((entry) => entry.id === input.from_request);
  if (input.from_request !== undefined && !source) {
    throw new ToolError(
      `Request ${input.from_request} is not in the buffer${tab ? ` of ${tab.id}` : ""}.`,
      "Pass the tab it was captured in, and list network for current ids.",
    );
  }
  const rawUrl = input.url ?? source?.url;
  if (!rawUrl) throw new ToolError("Give url or from_request.");
  const url = new URL(normalizeUrl(rawUrl));
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);

  const headers: Record<string, string> = {};
  if (source) {
    const dropped = new Set([
      "host",
      "content-length",
      "cookie",
      "connection",
      "accept-encoding",
      ...(input.remove_headers ?? []).map((name) => name.toLowerCase()),
    ]);
    for (const [name, value] of Object.entries(await source.request.allHeaders())) {
      if (!name.startsWith(":") && !dropped.has(name.toLowerCase())) headers[name] = value;
    }
  }
  Object.assign(headers, input.headers ?? {});
  const method = (input.method ?? source?.method ?? "GET").toUpperCase();
  const body = input.body ?? source?.request.postData() ?? undefined;
  const timeout = input.timeout_ms ?? 30_000;

  let status: number;
  let responseHeaders: Record<string, string>;
  let payload: Buffer;
  if (input.via === "page") {
    if (!tab) throw new ToolError("via page needs tab.");
    const fetched = await withDeadline(
      tab.page.evaluate(
        async ([target, init]) => {
          const response = await fetch(target, init);
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000)
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            base64: btoa(binary),
          };
        },
        [
          url.href,
          {
            method,
            headers,
            body: method === "GET" || method === "HEAD" ? undefined : body,
            credentials: "include" as const,
          },
        ] as const,
      ),
      timeout,
    );
    if (fetched === TIMED_OUT)
      throw new ToolError(
        `The request did not finish within ${timeout} ms in the page.`,
        "The page may be busy, or the server slow; raise timeout_ms or use via browser.",
      );
    const result = fetched;
    status = result.status;
    responseHeaders = result.headers;
    payload = Buffer.from(result.base64, "base64");
  } else {
    const context = await manager.ensureContext();
    const response = await context.request.fetch(url.href, {
      method,
      headers,
      data: body,
      timeout,
      failOnStatusCode: false,
    });
    status = response.status();
    responseHeaders = response.headers();
    payload = await response.body();
  }

  const contentType = responseHeaders["content-type"] ?? "";
  const isText = isTextualMime(contentType) || payload.length === 0;
  const lines = [
    `${method} ${url.href} → HTTP ${status}`,
    `content-type: ${contentType || "-"} · ${payload.length} bytes`,
  ];
  for (const name of [
    "location",
    "set-cookie",
    "content-disposition",
    "retry-after",
    "x-ratelimit-remaining",
  ]) {
    if (responseHeaders[name]) lines.push(`${name}: ${responseHeaders[name]}`);
  }
  if (!isText || input.save) {
    const extension = /json/i.test(contentType)
      ? "json"
      : /html/i.test(contentType)
        ? "html"
        : /pdf/i.test(contentType)
          ? "pdf"
          : isText
            ? "txt"
            : "bin";
    const file = await store.write(
      "requests",
      store.uniqueName(url.hostname + url.pathname, extension),
      isText ? payload.toString("utf8") : payload,
    );
    lines.push(`Body saved to ${file}`);
    if (!isText) return lines.join("\n");
  }
  lines.push(
    "",
    (
      await clipToFile(
        store,
        "requests",
        url.hostname + url.pathname,
        payload.toString("utf8"),
        input.max_chars ?? 8000,
      )
    ).text,
  );
  return untrusted(url.href, lines.join("\n"));
}

const waitedSeconds = (startedAt: number) => ((Date.now() - startedAt) / 1000).toFixed(1);

const leftBehind = (tab: Tab, documentId: number) =>
  documentId !== tab.currentDocument && documentId !== tab.committingDocument;

const REQUEST_STATES = ["answered", "failed", "waiting", "abandoned"] as const;

const requestField = z.object({
  id: z.number().int(),
  method: z.string(),
  type: z.string(),
  url: z.string(),
  status: z.number().int().optional(),
  failure: z.string().optional(),
  state: z.enum(REQUEST_STATES),
  waitedMs: z.number().optional(),
});

function answeredFact(entry: NetworkEntry) {
  return {
    id: entry.id,
    method: entry.method,
    type: entry.resourceType,
    url: entry.url,
    status: entry.status,
    failure: entry.failure,
    state: entry.failure === undefined ? ("answered" as const) : ("failed" as const),
  };
}

function pendingFact(tab: Tab, request: Request, pending: PendingRequest) {
  const left = leftBehind(tab, pending.documentId);
  return {
    id: pending.id,
    method: request.method(),
    type: request.resourceType(),
    url: request.url(),
    state: left ? ("abandoned" as const) : ("waiting" as const),
    waitedMs: left ? undefined : Date.now() - pending.startedAt,
  };
}

function headerLines(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
}

type RuleMode = "block" | "modify" | "mock" | "patch_response";
const RULE_FIELD_MODES = {
  set_headers: ["modify", "patch_response"],
  remove_headers: ["modify", "patch_response"],
  method: ["modify"],
  post_data: ["modify"],
  rewrite_url: ["modify"],
  mock_status: ["mock"],
  mock_headers: ["mock"],
  mock_content_type: ["mock"],
  mock_body: ["mock"],
  replacements: ["patch_response"],
} satisfies Record<string, readonly RuleMode[]>;
const RULE_FIELDS = [
  "set_headers",
  "remove_headers",
  "method",
  "post_data",
  "rewrite_url",
  "mock_status",
  "mock_headers",
  "mock_content_type",
  "mock_body",
  "replacements",
] as const satisfies readonly (keyof typeof RULE_FIELD_MODES)[];
const ADD_ONLY_FIELDS = ["url", "regex", "mode", ...RULE_FIELDS] as const;

const LIST_FILTERS = ["pattern", "types", "failed_only", "limit"] as const;
const EXPORT_EXCLUDED = ["limit", "failed_only", "max_chars"] as const;
const EXPORT_ONLY = ["include_bodies", "label"] as const;

function rejectTogether(mode: string, names: readonly string[]) {
  if (names.length === 0) return;
  throw new ToolError(
    `${mode} cannot be combined with ${names.join(", ")}.`,
    mode === "id"
      ? "Pass id alone to read one request, or leave it out to list."
      : "Leave those out; har writes every matching request.",
  );
}

async function networkDetail({ store }: ToolDeps, tab: Tab, id: number, budget: number) {
  const entry = tab.network.find((candidate) => candidate.id === id);
  const waiting = entry ? undefined : [...tab.pending].find(([, pending]) => pending.id === id);
  if (waiting) {
    const [request, pending] = waiting;
    const { startedAt, documentId } = pending;
    const text = untrusted(
      tab.page.url(),
      [
        `${request.method()} ${request.url()}`,
        "",
        "Request headers:",
        ...headerLines(await headersOf(request)),
        "",
        leftBehind(tab, documentId)
          ? "No response: the tab left the page before the server answered."
          : `Still waiting for a response after ${waitedSeconds(startedAt)} s.`,
      ].join("\n"),
    );
    return { text, data: { request: pendingFact(tab, request, pending) } };
  }
  if (!entry)
    throw new ToolError(
      `Request ${id} is no longer in the buffer of ${tab.id}.`,
      "List requests again; only the most recent ones are kept.",
    );
  const lines = [
    `${entry.method} ${entry.status ?? entry.failure} ${entry.url}`,
    "",
    "Request headers:",
    ...headerLines(await headersOf(entry.request)),
  ];
  const postData = entry.request.postData();
  if (postData)
    lines.push(
      "",
      "Request body:",
      (await clipToFile(store, "network", `${tab.id}-request-${entry.id}-body`, postData, budget))
        .text,
    );
  if (entry.response) {
    lines.push("", "Response headers:", ...headerLines(await headersOf(entry.response)));
    const { body, note } = await responseBody(entry);
    lines.push(
      "",
      "Response body:",
      body
        ? (
            await clipToFile(
              store,
              "network",
              `${tab.id}-request-${entry.id}`,
              body.toString("utf8"),
              budget,
            )
          ).text
        : `<${note}>`,
    );
  }
  return {
    text: untrusted(tab.page.url(), lines.join("\n")),
    data: { request: answeredFact(entry) },
  };
}

type ListFilters = { pattern?: string; types?: string[]; failed_only?: boolean; limit?: number };

function networkList(tab: Tab, input: ListFilters) {
  const pattern = input.pattern === undefined ? undefined : urlPattern(input.pattern);
  const filtered = pattern !== undefined || input.types !== undefined || input.failed_only === true;
  const matches = (url: string, resourceType: string) =>
    (!pattern || pattern.test(url)) && (!input.types || input.types.includes(resourceType));
  const limit = input.limit ?? 40;
  const entries = tab.network
    .filter((entry) => matches(entry.url, entry.resourceType))
    .filter(
      (entry) => !input.failed_only || entry.failure !== undefined || (entry.status ?? 0) >= 400,
    )
    .slice(-limit);
  const pending = input.failed_only
    ? []
    : [...tab.pending]
        .filter(([request]) => matches(request.url(), request.resourceType()))
        .slice(-limit);
  if (entries.length === 0 && pending.length === 0)
    return {
      text: filtered
        ? `No network entries match the filter in ${tab.network.length + tab.pending.size} captured requests of ${tab.id}.`
        : `No network entries captured for ${tab.id} yet.`,
      data: { pages: [] },
    };
  const currentId = tab.currentDocument;
  const documentIds = documentOrder(tab, [
    ...new Set([
      ...entries.map((entry) => entry.documentId),
      ...pending.map(([, { documentId }]) => documentId),
      currentId,
    ]),
  ]);
  const lines: string[] = [];
  const pages: {
    url?: string;
    current: boolean;
    requests: z.infer<typeof requestField>[];
  }[] = [];
  for (const documentId of documentIds) {
    const own = entries.filter((entry) => entry.documentId === documentId);
    const waiting = pending.filter(([, { documentId: owning }]) => owning === documentId);
    const url = tab.documents.find((candidate) => candidate.id === documentId)?.url;
    pages.push({
      url: url === undefined ? undefined : shownUrl(url),
      current: documentId === currentId,
      requests: [
        ...own.map(answeredFact),
        ...waiting.map(([request, waited]) => pendingFact(tab, request, waited)),
      ],
    });
    const header = `Page ${url ? shownUrl(url) : "(earlier page)"}${documentId === currentId ? " (current)" : ""}`;
    if (own.length === 0 && waiting.length === 0) {
      lines.push(`${header}: no ${filtered ? "matching " : ""}requests.`);
      continue;
    }
    lines.push(
      `${header}:`,
      ...own.map(
        (entry) =>
          `#${entry.id} ${entry.method} ${entry.status ?? `FAILED ${entry.failure}`} ${entry.resourceType} ${entry.url.slice(0, 300)}`,
      ),
    );
    if (waiting.length) {
      const left = leftBehind(tab, documentId);
      lines.push(
        ...(own.length ? [""] : []),
        left
          ? "Abandoned without a response when the tab left the page:"
          : "Still waiting for a response:",
        ...waiting.map(([request, { id, startedAt }]) => {
          const line = `#${id} ${request.method()} ${request.resourceType()} ${request.url().slice(0, 300)}`;
          return left ? line : `${line} (waiting ${waitedSeconds(startedAt)} s)`;
        }),
      );
    }
  }
  return {
    text: untrusted(tab.page.url(), lines.join("\n")),
    payloadFrame: (shown: string) =>
      untrusted(tab.page.url(), `Requests of ${tab.id} by page, newest page last: ${shown}`),
    data: { pages },
  };
}

export function registerNetworkTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "network",
    title: "Network requests",
    description: [
      "List a tab's recent network requests, grouped by the page they came from with each page's URL and the newest page last (id, method, status, resource type, URL), return one request in full with id (request headers and body, response headers and response body), or write the capture to a HAR 1.2 file with har. Use it to find the API call behind a page, a table, a search or an infinite list and read its JSON directly, to see which requests failed (failed_only), or to debug a local app. Each tab keeps its latest 1000 requests since it was opened. Requests still waiting for a response are listed after the others of their page with their id and how long they have waited; with that id the call shows the request headers. Requests of an earlier page that never got an answer before the tab left it are listed as abandoned instead. Streaming responses (text/event-stream) and bodies that do not finish within a few seconds are reported as unavailable instead of waited for. Text bodies up to 1 MB are kept as they arrive on tabs you opened; on a tab the user opened, they are kept only from your first network call on it, and earlier bodies are read on demand and may no longer be available.",
      "id excludes pattern, types, failed_only, limit and har. har writes every matching request (pattern and types narrow it; include_bodies, default true, adds response bodies up to 2 MB each; label names the file), excludes limit, failed_only and max_chars, and returns the path. The HAR is raw: cookies, tokens and typed passwords appear as sent, and the file stays until you delete it. max_chars (default 8000) applies to id.",
      "Once you know the endpoint, request calls it again with other parameters or pages and from_request replays a captured one; intercept changes requests and responses.",
    ].join("\n"),
    input: {
      tab: tabParam,
      id: z
        .number()
        .int()
        .optional()
        .describe(
          "Return request headers and body, response headers and response body of this request id instead of the list.",
        ),
      pattern: z
        .string()
        .optional()
        .describe(
          "Keep only requests whose URL contains this, case-insensitive; * stands for any characters, / included, for example *.png or **/api/**.",
        ),
      failed_only: z
        .boolean()
        .optional()
        .describe("Keep only failed requests and HTTP status 400 or higher. Default false."),
      types: z
        .array(z.string())
        .optional()
        .describe('Keep only these resource types, for example ["xhr", "fetch", "document"].'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .describe("Maximum entries to list, newest kept. Default 40."),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .optional()
        .describe(
          "With id: character budget for the request body and for the response body. Default 8000.",
        ),
      har: z
        .boolean()
        .optional()
        .describe("true writes the matching requests to a HAR file and returns its path."),
      include_bodies: z
        .boolean()
        .optional()
        .describe("With har: include response bodies. Default true."),
      label: z.string().optional().describe("With har: short name used in the file name."),
    },
    output: {
      pages: z
        .array(
          z.object({
            url: z.string().optional(),
            current: z.boolean(),
            requests: z.array(requestField),
          }),
        )
        .optional(),
      request: requestField.optional(),
      harFile: z.string().optional(),
    },
    payload: ["pages"],
    readOnly: true,
    handler: async (input) => {
      const exporting = input.har === true;
      if (input.id !== undefined) {
        rejectTogether("id", [
          ...LIST_FILTERS.filter((name) => input[name] !== undefined),
          ...(input.har === undefined ? [] : ["har"]),
        ]);
      }
      if (exporting) {
        rejectTogether(
          "har",
          EXPORT_EXCLUDED.filter((name) => input[name] !== undefined),
        );
      }
      if (!exporting) {
        for (const name of EXPORT_ONLY) {
          if (input[name] !== undefined) throw new ToolError(`${name} needs har.`);
        }
      }
      if (input.id === undefined && input.max_chars !== undefined)
        throw new ToolError("max_chars needs id.");
      const tab = manager.getTab(input.tab);
      tab.captureBodies = true;
      if (input.id !== undefined)
        return networkDetail(deps, tab, input.id, input.max_chars ?? 8000);
      if (exporting) {
        const pattern = input.pattern === undefined ? undefined : urlPattern(input.pattern);
        const entries = tab.network
          .filter((entry) => !pattern || pattern.test(entry.url))
          .filter((entry) => !input.types || input.types.includes(entry.resourceType));
        if (entries.length === 0)
          return { text: `No matching network entries captured for ${tab.id}.`, data: {} };
        const har = await buildHar(entries, input.include_bodies ?? true, tab.page.url());
        const file = await store.write(
          "har",
          store.uniqueName(input.label ?? `${tab.id}-network`, "har"),
          JSON.stringify(har, null, 1),
          { raw: true },
        );
        return { text: `Exported ${entries.length} requests to ${file}`, data: { harFile: file } };
      }
      return networkList(tab, input);
    },
  });

  defineTool(server, deps, {
    name: "intercept",
    title: "Intercept requests",
    description: [
      "Add, list, remove or clear rules that intercept the network requests of a tab. A rule matches request URLs by text, where * stands for any characters, / included (* matches every request, *.png every PNG, https://example.com/api/* everything under that path, **/api/** every URL with /api/ in it), or by regex, and applies one mode: block aborts the request; modify changes the outgoing request (headers, method, body, or target URL) and lets it continue; mock answers without contacting the server; patch_response fetches the real response and replaces text in its body. Use it to see how a page handles a failing or different API response, to block trackers or heavy resources, to send requests to a local server, or to add a header.",
      "patch_response only rewrites textual bodies (HTML, JSON, JavaScript, XML, SVG, plain text); images and other binary responses pass through unchanged. Rules stay active until removed or the tab closes; list shows each rule's hits and failures. If a rule fails on a request (for example a rewrite_url with another protocol, or an unreachable upstream), the request continues unmodified or is aborted, and the failure is shown in list. When several rules match one request, only the most recently added one applies. Rule numbers are never reused within a tab. The Cookie header cannot be changed by a rule; use storage with area cookies instead. Each mode accepts only its own fields, and a field that belongs to another mode is rejected. To send a request yourself use request; for logic beyond these modes, call page.route() from run_script.",
    ].join("\n"),
    input: {
      tab: tabParam,
      action: z
        .enum(["add", "list", "remove", "clear"])
        .describe(
          "add creates a rule; list shows rules and hit counts; remove deletes rule_id; clear deletes all rules of the tab.",
        ),
      url: z
        .string()
        .optional()
        .describe(
          "For add: match requests whose URL contains this text, ignoring case; * stands for any characters, / included, for example *.png or **/api/**.",
        ),
      regex: z
        .boolean()
        .optional()
        .describe("Treat url as a case-insensitive regular expression. Default false."),
      mode: z
        .enum(["block", "modify", "mock", "patch_response"])
        .optional()
        .describe("For add, required: block, modify, mock or patch_response."),
      set_headers: z
        .record(z.string(), z.string())
        .optional()
        .describe("modify, patch_response: request headers to set or override."),
      remove_headers: z
        .array(z.string())
        .optional()
        .describe("modify, patch_response: request header names to remove."),
      method: z.string().optional().describe("modify: replace the HTTP method."),
      post_data: z.string().optional().describe("modify: replace the request body."),
      rewrite_url: z
        .string()
        .optional()
        .describe(
          "modify: send the request to this http or https URL instead; it must use the same protocol as the request, otherwise the request continues unchanged and the rule records a failure.",
        ),
      mock_status: z
        .number()
        .int()
        .min(100)
        .max(599)
        .optional()
        .describe("mock: HTTP status. Default 200."),
      mock_headers: z.record(z.string(), z.string()).optional().describe("mock: response headers."),
      mock_content_type: z
        .string()
        .optional()
        .describe("mock: Content-Type. Default application/json."),
      mock_body: z.string().optional().describe("mock: response body."),
      replacements: z
        .array(z.strictObject({ find: z.string().min(1), replace: z.string() }))
        .optional()
        .describe(
          "patch_response: literal text replacements applied to the response body in order.",
        ),
      rule_id: z.number().int().optional().describe("For remove: the rule number from list."),
    },
    handler: async (input) => {
      if (input.action !== "add") {
        for (const field of ADD_ONLY_FIELDS) {
          if (input[field] !== undefined)
            throw new ToolError(`${field} applies to add, not ${input.action}.`);
        }
      }
      if (input.action !== "remove" && input.rule_id !== undefined)
        throw new ToolError(`rule_id applies to remove, not ${input.action}.`);
      const tab = manager.getTab(input.tab);
      if (input.action === "list") return listRules(tab);
      if (input.action === "clear") return `Removed ${await clearRules(tab)} rules from ${tab.id}.`;
      if (input.action === "remove") {
        if (input.rule_id === undefined) throw new ToolError("remove needs rule_id.");
        const removed = await removeRule(tab, input.rule_id);
        return `Removed rule #${removed.id} (${removed.summary}) after ${removed.hits} hits.`;
      }
      if (!input.url) throw new ToolError("add needs url.");
      if (!input.mode)
        throw new ToolError(
          "add needs mode.",
          "Pass block, modify, mock or patch_response; mock_* fields go with mock, replacements with patch_response, the other fields with modify.",
        );
      for (const field of RULE_FIELDS) {
        const modes: readonly RuleMode[] = RULE_FIELD_MODES[field];
        if (input[field] !== undefined && !modes.includes(input.mode))
          throw new ToolError(
            `${field} does not apply to mode ${input.mode}; it belongs to ${modes.join(" or ")}.`,
            "Change the mode, or leave the field out.",
          );
      }
      const rule = await addRule(tab, {
        url: input.url,
        regex: input.regex ?? false,
        mode: input.mode,
        setHeaders: input.set_headers,
        removeHeaders: input.remove_headers,
        method: input.method,
        postData: input.post_data,
        rewriteUrl: input.rewrite_url,
        mockStatus: input.mock_status,
        mockHeaders: input.mock_headers,
        mockBody: input.mock_body,
        mockContentType: input.mock_content_type,
        replacements: input.replacements,
      });
      return `Added rule #${rule.id} on ${tab.id}: ${rule.summary}. It applies to requests made from now on.`;
    },
  });

  defineTool(server, deps, {
    name: "request",
    title: "Send HTTP request with the browser session",
    description: [
      "Send an HTTP request that carries the browser's cookies, and return the status, content type and size, the location, set-cookie, content-disposition, retry-after and x-ratelimit-remaining response headers when present, and the body. Use it to call a site's API directly instead of scraping the rendered page: fetch JSON with the user's session, page through results by changing query parameters, download a file, or replay a captured request with changes (from_request takes an id from network and copies its method, URL, headers and body; any field given here overrides the copy). The endpoint usually comes from network or the site's notes. For many dependent calls with logic between them, context.request in run_script does the same in one script.",
      "via browser (default) sends from the browser's network stack outside any page: no CORS limits, good for downloads and cross-site calls. via page runs fetch() inside the tab, so the request has the page's origin, referrer and same-site context, which some APIs require.",
      "Replaying a request that changes data (POST, PUT, DELETE) repeats its effect. Bodies above max_chars and binary responses are saved to a file.",
    ].join("\n"),
    input: requestInput,
    handler: (input) => sendRequest(deps, input),
  });
}
