import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inSequence } from "../shared/async.ts";
import { DEFAULT_MAX_WAIT_MS, DEFAULT_QUIET_MS } from "../page/settle.ts";
import {
  collectIndexFrame,
  collectPages,
  collectSummary,
  renderCollectIndex,
  saveTabs,
} from "../page/collect.ts";
import { ToolError } from "../shared/errors.ts";
import { localDay, shownUrl, untrusted } from "../shared/output.ts";
import {
  exportIndexedDb,
  listIndexedDb,
  readIndexedDbStore,
  readWebStorage,
  splitStoreKey,
  storageOrigin,
} from "../browser/storage.ts";
import {
  clipToFile,
  defineTool,
  tabOwnership,
  tabParam,
  type ToolDeps,
  type ToolInput,
  waitUntilParam,
} from "./common.ts";
import { pageBound } from "../page/bound.ts";

export function cookieLifetime(expires: number) {
  return expires > 0 ? `expires ${localDay(expires * 1000)}` : "session";
}

export function cookieDomainMatches(cookieDomain: string, wanted: string) {
  const domain = cookieDomain.toLowerCase();
  const bare = wanted.toLowerCase().replace(/^\./, "");
  return domain === bare || domain === `.${bare}` || domain.endsWith(`.${bare}`);
}

const COOKIE_FIELDS = [
  "domain",
  "value",
  "path",
  "url",
  "expires_in_seconds",
  "http_only",
  "secure",
  "same_site",
  "full_values",
] as const;
const COOKIE_SET_FIELDS = [
  "value",
  "path",
  "url",
  "expires_in_seconds",
  "http_only",
  "secure",
  "same_site",
] as const;

const storageInput = {
  area: z
    .enum(["cookies", "local", "session", "indexeddb"])
    .describe(
      "cookies: the profile's cookie jar, shared by all tabs. local, session, indexeddb: localStorage, sessionStorage or IndexedDB of the origin the tab is on.",
    ),
  action: z
    .enum(["list", "get", "set", "delete", "export"])
    .describe(
      "cookies: list, set, delete or export. local, session, indexeddb: list, get or export.",
    ),
  tab: tabParam
    .optional()
    .describe(
      "Required for local, session and indexeddb. For cookies: list, export and delete cover only the cookies sent to this tab's current URL; set uses that URL by default.",
    ),
  key: z
    .string()
    .optional()
    .describe(
      "For cookies, the cookie name: required for set, a filter for list, export and delete. For get, the storage key, or for indexeddb the database/store name (the store name alone works when it is unique).",
    ),
  domain: z
    .string()
    .optional()
    .describe(
      "Cookies. For list and export: keep cookies whose domain contains this. For delete: cookies of exactly this domain or its subdomains (x.com matches x.com and a.x.com, not netflix.com). For set: the cookie's domain, for example .example.com.",
    ),
  value: z.string().optional().describe("Cookie set: the value."),
  path: z.string().optional().describe("Cookie set: the path. Default /."),
  url: z
    .string()
    .optional()
    .describe("Cookie set: the URL the cookie belongs to, instead of domain and path."),
  expires_in_seconds: z
    .number()
    .int()
    .optional()
    .describe("Cookie set: lifetime from now. Omit for a session cookie."),
  http_only: z.boolean().optional().describe("Cookie set. Default false."),
  secure: z.boolean().optional().describe("Cookie set. Default true for https URLs."),
  same_site: z.enum(["Strict", "Lax", "None"]).optional().describe("Cookie set."),
  full_values: z
    .boolean()
    .optional()
    .describe("Cookie list: whole values instead of the first 60 characters. Default false."),
  max_chars: z
    .number()
    .int()
    .min(200)
    .max(200_000)
    .optional()
    .describe("For get: character budget; the full value is saved to a file. Default 8000."),
};

type StorageInput = ToolInput<typeof storageInput>;

function firstGiven(input: StorageInput, fields: readonly (keyof StorageInput)[]) {
  return fields.find((field) => input[field] !== undefined);
}

