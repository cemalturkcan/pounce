import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TIMED_OUT, withDeadline } from "../async.ts";
import type { Tab } from "../browser.ts";
import { normalizeUrl } from "../collect.ts";
import { ToolError } from "../errors.ts";
import { isTextualMime } from "../mime.ts";
import { addRule, buildHar, clearRules, headersOf, listRules, removeRule, responseBody } from "../network.ts";
import { untrusted } from "../output.ts";
import { clipToFile, defineTool, SENSITIVE_HEADERS, tabParam, timeoutParam, type ToolDeps, type ToolInput } from "./common.ts";

const requestInput = {
  tab: tabParam.optional().describe("Tab to take from_request from, and the page to run in for via page."),
  from_request: z.number().int().optional().describe("Id of a captured request (from network_requests) to replay."),
  url: z.string().optional().describe("Request URL. Required unless from_request is given."),
  method: z.string().optional().describe("HTTP method. Default GET, or the replayed request's method."),
  headers: z.record(z.string(), z.string()).optional().describe("Headers to set or override."),
  remove_headers: z.array(z.string()).optional().describe("Header names to drop from a replayed request."),
  query: z.record(z.string(), z.string()).optional().describe("Query parameters to set or override on the URL."),
  body: z.string().optional().describe("Request body. For JSON, pass the JSON text and a content-type header."),
  via: z.enum(["browser", "page"]).optional().describe("Where the request is sent from. Default browser."),
  save: z.boolean().optional().describe("Always save the response body to a file and return its path. Default false."),
  timeout_ms: timeoutParam(30_000),
  max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the body in the result. Default 8000."),
};

async function sendRequest({ manager, store }: ToolDeps, input: ToolInput<typeof requestInput>) {
  const tab = input.tab ? manager.getTab(input.tab) : undefined;
  const source = input.from_request === undefined ? undefined : tab?.network.find((entry) => entry.id === input.from_request);
  if (input.from_request !== undefined && !source) {
    throw new ToolError(`Request ${input.from_request} is not in the buffer${tab ? ` of ${tab.id}` : ""}.`, "Pass the tab it was captured in, and list network_requests for current ids.");
  }
  const rawUrl = input.url ?? source?.url;
  if (!rawUrl) throw new ToolError("Give url or from_request.");
  const url = new URL(normalizeUrl(rawUrl));
  for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);

  const headers: Record<string, string> = {};
  if (source) {
    const dropped = new Set(["host", "content-length", "cookie", "connection", ...(input.remove_headers ?? []).map((name) => name.toLowerCase())]);
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
    const fetched = await withDeadline(tab.page.evaluate(
      async ([target, init]) => {
        const response = await fetch(target, init);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
        return { status: response.status, headers: Object.fromEntries(response.headers), base64: btoa(binary) };
      },
      [url.href, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, credentials: "include" as const }] as const,
    ), timeout);
    if (fetched === TIMED_OUT) throw new ToolError(`The request did not finish within ${timeout} ms in the page.`, "The page may be busy, or the server slow; raise timeout_ms or use via browser.");
    const result = fetched;
    status = result.status;
    responseHeaders = result.headers;
    payload = Buffer.from(result.base64, "base64");
  } else {
    const context = await manager.ensureContext();
    const response = await context.request.fetch(url.href, { method, headers, data: body, timeout, failOnStatusCode: false });
    status = response.status();
    responseHeaders = response.headers();
    payload = await response.body();
  }

  const contentType = responseHeaders["content-type"] ?? "";
  const isText = isTextualMime(contentType) || payload.length === 0;
  const lines = [`${method} ${url.href} → HTTP ${status}`, `content-type: ${contentType || "-"} · ${payload.length} bytes`];
  for (const name of ["location", "set-cookie", "content-disposition", "retry-after", "x-ratelimit-remaining"]) {
    if (responseHeaders[name]) lines.push(`${name}: ${name === "set-cookie" ? "<masked>" : responseHeaders[name]}`);
  }
  if (!isText || input.save) {
    const extension = /json/i.test(contentType) ? "json" : /html/i.test(contentType) ? "html" : /pdf/i.test(contentType) ? "pdf" : isText ? "txt" : "bin";
    const file = await store.write("requests", store.uniqueName(url.hostname + url.pathname, extension), isText ? payload.toString("utf8") : payload);
    lines.push(`Body saved to ${file}`);
    if (!isText) return lines.join("\n");
  }
  lines.push("", await clipToFile(store, "requests", url.hostname + url.pathname, payload.toString("utf8"), input.max_chars ?? 8000));
  return untrusted(url.href, lines.join("\n"));
}

