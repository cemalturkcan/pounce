import type { Route } from "playwright-core";
import type { InterceptRule, NetworkEntry, Tab } from "./browser.ts";
import { ToolError } from "./errors.ts";

const HAR_BODY_LIMIT = 2 * 1024 * 1024;
const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|graphql|ld\+json)|image\/svg)/i;

export type InterceptSpec = {
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

function headerList(headers: Record<string, string>) {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function queryList(url: string) {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

async function harEntry(entry: NetworkEntry, includeBodies: boolean) {
  const { request, response } = entry;
  const requestHeaders = await request.allHeaders().catch(() => ({}) as Record<string, string>);
  const responseHeaders = response ? await response.allHeaders().catch(() => ({}) as Record<string, string>) : {};
  const mimeType = responseHeaders["content-type"] ?? "";
  const postData = request.postData();
  const timing = request.timing();
  const wait = timing.responseStart >= 0 && timing.requestStart >= 0 ? timing.responseStart - timing.requestStart : -1;
  const content: Record<string, unknown> = { size: -1, mimeType };

  if (includeBodies && response) {
    const body = entry.body ?? (await response.body().catch(() => undefined));
    if (body && body.length <= HAR_BODY_LIMIT) {
      content.size = body.length;
      if (TEXT_MIME.test(mimeType)) {
        content.text = body.toString("utf8");
      } else {
        content.text = body.toString("base64");
        content.encoding = "base64";
      }
    } else if (body) {
      content.size = body.length;
      content.comment = "body omitted: larger than 2 MB";
    } else {
      content.comment = "body no longer available from the browser";
    }
  }

  return {
    startedDateTime: entry.time,
    time: timing.responseEnd >= 0 ? timing.responseEnd : -1,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion: "HTTP/1.1",
      headers: headerList(requestHeaders),
      queryString: queryList(entry.url),
      cookies: [],
      headersSize: -1,
      bodySize: postData ? Buffer.byteLength(postData) : 0,
      ...(postData ? { postData: { mimeType: requestHeaders["content-type"] ?? "", text: postData } } : {}),
    },
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
    ...(entry.failure ? { _failure: entry.failure } : {}),
  };
}

export async function buildHar(entries: NetworkEntry[], includeBodies: boolean, pageUrl: string) {
  const harEntries = [];
  for (const entry of entries) harEntries.push(await harEntry(entry, includeBodies));
  return {
    log: {
      version: "1.2",
      creator: { name: "web-agent-mcp", version: "0.2.0" },
      pages: [{ startedDateTime: entries[0]?.time ?? new Date().toISOString(), id: "page_1", title: pageUrl, pageTimings: {} }],
      entries: harEntries.map((entry) => ({ ...entry, pageref: "page_1" })),
    },
  };
}

function buildMatcher(spec: InterceptSpec) {
  if (spec.regex) {
    const expression = new RegExp(spec.url, "i");
    return (url: URL) => expression.test(url.href);
  }
  const needle = spec.url.toLowerCase();
  return (url: URL) => url.href.toLowerCase().includes(needle);
}

function summarize(spec: InterceptSpec) {
  const where = `${spec.regex ? "regex" : "contains"} ${JSON.stringify(spec.url)}`;
  if (spec.mode === "block") return `block requests where URL ${where}`;
  if (spec.mode === "mock") return `answer with a mock ${spec.mockStatus ?? 200} where URL ${where}`;
  if (spec.mode === "patch_response") return `patch response bodies (${spec.replacements?.length ?? 0} replacements) where URL ${where}`;
  const changes = [
    spec.setHeaders ? `set headers ${Object.keys(spec.setHeaders).join(", ")}` : "",
    spec.removeHeaders?.length ? `remove headers ${spec.removeHeaders.join(", ")}` : "",
    spec.method ? `method ${spec.method}` : "",
    spec.postData !== undefined ? "replace body" : "",
    spec.rewriteUrl ? `send to ${spec.rewriteUrl}` : "",
  ].filter(Boolean);
  return `modify requests (${changes.join("; ") || "no changes"}) where URL ${where}`;
}

function buildHandler(spec: InterceptSpec, rule: { hits: number }) {
  return async (route: Route) => {
    rule.hits += 1;
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

    const headers = { ...request.headers(), ...(spec.setHeaders ?? {}) };
    for (const name of spec.removeHeaders ?? []) delete headers[name.toLowerCase()];
    const overrides = { headers, method: spec.method, postData: spec.postData, url: spec.rewriteUrl };

    if (spec.mode === "modify") {
      await route.continue(overrides);
      return;
    }

    const response = await route.fetch(overrides);
    let body = await response.text();
    for (const replacement of spec.replacements ?? []) body = body.split(replacement.find).join(replacement.replace);
    await route.fulfill({ response, body });
  };
}

export async function addRule(tab: Tab, spec: InterceptSpec) {
  if (spec.mode === "patch_response" && !spec.replacements?.length) {
    throw new ToolError("patch_response needs at least one entry in replacements.");
  }
  const id = (tab.rules.at(-1)?.id ?? 0) + 1;
  const matcher = buildMatcher(spec);
  const rule: InterceptRule = { id, summary: summarize(spec), hits: 0, matcher, handler: async () => undefined };
  rule.handler = buildHandler(spec, rule);
  await tab.page.route(matcher, rule.handler);
  tab.rules.push(rule);
  return rule;
}

export async function removeRule(tab: Tab, id: number) {
  const index = tab.rules.findIndex((rule) => rule.id === id);
  const rule = tab.rules[index];
  if (!rule) {
    throw new ToolError(`Tab ${tab.id} has no intercept rule ${id}.`, "Use intercept with action list to see the active rules.");
  }
  await tab.page.unroute(rule.matcher, rule.handler);
  tab.rules.splice(index, 1);
  return rule;
}

export async function clearRules(tab: Tab) {
  const count = tab.rules.length;
  for (const rule of [...tab.rules]) await removeRule(tab, rule.id);
  return count;
}

export function listRules(tab: Tab) {
  if (tab.rules.length === 0) return `Tab ${tab.id} has no intercept rules.`;
  return tab.rules.map((rule) => `#${rule.id} ${rule.summary} — ${rule.hits} hits`).join("\n");
}