function storageRuleError(input: StorageInput) {
  if (input.area !== "cookies") {
    const cookieField = firstGiven(input, COOKIE_FIELDS);
    if (cookieField) return `${cookieField} only applies to area cookies.`;
    if (input.action === "set" || input.action === "delete")
      return `area ${input.area} is only read here; change it with evaluate, for example localStorage.setItem(key, value).`;
    if (!input.tab) return `area ${input.area} needs tab.`;
    const getField = input.action === "get" ? undefined : firstGiven(input, ["key", "max_chars"]);
    return getField ? `${getField} only applies to get.` : undefined;
  }
  if (input.max_chars !== undefined)
    return "max_chars only applies to get of area local, session or indexeddb.";
  if (input.action === "get")
    return "get is for area local, session and indexeddb; for cookies use list with key.";
  const setField = input.action === "set" ? undefined : firstGiven(input, COOKIE_SET_FIELDS);
  if (setField) return `${setField} only applies to set.`;
  if (input.action !== "list" && input.full_values !== undefined)
    return "full_values only applies to list.";
  return undefined;
}

async function manageCookies({ manager, store }: ToolDeps, input: StorageInput) {
  const context = await manager.ensureContext();
  const tab = input.tab ? manager.getTab(input.tab) : undefined;

  if (input.action === "set") {
    if (!input.key || input.value === undefined) throw new ToolError("set needs key and value.");
    const url = input.domain ? undefined : (input.url ?? tab?.page.url());
    if (!input.domain && !url)
      throw new ToolError(
        "set needs domain, url, or tab to know which site the cookie belongs to.",
      );
    await context.addCookies([
      {
        name: input.key,
        value: input.value,
        ...(input.domain ? { domain: input.domain, path: input.path ?? "/" } : { url }),
        expires:
          input.expires_in_seconds === undefined
            ? undefined
            : Math.floor(Date.now() / 1000) + input.expires_in_seconds,
        httpOnly: input.http_only,
        secure: input.secure ?? (input.domain ? undefined : url?.startsWith("https:")),
        sameSite: input.same_site,
      },
    ]);
    return `Set cookie ${input.key} for ${input.domain ?? url}.`;
  }

  if (input.action === "delete" && !tab && !input.domain)
    throw new ToolError(
      "delete needs tab or domain, so it only removes cookies of one site; key narrows it to one cookie name.",
      "To remove a cookie name on several sites, list it with key to see its domains and delete it per domain.",
    );
  const domain = input.domain?.toLowerCase();
  const domainMatches =
    input.action === "delete"
      ? cookieDomainMatches
      : (cookieDomain: string, wanted: string) => cookieDomain.toLowerCase().includes(wanted);
  const cookies = (await context.cookies(tab ? [tab.page.url()] : undefined))
    .filter((cookie) => !domain || domainMatches(cookie.domain, domain))
    .filter((cookie) => !input.key || cookie.name === input.key);

  if (input.action === "delete") {
    await inSequence(cookies, (cookie) =>
      context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path }),
    );
    return `Deleted ${cookies.length} cookies.`;
  }
  if (cookies.length === 0) return "No matching cookies.";
  if (input.action === "export") {
    const file = await store.write(
      "cookies",
      store.uniqueName(input.domain ?? tab?.id ?? "cookies", "json"),
      JSON.stringify(cookies, null, 2),
      { raw: true },
    );
    return `Exported ${cookies.length} cookies to ${file}`;
  }
  return cookies
    .map((cookie) => {
      const value =
        input.full_values || cookie.value.length <= 60
          ? cookie.value
          : `${cookie.value.slice(0, 60)}… (${cookie.value.length} chars)`;
      const flags = [
        cookie.httpOnly ? "HttpOnly" : "",
        cookie.secure ? "Secure" : "",
        cookie.sameSite,
        cookieLifetime(cookie.expires),
      ]
        .filter(Boolean)
        .join(" ");
      return `${cookie.domain}${cookie.path} ${cookie.name}=${value} [${flags}]`;
    })
    .join("\n");
}

type WebStorageArea = "local" | "session" | "indexeddb";

