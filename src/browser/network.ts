import type { Route } from "playwright-core";
import { inSequence, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { errorFrom, messageOf, ToolError } from "../shared/errors.ts";
import { isStreamingMime, isTextualMime } from "../shared/mime.ts";
import { SERVER_VERSION } from "../config/version.ts";
import type { InterceptRule, NetworkEntry, Tab } from "./tab.ts";
import { localClock } from "../shared/output.ts";

const HAR_BODY_LIMIT = 2 * 1024 * 1024;
const BODY_WAIT_MS = 3000;
const HEADERS_WAIT_MS = 3000;

type BodyResult = { body?: Buffer; note?: string };

export async function responseBody(entry: NetworkEntry): Promise<BodyResult> {
  if (entry.body) return { body: entry.body };
  const { response } = entry;
  if (!response) return { note: "no response" };
  if (isStreamingMime(response.headers()["content-type"]))
    return { note: "streaming response (text/event-stream); the body is not captured" };
  const body = await withDeadline(response.body(), BODY_WAIT_MS).catch((cause: unknown) =>
    errorFrom(cause),
  );
  if (body === TIMED_OUT)
    return {
      note: `body not available within ${BODY_WAIT_MS / 1000} s; the response may still be streaming`,
    };
  if (body instanceof Error) return { note: `body unavailable: ${body.message.split("\n")[0]}` };
  return { body };
}

export async function headersOf(source: {
  allHeaders(): Promise<Record<string, string>>;
  headers(): Record<string, string>;
}): Promise<Record<string, string>> {
  const headers = await withDeadline(source.allHeaders(), HEADERS_WAIT_MS).catch(
    (): typeof TIMED_OUT => TIMED_OUT,
  );
  return headers === TIMED_OUT ? source.headers() : headers;
}

type InterceptSpec = {
  url: string;
  regex: boolean;
  mode: "block" | "modify" | "mock" | "patch_response";
  setHeaders?: Record<string, string>;
  removeHeaders?: string[];
  method?: string;
  postData?: string;
  rewriteUrl?: string;
  mockStatus?: number;
  mockHeaders?: Record<string, string>;
  mockBody?: string;
  mockContentType?: string;
  replacements?: { find: string; replace: string }[];
};

type HarPair = { name: string; value: string };

type HarContent = {
  size: number;
  mimeType: string;
  text?: string;
  encoding?: "base64";
  comment?: string;
};

type HarRequest = {
  method: string;
  url: string;
  httpVersion: string;
  headers: HarPair[];
  queryString: HarPair[];
  cookies: never[];
  headersSize: number;
  bodySize: number;
  postData?: { mimeType: string; text: string };
};

type HarEntry = {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarPair[];
    cookies: never[];
    content: HarContent;
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _resourceType: string;
  _failure?: string;
  pageref?: string;
};

function headerList(headers: Record<string, string>): HarPair[] {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryList(url: string): HarPair[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

async function harEntry(entry: NetworkEntry, includeBodies: boolean, pageref: string) {
  const { request, response } = entry;
  const requestHeaders = await headersOf(request);
  const responseHeaders = response ? await headersOf(response) : {};
  const mimeType = responseHeaders["content-type"] ?? "";
  const postData = request.postData();
  const timing = request.timing();
  const wait =
    timing.responseStart >= 0 && timing.requestStart >= 0
      ? timing.responseStart - timing.requestStart
      : -1;
  const content: HarContent = { size: -1, mimeType };

  if (includeBodies && response) {
    const { body, note } = await responseBody(entry);
    if (body && body.length <= HAR_BODY_LIMIT) {
      content.size = body.length;
      if (isTextualMime(mimeType)) {
        content.text = body.toString("utf8");
      } else {
        content.text = body.toString("base64");
        content.encoding = "base64";
      }
    } else if (body) {
      content.size = body.length;
      content.comment = "body omitted: larger than 2 MB";
    } else {
      content.comment = note ?? "body no longer available from the browser";
    }
  }

  const harRequest: HarRequest = {
    method: entry.method,
    url: entry.url,
    httpVersion: "HTTP/1.1",
    headers: headerList(requestHeaders),
    queryString: queryList(entry.url),
    cookies: [],
    headersSize: -1,
    bodySize: postData ? Buffer.byteLength(postData) : 0,
  };
  if (postData)
    harRequest.postData = { mimeType: requestHeaders["content-type"] ?? "", text: postData };

  const har: HarEntry = {
    startedDateTime: entry.time,
    time: timing.responseEnd >= 0 ? timing.responseEnd : -1,
    request: harRequest,
    response: {
      status: entry.status ?? 0,
      statusText: response?.statusText() ?? entry.failure ?? "",
      httpVersion: "HTTP/1.1",
      headers: headerList(responseHeaders),
      cookies: [],
      content,
      redirectURL: responseHeaders.location ?? "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait, receive: 0 },
    _resourceType: entry.resourceType,
  };
  if (entry.failure) Object.assign(har, { _failure: entry.failure });
  har.pageref = pageref;
  return har;
}

export async function buildHar(entries: NetworkEntry[], includeBodies: boolean, pageUrl: string) {
  const harEntries = await inSequence(entries, (entry) => harEntry(entry, includeBodies, "page_1"));
  return {
    log: {
      version: "1.2",
      creator: { name: "web-agent-mcp", version: SERVER_VERSION },
      pages: [
        {
          startedDateTime: entries[0]?.time ?? new Date().toISOString(),
          id: "page_1",
          title: pageUrl,
          pageTimings: {},
        },
      ],
      entries: harEntries,
    },
  };
}

const isGlob = (spec: InterceptSpec) => !spec.regex && spec.url.includes("*");

export function urlPattern(text: string) {
  const pieces = text.toLowerCase().split(/\*+/);
  return {
    test(url: string) {
      const lower = url.toLowerCase();
      let from = 0;
      for (const piece of pieces) {
        const at = lower.indexOf(piece, from);
        if (at < 0) return false;
        from = at + piece.length;
      }
      return true;
    },
  };
}

function urlExpression(spec: InterceptSpec) {
  if (!spec.regex) return urlPattern(spec.url);
  try {
    return new RegExp(spec.url, "i");
  } catch (cause) {
    throw new ToolError(
      `url ${JSON.stringify(spec.url)} is not a valid regular expression (${messageOf(cause).replace(/^Invalid regular expression: /, "")}).`,
      "Escape characters such as * . ? ( with a backslash, or leave regex out to match by text where * stands for any characters.",
    );
  }
}

function buildMatcher(spec: InterceptSpec) {
  const expression = urlExpression(spec);
  return (url: URL) => expression.test(url.href);
}

function summarize(spec: InterceptSpec) {
  const how = spec.regex ? "regex" : isGlob(spec) ? "matches" : "contains";
  const where = `${how} ${JSON.stringify(spec.url)}`;
  if (spec.mode === "block") return `block requests where URL ${where}`;
  if (spec.mode === "mock")
    return `answer with a mock ${spec.mockStatus ?? 200} where URL ${where}`;
  if (spec.mode === "patch_response")
    return `patch response bodies (${spec.replacements?.length ?? 0} replacements) where URL ${where}`;
  const changes = [
    spec.setHeaders ? `set headers ${Object.keys(spec.setHeaders).join(", ")}` : "",
    spec.removeHeaders?.length ? `remove headers ${spec.removeHeaders.join(", ")}` : "",
    spec.method ? `method ${spec.method}` : "",
    spec.postData !== undefined ? "replace body" : "",
    spec.rewriteUrl ? `send to ${spec.rewriteUrl}` : "",
  ].filter(Boolean);
  return `modify requests (${changes.join("; ") || "no changes"}) where URL ${where}`;
}

async function fallBack(route: Route) {
  try {
    await route.continue();
  } catch {
    await route.abort("failed").catch(() => undefined);
  }
}

function buildHandler(spec: InterceptSpec, rule: InterceptRule) {
  const apply = buildAction(spec);
  return async (route: Route) => {
    rule.hits += 1;
    try {
      await apply(route);
    } catch (cause) {
      rule.errors += 1;
      rule.lastError = `${localClock(Date.now())} ${route.request().url().slice(0, 200)}: ${messageOf(cause).split("\n")[0]}`;
      await fallBack(route);
    }
  };
}

function buildAction(spec: InterceptSpec) {
  return async (route: Route) => {
    const request = route.request();

    if (spec.mode === "block") {
      await route.abort("blockedbyclient");
      return;
    }
    if (spec.mode === "mock") {
      await route.fulfill({
        status: spec.mockStatus ?? 200,
        headers: spec.mockHeaders,
        contentType: spec.mockContentType ?? "application/json",
        body: spec.mockBody ?? "",
      });
      return;
    }

    const headers = { ...request.headers(), ...spec.setHeaders };
    for (const name of spec.removeHeaders ?? []) delete headers[name.toLowerCase()];
    const overrides = {
      headers,
      method: spec.method,
      postData: spec.postData,
      url: spec.rewriteUrl,
    };

    if (spec.rewriteUrl && new URL(spec.rewriteUrl).protocol !== new URL(request.url()).protocol) {
      throw new Error(
        `rewrite_url ${spec.rewriteUrl} has another protocol than ${request.url()}; a rewrite must keep the protocol`,
      );
    }
    if (spec.mode === "modify") {
      await route.continue(overrides);
      return;
    }

    const response = await route.fetch(overrides);
    if (!isTextualMime(response.headers()["content-type"])) {
      await route.fulfill({ response });
      return;
    }
    let body = await response.text();
    for (const replacement of spec.replacements ?? [])
      body = body.split(replacement.find).join(replacement.replace);
    await route.fulfill({ response, body });
  };
}

export async function addRule(tab: Tab, spec: InterceptSpec) {
  if (spec.rewriteUrl !== undefined && !/^https?:\/\//i.test(spec.rewriteUrl)) {
    throw new ToolError(`rewrite_url must be an http or https URL: ${spec.rewriteUrl}`);
  }
  if (spec.mode === "patch_response" && !spec.replacements?.length) {
    throw new ToolError("patch_response needs at least one entry in replacements.");
  }
  const matcher = buildMatcher(spec);
  tab.ruleCounter += 1;
  const id = tab.ruleCounter;
  const rule: InterceptRule = {
    id,
    summary: summarize(spec),
    hits: 0,
    errors: 0,
    matcher,
    handler: async () => undefined,
  };
  rule.handler = buildHandler(spec, rule);
  await tab.page.route(matcher, rule.handler);
  tab.rules.push(rule);
  return rule;
}

export async function removeRule(tab: Tab, id: number) {
  const index = tab.rules.findIndex((rule) => rule.id === id);
  const rule = tab.rules[index];
  if (!rule) {
    throw new ToolError(
      `Tab ${tab.id} has no intercept rule ${id}.`,
      "Use intercept with action list to see the active rules.",
    );
  }
  await tab.page.unroute(rule.matcher, rule.handler);
  tab.rules.splice(index, 1);
  return rule;
}

export async function clearRules(tab: Tab) {
  const count = tab.rules.length;
  await inSequence(tab.rules, (rule) => removeRule(tab, rule.id));
  return count;
}

export function listRules(tab: Tab) {
  if (tab.rules.length === 0) return `Tab ${tab.id} has no intercept rules.`;
  const lines = tab.rules.map((rule) => {
    const failures = rule.errors
      ? `, ${rule.errors} failed (the request was let through unchanged or aborted); last: ${rule.lastError}`
      : "";
    return `#${rule.id} ${rule.summary} — ${rule.hits} hits${failures}`;
  });
  if (tab.rules.length > 1)
    lines.push("When several rules match one request, only the most recently added one applies.");
  return lines.join("\n");
}