export function registerNetworkTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "network_requests",
    title: "Network requests",
    description: [
      "List a tab's recent network responses and failures (id, method, status, resource type, URL), newest last, or with id return one request in full: request headers and body, response headers and response body. Use it to find the API call behind a page, a table, a search or an infinite list and read its JSON directly, to see which requests failed (failed_only), or to debug a local app. Credential headers are masked. Streaming responses (text/event-stream) and bodies that do not finish within a few seconds are reported as unavailable instead of waited for.",
      "Once you know the endpoint, request calls it again with other parameters or pages and from_request replays a captured one; network_export writes the whole capture to a HAR file; intercept changes requests and responses.",
    ].join("\n"),
    input: {
      tab: tabParam,
      id: z.number().int().optional().describe("Return request headers and body, response headers and response body of this request id instead of the list."),
      pattern: z.string().optional().describe("Keep only requests whose URL contains this, case-insensitive."),
      failed_only: z.boolean().optional().describe("Keep only failed requests and HTTP status 400 or higher. Default false."),
      types: z.array(z.string()).optional().describe("Keep only these resource types, for example [\"xhr\", \"fetch\", \"document\"]."),
      limit: z.number().int().min(1).max(400).optional().describe("Maximum entries to list. Default 40."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the request body and for the response body. Default 8000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.id !== undefined) {
        const entry = tab.network.find((candidate) => candidate.id === input.id);
        if (!entry) throw new ToolError(`Request ${input.id} is no longer in the buffer of ${tab.id}.`, "List requests again; only the most recent ones are kept.");
        const budget = input.max_chars ?? 8000;
        const masked = (headers: Record<string, string>) =>
          Object.entries(headers).map(([name, value]) => `${name}: ${SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<masked>" : value}`);
        const lines = [`${entry.method} ${entry.status ?? entry.failure} ${entry.url}`, "", "Request headers:", ...masked(await headersOf(entry.request))];
        const postData = entry.request.postData();
        if (postData) lines.push("", "Request body:", await clipToFile(store, "network", `${tab.id}-request-${entry.id}-body`, postData, budget));
        if (entry.response) {
          lines.push("", "Response headers:", ...masked(await headersOf(entry.response)));
          const { body, note } = await responseBody(entry);
          lines.push("", "Response body:", body ? await clipToFile(store, "network", `${tab.id}-request-${entry.id}`, body.toString("utf8"), budget) : `<${note}>`);
        }
        return untrusted(tab.page.url(), lines.join("\n"));
      }

      const pattern = input.pattern?.toLowerCase();
      const entries = tab.network
        .filter((entry) => !pattern || entry.url.toLowerCase().includes(pattern))
        .filter((entry) => !input.failed_only || entry.failure !== undefined || (entry.status ?? 0) >= 400)
        .filter((entry) => !input.types || input.types.includes(entry.resourceType))
        .slice(-(input.limit ?? 40));
      if (entries.length === 0) return `No matching network entries for ${tab.page.url()}.`;
      return untrusted(
        tab.page.url(),
        entries.map((entry) => `#${entry.id} ${entry.method} ${entry.status ?? `FAILED ${entry.failure}`} ${entry.resourceType} ${entry.url.slice(0, 300)}`).join("\n"),
      );
    },
  });

  defineTool(server, deps, {
    name: "network_export",
    title: "Export network as HAR",
    description:
      "Write the captured network traffic of a tab to a HAR 1.2 file (request and response headers, post data, timings, and response bodies up to 2 MB each) and return its path. Use it to keep a full record of a session's traffic, to search all of it with file tools, or to open it in DevTools or another HAR tool; to look at a few requests, network_requests is enough. It is a raw export: cookies, tokens and typed passwords appear as sent, unmasked, and the file is kept until you delete it. Streaming responses and bodies that do not finish within a few seconds are left out with a comment. Capture covers the most recent 1000 requests since the tab was opened.",
    input: {
      tab: tabParam,
      pattern: z.string().optional().describe("Export only requests whose URL contains this, case-insensitive."),
      types: z.array(z.string()).optional().describe("Export only these resource types, for example [\"xhr\", \"fetch\"]."),
      include_bodies: z.boolean().optional().describe("Include response bodies. Default true."),
      label: z.string().optional().describe("Short name used in the file name."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const pattern = input.pattern?.toLowerCase();
      const entries = tab.network
        .filter((entry) => !pattern || entry.url.toLowerCase().includes(pattern))
        .filter((entry) => !input.types || input.types.includes(entry.resourceType));
      if (entries.length === 0) return `No matching network entries captured for ${tab.id}.`;
      const har = await buildHar(entries, input.include_bodies ?? true, tab.page.url());
      const file = await store.write("har", store.uniqueName(input.label ?? `${tab.id}-network`, "har"), JSON.stringify(har, null, 1), { raw: true });
      return `Exported ${entries.length} requests to ${file}`;
    },
  });

  defineTool(server, deps, {
    name: "intercept",
    title: "Intercept requests",
    description: [
      "Add, list or remove rules that intercept the network requests of a tab. A rule matches request URLs by substring (or regex) and applies one mode: block aborts the request; modify changes the outgoing request (headers, method, body, or target URL) and lets it continue; mock answers without contacting the server; patch_response fetches the real response and replaces text in its body. Use it to see how a page handles a failing or different API response, to block trackers or heavy resources, to send requests to a local server, or to add a header.",
      "patch_response only rewrites textual bodies (HTML, JSON, JavaScript, XML, SVG, plain text); images and other binary responses pass through unchanged. Rules stay active until removed or the tab closes; list shows each rule's hits and failures. If a rule fails on a request (for example a rewrite_url with another protocol, or an unreachable upstream), the request continues unmodified or is aborted, and the failure is shown in list. When several rules match one request, only the most recently added one applies. Rule numbers are never reused within a tab. The Cookie header cannot be changed by a rule; use cookies to add or change cookies instead. To send a request yourself use request; for logic beyond these modes, call page.route() from run_script.",
    ].join("\n"),
    input: {
      tab: tabParam,
      action: z.enum(["add", "list", "remove", "clear"]).describe("add creates a rule; list shows rules and hit counts; remove deletes rule_id; clear deletes all rules of the tab."),
      url: z.string().optional().describe("For add: match requests whose URL contains this text."),
      regex: z.boolean().optional().describe("Treat url as a case-insensitive regular expression. Default false."),
      mode: z.enum(["block", "modify", "mock", "patch_response"]).optional().describe("For add: what the rule does. Default modify."),
      set_headers: z.record(z.string(), z.string()).optional().describe("modify, patch_response: request headers to set or override."),
      remove_headers: z.array(z.string()).optional().describe("modify, patch_response: request header names to remove."),
      method: z.string().optional().describe("modify: replace the HTTP method."),
      post_data: z.string().optional().describe("modify: replace the request body."),
      rewrite_url: z.string().optional().describe("modify: send the request to this http or https URL instead; it must use the same protocol as the request, otherwise the request continues unchanged and the rule records a failure."),
      mock_status: z.number().int().min(100).max(599).optional().describe("mock: HTTP status. Default 200."),
      mock_headers: z.record(z.string(), z.string()).optional().describe("mock: response headers."),
      mock_content_type: z.string().optional().describe("mock: Content-Type. Default application/json."),
      mock_body: z.string().optional().describe("mock: response body."),
      replacements: z
        .array(z.object({ find: z.string().min(1), replace: z.string() }))
        .optional()
        .describe("patch_response: literal text replacements applied to the response body in order."),
      rule_id: z.number().int().optional().describe("For remove: the rule number from list."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.action === "list") return listRules(tab);
      if (input.action === "clear") return `Removed ${await clearRules(tab)} rules from ${tab.id}.`;
      if (input.action === "remove") {
        if (input.rule_id === undefined) throw new ToolError("remove needs rule_id.");
        const removed = await removeRule(tab, input.rule_id);
        return `Removed rule #${removed.id} (${removed.summary}) after ${removed.hits} hits.`;
      }
      if (!input.url) throw new ToolError("add needs url.");
      const rule = await addRule(tab, {
        url: input.url,
        regex: input.regex ?? false,
        mode: input.mode ?? "modify",
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
      "Send an HTTP request that carries the browser's cookies, and return the status, content type and size, the location, set-cookie (masked), content-disposition, retry-after and x-ratelimit-remaining response headers when present, and the body. Use it to call a site's API directly instead of scraping the rendered page: fetch JSON with the user's session, page through results by changing query parameters, download a file, or replay a captured request with changes (from_request takes an id from network_requests and copies its method, URL, headers and body; any field given here overrides the copy). The endpoint usually comes from network_requests or site notes. For many dependent calls with logic between them, context.request in run_script does the same in one script.",
      "via browser (default) sends from the browser's network stack outside any page: no CORS limits, good for downloads and cross-site calls. via page runs fetch() inside the tab, so the request has the page's origin, referrer and same-site context, which some APIs require.",
      "Replaying a request that changes data (POST, PUT, DELETE) repeats its effect. Bodies above max_chars and binary responses are saved to a file.",
    ].join("\n"),
    input: requestInput,
    handler: (input) => sendRequest(deps, input),
  });
}