async function readStorage(
  { manager, store }: ToolDeps,
  tabId: string,
  area: WebStorageArea,
  input: StorageInput,
  signal: AbortSignal,
) {
  const tab = manager.getTab(tabId);
  const origin = storageOrigin(tab.page);
  const label = `${area}Storage`.replace("indexeddbStorage", "IndexedDB");
  if (area === "indexeddb") {
    if (input.action === "list") {
      const stores = await listIndexedDb(tab.page, signal);
      if (stores.length === 0) return `No IndexedDB databases for ${origin}.`;
      return untrusted(
        tab.page.url(),
        stores
          .map(
            (entry) =>
              `${entry.database}/${entry.store} (${entry.count < 0 ? "?" : entry.count} records)`,
          )
          .join("\n"),
      );
    }
    if (input.action === "export") {
      const { stores, data } = await exportIndexedDb(tab.page, signal);
      const file = await store.write(
        "storage",
        store.uniqueName(`${origin}-indexeddb`, "json"),
        JSON.stringify({ origin, databases: data }, null, 2),
        { raw: true },
      );
      return `Exported ${stores.length} IndexedDB object stores of ${origin} to ${file}`;
    }
    if (!input.key) throw new ToolError("get needs key (database/store).");
    const found = splitStoreKey(input.key, await listIndexedDb(tab.page, signal));
    const { records, truncated } = await readIndexedDbStore(
      tab.page,
      found.database,
      found.store,
      signal,
    );
    const note = truncated
      ? `\n[stopped after ${records.length} records; use export or run_script for the rest]`
      : "";
    const body = (
      await clipToFile(
        store,
        "storage",
        `${origin}-${found.database}-${found.store}`,
        JSON.stringify(records),
        input.max_chars ?? 8000,
      )
    ).text;
    return untrusted(
      tab.page.url(),
      `${found.database}/${found.store}: ${records.length} records\n${body}${note}`,
    );
  }
  const entries = await readWebStorage(tab.page, area);
  const keys = Object.keys(entries);
  if (input.action === "export") {
    const file = await store.write(
      "storage",
      store.uniqueName(`${origin}-${area}`, "json"),
      JSON.stringify({ origin, area, entries }, null, 2),
      { raw: true },
    );
    return `Exported ${keys.length} ${label} entries of ${origin} to ${file}`;
  }
  if (input.action === "list") {
    if (keys.length === 0) return `${label} of ${origin} is empty.`;
    return untrusted(
      tab.page.url(),
      keys.map((key) => `${key} (${entries[key]?.length ?? 0} chars)`).join("\n"),
    );
  }
  if (input.key === undefined) throw new ToolError("get needs key.");
  const value = entries[input.key];
  if (value === undefined)
    throw new ToolError(
      `${label} of ${origin} has no key ${JSON.stringify(input.key)}.`,
      "List the keys with action list.",
    );
  return untrusted(
    tab.page.url(),
    (await clipToFile(store, "storage", `${origin}-${input.key}`, value, input.max_chars ?? 8000))
      .text,
  );
}

function storage(deps: ToolDeps, input: StorageInput, signal: AbortSignal) {
  const broken = storageRuleError(input);
  if (broken) throw new ToolError(broken);
  if (input.area === "cookies" || !input.tab) return manageCookies(deps, input);
  const ended = new AbortController();
  return pageBound(
    readStorage(deps, input.tab, input.area, input, AbortSignal.any([signal, ended.signal])),
    "storage",
  ).finally(() => ended.abort());
}

const SAVE_URL_FIELDS = ["wait_until", "concurrency", "delay_ms", "timeout_ms"] as const;

const saveInput = {
  urls: z
    .array(z.string().min(1))
    .min(1)
    .max(200)
    .optional()
    .describe(
      "URLs to load and save, instead of tabs. https:// is assumed when no scheme is given.",
    ),
  tabs: z
    .array(tabParam)
    .min(1)
    .max(200)
    .optional()
    .describe("Open tabs to save as they are now, instead of urls; they stay open where they are."),
  include: z
    .array(
      z.enum([
        "text",
        "markdown",
        "links",
        "snapshot",
        "screenshot",
        "structured",
        "pdf",
        "mhtml",
        "html",
      ]),
    )
    .optional()
    .describe(
      'What to save per page. markdown keeps headings, lists, links, code blocks and tables. structured saves JSON-LD, meta tags and tables as JSON and adds product name, price and availability to the index when the page declares them. pdf is the printed page (A4, with backgrounds), mhtml a single-file archive with images and styles that opens in Chrome, html the current DOM. Default ["text"].',
    ),
  scope: z
    .enum(["main", "page"])
    .optional()
    .describe(
      "For text and markdown: main keeps the main content area when the page marks one; page keeps everything. Default main, unlike read_page.",
    ),
  full_page: z
    .boolean()
    .optional()
    .describe("For screenshot: the whole scrollable page instead of the viewport. Default true."),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(12)
    .optional()
    .describe(
      "For urls: tabs loading at once. Pages on the same site load one after another and pages on different sites in parallel up to this number. Default 6.",
    ),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe(
      "For urls: milliseconds between starting pages on the same site, on top of waiting for the previous one to finish, to pace a site that limits request rates; pages on other sites are not held back. Default 0.",
    ),
  wait_until: waitUntilParam.describe(
    "For urls: navigation milestone to wait for. Default domcontentloaded; load also waits for images and subframes.",
  ),
  settle_ms: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .optional()
    .describe(
      "A page is saved once its main content has stopped changing for this long and no loading spinner or skeleton is visible, so pages that render with JavaScript are captured complete. Default 800.",
    ),
  max_wait_ms: z
    .number()
    .int()
    .min(0)
    .max(60_000)
    .optional()
    .describe(
      "Longest wait for content to stop changing (capped at timeout_ms); a page still changing then is saved as it is and flagged in the index. Default 8000.",
    ),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .optional()
    .describe("For urls: per-page limit for loading, and separately for saving. Default 30000."),
  preview_chars: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .optional()
    .describe("Characters of text shown per page in the index; 0 for none. Default 160."),
  scroll: z
    .strictObject({
      max_steps: z.number().int().min(1).max(200).describe("Most scroll steps per page."),
      step_px: z
        .number()
        .int()
        .min(50)
        .max(20_000)
        .optional()
        .describe("Pixels per step. Default 90% of the window height."),
      idle_ms: z
        .number()
        .int()
        .min(50)
        .max(10_000)
        .optional()
        .describe("Wait after each step for new content. Default 600."),
    })
    .optional()
    .describe(
      "Scroll each page down before saving it, for lazy-loaded and infinite-scroll pages: stops at the bottom once the page height stops growing, or after max_steps. The index reports the steps taken.",
    ),
  label: z.string().optional().describe("Short name used in the output folder name."),
};

type SaveToolInput = ToolInput<typeof saveInput>;

function saveRuleError(input: SaveToolInput) {
  if ((input.urls === undefined) === (input.tabs === undefined))
    return "Give exactly one of urls or tabs.";
  if (!input.tabs) return undefined;
  const misplaced = SAVE_URL_FIELDS.filter((field) => input[field] !== undefined);
  if (misplaced.length === 0) return undefined;
  const verb = misplaced.length === 1 ? "applies" : "apply";
  return `${misplaced.join(" and ")} only ${verb} to urls; tabs are saved as they are, without loading.`;
}

function tabsToSave(manager: ToolDeps["manager"], owner: string, ids: string[]) {
  const notes: string[] = [];
  const tabs = ids.map((id) => {
    const tab = manager.getTab(id);
    if (tabOwnership(tab, owner) === "other client")
      notes.push(`Note: ${tab.id} belongs to another session.`);
    const moved = manager.movedSinceSeen(tab);
    if (moved) notes.push(`Note: ${tab.id} moved to ${shownUrl(moved)} since your last call.`);
    manager.claimIfOrphaned(tab.id, owner);
    return tab;
  });
  return { tabs, notes };
}

async function savePages(
  { manager, store }: ToolDeps,
  input: SaveToolInput,
  owner: string,
  signal: AbortSignal,
) {
  const broken = saveRuleError(input);
  if (broken) throw new ToolError(broken);
  const shared = {
    include: input.include ?? ["text"],
    scope: input.scope ?? "main",
    settleMs: input.settle_ms ?? DEFAULT_QUIET_MS,
    maxWaitMs: input.max_wait_ms ?? DEFAULT_MAX_WAIT_MS,
    timeoutMs: input.timeout_ms ?? 30_000,
    fullPage: input.full_page ?? true,
    previewChars: input.preview_chars ?? 160,
    scroll: input.scroll
      ? {
          maxSteps: input.scroll.max_steps,
          stepPx: input.scroll.step_px,
          idleMs: input.scroll.idle_ms ?? 600,
        }
      : undefined,
    label: input.label,
    signal,
  };
  if (input.urls) {
    const { dir, results } = await collectPages(manager, store, owner, {
      ...shared,
      urls: input.urls,
      concurrency: input.concurrency ?? 6,
      delayMs: input.delay_ms ?? 0,
      waitUntil: input.wait_until ?? "domcontentloaded",
    });
    return {
      text: renderCollectIndex(dir, results),
      payloadFrame: collectIndexFrame(dir, results),
      data: collectSummary(dir, results),
    };
  }
  const { tabs, notes } = tabsToSave(manager, owner, input.tabs ?? []);
  const { dir, results } = await saveTabs(manager, store, owner, tabs, shared);
  const frame = collectIndexFrame(dir, results);
  return {
    text: [...notes, renderCollectIndex(dir, results)].join("\n"),
    payloadFrame: frame,
    data: { ...collectSummary(dir, results), notes: notes.length ? notes : undefined },
  };
}

export function registerDataTools(server: McpServer, deps: ToolDeps) {
  defineTool(server, deps, {
    name: "save_pages",
    title: "Save pages to files",
    description:
      'Save pages to files, from URLs (loaded in parallel tabs that are closed afterwards) or from open tabs (as they are now, left open), and return a compact index; per page it saves any of text, Markdown, links, the accessibility snapshot, a screenshot, structured data, a PDF, an MHTML archive or the HTML. Use urls when a task covers many pages, such as every product in a list, a set of articles or all routes of a site, so their content stays out of this conversation; use tabs to keep a receipt, invoice, order or booking confirmation, or a page as your actions left it, for example with include ["pdf"] (A4, with backgrounds). Afterwards ask_pages answers a question over the folder (pass it as dir), or read and grep the files yourself; for one or two pages, read_page is simpler. Each index line gives status, final URL, title, text length, files and a short preview. A cookie banner on a page from urls is handled per the server\'s consent setting before saving; a page that does not load or answer in time is listed as failed, as is a tab with an open dialog, and a page showing a bot check or a block instead of its content is listed as failed with reason challenge or blocked (its files are kept; an HTTP 429 answer is blocked as rate limited, so wait or raise delay_ms); a URL answered with HTTP 204 or 205 has no page and is listed with that status and reason no-content. Pages answered with an HTTP 4xx or 5xx status are listed with reason http-error (their files are kept), and they and these failures are not counted as collected; the index head counts each kind. Folders holding a pdf, mhtml or html file are kept until you delete them; others are deleted after 7 days. A file the site offers for download is saved by clicking its link, and screenshot captures one page as an image.',
    input: saveInput,
    output: {
      dir: z.string(),
      collected: z.number().int(),
      httpErrors: z.number().int(),
      challenges: z.number().int(),
      blocked: z.number().int(),
      noContent: z.number().int(),
      failed: z.number().int(),
      total: z.number().int(),
      pages: z.array(
        z.object({
          index: z.number().int(),
          url: z.string(),
          finalUrl: z.string().optional(),
          status: z.number().int().optional(),
          statusNote: z.string().optional(),
          title: z.string().optional(),
          type: z.string().optional(),
          bytes: z.number().int().optional(),
          note: z.string().optional(),
          scrolled: z
            .object({ steps: z.number().int(), height: z.number(), capped: z.boolean() })
            .optional(),
          unsettledMs: z.number().optional(),
          chars: z.number().int().optional(),
          files: z.array(z.string()),
          preview: z.string().optional(),
          data: z.string().optional(),
          error: z.string().optional(),
          reason: z.enum(["challenge", "blocked", "no-content", "http-error"]).optional(),
        }),
      ),
    },
    payload: ["pages"],
    handler: (input, owner, signal) => savePages(deps, input, owner, signal),
  });

  defineTool(server, deps, {
    name: "storage",
    title: "Cookies and site storage",
    description:
      "Read and change cookies (area cookies: list, set, delete, export), or read a tab's localStorage, sessionStorage or IndexedDB (area local, session or indexeddb: list, get, export). list shows matching cookies with their attributes, or storage keys with value sizes and IndexedDB database/store names with record counts; get returns one storage value, or every record of one IndexedDB store, clipped to max_chars with the full value saved to a file; set adds or replaces one cookie, which is then sent with matching requests; delete removes cookies of one site: it needs tab or domain, and key narrows it to one cookie name; export writes everything matching to a JSON file with raw, unmasked values (cookie exports are kept until you delete them, storage exports are deleted after 7 days). Use it to check whether a site's session cookie is there or has expired, to set a cookie a test or feature flag needs, to sign out of one site, or to see the tokens, settings and app state a site keeps in the browser. Deleting or replacing a session cookie signs the user out of that site. localStorage, sessionStorage and IndexedDB are changed with evaluate.",
    input: storageInput,
    handler: (input, _owner, signal) => storage(deps, input, signal),
  });
}
