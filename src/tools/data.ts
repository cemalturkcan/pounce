import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectPages, renderCollectIndex } from "../collect.ts";
import { ToolError } from "../errors.ts";
import { untrusted } from "../output.ts";
import { appendSiteNote, readSiteNotes, siteHost, siteNotesPath } from "../sites.ts";
import { exportIndexedDb, listIndexedDb, readIndexedDbStore, readWebStorage, splitStoreKey, storageOrigin } from "../storage.ts";
import { clipToFile, defineTool, tabParam, type ToolDeps, type ToolInput, waitUntilParam } from "./common.ts";

export function cookieDomainMatches(cookieDomain: string, wanted: string) {
  const domain = cookieDomain.toLowerCase();
  const bare = wanted.toLowerCase().replace(/^\./, "");
  return domain === bare || domain === `.${bare}` || domain.endsWith(`.${bare}`);
}

const cookiesInput = {
  action: z.enum(["list", "set", "delete", "export"]).describe("What to do."),
  tab: tabParam.optional().describe("For list and export: only cookies that would be sent to this tab's current URL. For set: default URL for the cookie."),
  domain: z.string().optional().describe("For list and export: keep cookies whose domain contains this. For delete: cookies of exactly this domain or its subdomains (x.com matches x.com and a.x.com, not netflix.com). For set: the cookie's domain, for example .example.com."),
  name: z.string().optional().describe("Cookie name. Required for set; a filter for list, delete and export."),
  value: z.string().optional().describe("For set: cookie value."),
  path: z.string().optional().describe("For set: cookie path. Default /."),
  url: z.string().optional().describe("For set: URL the cookie belongs to, as an alternative to domain and path."),
  expires_in_seconds: z.number().int().optional().describe("For set: lifetime from now. Omit for a session cookie."),
  http_only: z.boolean().optional().describe("For set. Default false."),
  secure: z.boolean().optional().describe("For set. Default true for https URLs."),
  same_site: z.enum(["Strict", "Lax", "None"]).optional().describe("For set."),
  full_values: z.boolean().optional().describe("For list: show whole values instead of the first 60 characters. Default false."),
};

async function manageCookies({ manager, store }: ToolDeps, input: ToolInput<typeof cookiesInput>) {
  const context = await manager.ensureContext();
  const tab = input.tab ? manager.getTab(input.tab) : undefined;

  if (input.action === "set") {
    if (!input.name || input.value === undefined) throw new ToolError("set needs name and value.");
    const url = input.domain ? undefined : (input.url ?? tab?.page.url());
    if (!input.domain && !url) throw new ToolError("set needs domain, url, or tab to know which site the cookie belongs to.");
    await context.addCookies([
      {
        name: input.name,
        value: input.value,
        ...(input.domain ? { domain: input.domain, path: input.path ?? "/" } : { url }),
        expires: input.expires_in_seconds === undefined ? undefined : Math.floor(Date.now() / 1000) + input.expires_in_seconds,
        httpOnly: input.http_only,
        secure: input.secure ?? (input.domain ? undefined : url?.startsWith("https:")),
        sameSite: input.same_site,
      },
    ]);
    return `Set cookie ${input.name} for ${input.domain ?? url}.`;
  }

  const domain = input.domain?.toLowerCase();
  const domainMatches = input.action === "delete" ? cookieDomainMatches : (cookieDomain: string, wanted: string) => cookieDomain.toLowerCase().includes(wanted);
  const cookies = (await context.cookies(tab ? [tab.page.url()] : undefined))
    .filter((cookie) => !domain || domainMatches(cookie.domain, domain))
    .filter((cookie) => !input.name || cookie.name === input.name);

  if (input.action === "delete") {
    if (!input.domain && !input.name) throw new ToolError("delete needs domain or name, so it cannot wipe every cookie by accident.");
    for (const cookie of cookies) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
    return `Deleted ${cookies.length} cookies.`;
  }
  if (cookies.length === 0) return "No matching cookies.";
  if (input.action === "export") {
    const file = await store.write("cookies", store.uniqueName(input.domain ?? tab?.id ?? "cookies", "json"), JSON.stringify(cookies, null, 2), { raw: true });
    return `Exported ${cookies.length} cookies to ${file}`;
  }
  return cookies
    .map((cookie) => {
      const value = input.full_values || cookie.value.length <= 60 ? cookie.value : `${cookie.value.slice(0, 60)}… (${cookie.value.length} chars)`;
      const flags = [cookie.httpOnly ? "HttpOnly" : "", cookie.secure ? "Secure" : "", cookie.sameSite, cookie.expires > 0 ? `expires ${new Date(cookie.expires * 1000).toISOString().slice(0, 10)}` : "session"].filter(Boolean).join(" ");
      return `${cookie.domain}${cookie.path} ${cookie.name}=${value} [${flags}]`;
    })
    .join("\n");
}

const storageInput = {
  tab: tabParam,
  action: z.enum(["list", "get", "export"]).describe("What to do."),
  area: z.enum(["local", "session", "indexeddb"]).describe("localStorage, sessionStorage, or IndexedDB."),
  key: z.string().optional().describe("For get: the storage key, or for indexeddb the database/store name (the store name alone works when it is unique)."),
  max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for get. Default 8000."),
};

async function readStorage({ manager, store }: ToolDeps, input: ToolInput<typeof storageInput>) {
  const tab = manager.getTab(input.tab);
  const origin = storageOrigin(tab.page);
  const label = `${input.area}Storage`.replace("indexeddbStorage", "IndexedDB");
  if (input.area === "indexeddb") {
    if (input.action === "list") {
      const stores = await listIndexedDb(tab.page);
      if (stores.length === 0) return `No IndexedDB databases for ${origin}.`;
      return untrusted(tab.page.url(), stores.map((entry) => `${entry.database}/${entry.store} (${entry.count < 0 ? "?" : entry.count} records)`).join("\n"));
    }
    if (input.action === "export") {
      const { stores, data } = await exportIndexedDb(tab.page);
      const file = await store.write("storage", store.uniqueName(`${origin}-indexeddb`, "json"), JSON.stringify({ origin, databases: data }, null, 2), { raw: true });
      return `Exported ${stores.length} IndexedDB object stores of ${origin} to ${file}`;
    }
    if (!input.key) throw new ToolError("get needs key (database/store).");
    const found = splitStoreKey(input.key, await listIndexedDb(tab.page));
    const { records, truncated } = await readIndexedDbStore(tab.page, found.database, found.store);
    const note = truncated ? `\n[stopped after ${records.length} records; use export or run_script for the rest]` : "";
    const body = await clipToFile(store, "storage", `${origin}-${found.database}-${found.store}`, JSON.stringify(records, null, 2), input.max_chars ?? 8000);
    return untrusted(tab.page.url(), `${found.database}/${found.store}: ${records.length} records\n${body}${note}`);
  }
  const entries = await readWebStorage(tab.page, input.area);
  const keys = Object.keys(entries);
  if (input.action === "export") {
    const file = await store.write("storage", store.uniqueName(`${origin}-${input.area}`, "json"), JSON.stringify({ origin, area: input.area, entries }, null, 2), { raw: true });
    return `Exported ${keys.length} ${label} entries of ${origin} to ${file}`;
  }
  if (input.action === "list") {
    if (keys.length === 0) return `${label} of ${origin} is empty.`;
    return untrusted(tab.page.url(), keys.map((key) => `${key} (${entries[key]?.length ?? 0} chars)`).join("\n"));
  }
  if (input.key === undefined) throw new ToolError("get needs key.");
  const value = entries[input.key];
  if (value === undefined) throw new ToolError(`${label} of ${origin} has no key ${JSON.stringify(input.key)}.`, "List the keys with action list.");
  return untrusted(tab.page.url(), await clipToFile(store, "storage", `${origin}-${input.key}`, value, input.max_chars ?? 8000));
}

export function registerDataTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "collect_pages",
    title: "Collect many pages",
    description:
      "Open a list of URLs in parallel tabs, save each page's content to files, close the tabs, and return a compact index (status, final URL, title, text length, file names, short preview). Use it to gather many pages without loading them into the conversation; then read or grep the files you need. Per page it can save the visible text, the list of links, the accessibility snapshot, and a screenshot. A page that does not load or answer within its time limit is reported as failed and its tab is closed anyway. Collected files are transient: they are deleted when the server starts after 7 days.",
    input: {
      urls: z.array(z.string().min(1)).min(1).max(200).describe("URLs to load. https:// is assumed when no scheme is given."),
      include: z
        .array(z.enum(["text", "markdown", "links", "snapshot", "screenshot", "structured"]))
        .optional()
        .describe("What to save per page. markdown saves the content as a .md file with headings, lists, links, code blocks and tables kept. structured saves JSON-LD, meta tags and tables as JSON and adds product name, price and availability to the index when the page declares them. Default [\"text\"]."),
      scope: z.enum(["main", "page"]).optional().describe("For text and markdown: main keeps the main content area when the page marks one; page keeps everything. Default main."),
      full_page: z.boolean().optional().describe("For screenshot: capture the whole scrollable page instead of the viewport. Default true."),
      concurrency: z.number().int().min(1).max(12).optional().describe("Tabs loading at once. Default 6."),
      wait_until: waitUntilParam,
      settle_ms: z.number().int().min(0).max(30_000).optional().describe("Extra wait after the navigation milestone, for pages that render content with JavaScript. Default 800."),
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(120_000)
        .optional()
        .describe("Time limit per page in milliseconds for loading it, and the same again for saving its content; settle_ms is added on top. Default 30000."),
      preview_chars: z.number().int().min(0).max(2000).optional().describe("Characters of text shown per page in the index; 0 for none. Default 160."),
      label: z.string().optional().describe("Short name used in the output folder name."),
    },
    handler: async (input, owner, signal) => {
      const { dir, results } = await collectPages(manager, store, owner, {
        urls: input.urls,
        include: input.include ?? ["text"],
        scope: input.scope ?? "main",
        concurrency: input.concurrency ?? 6,
        waitUntil: input.wait_until ?? "domcontentloaded",
        settleMs: input.settle_ms ?? 800,
        timeoutMs: input.timeout_ms ?? 30_000,
        fullPage: input.full_page ?? true,
        previewChars: input.preview_chars ?? 160,
        label: input.label,
        signal,
      });
      return renderCollectIndex(dir, results);
    },
  });

  defineTool(server, deps, {
    name: "cookies",
    title: "Cookies",
    description:
      "Read, set, delete or export the browser's cookies. The cookie jar is shared by all tabs of the profile. list shows matching cookies with their attributes; set adds or replaces one cookie, which is then sent with matching requests; delete removes matching cookies; export writes all matching cookies with full, unmasked values to a JSON file that is kept until you delete it. Deleting or replacing a session cookie signs the user out of that site.",
    input: cookiesInput,
    handler: (input) => manageCookies(deps, input),
  });

  defineTool(server, deps, {
    name: "storage",
    title: "Site storage",
    description:
      "Read the localStorage, sessionStorage or IndexedDB of the origin a tab is on. list shows keys with value sizes (for IndexedDB: database/store names with record counts); get returns one value (for IndexedDB: every record of one store) clipped to max_chars with the full value saved to a file; export writes the whole area to a JSON file with raw, unmasked values and returns its path. Values often hold tokens and app state, which makes this the quickest way to see what a single-page app knows. It only reads; to change storage use evaluate.",
    input: storageInput,
    readOnly: true,
    handler: (input) => readStorage(deps, input),
  });

  defineTool(server, deps, {
    name: "site_notes",
    title: "Site notes",
    description:
      "Read or add to the notes kept for one website, a Markdown file per host name that survives between sessions. Record what took effort to find out: working selectors, API endpoints and their parameters, pagination schemes, login steps, rate limits and quirks; the next visit then starts from them. tab_open and navigate mention when a host has notes. Notes are written by agents, not by the site, and are not shared with any other machine.",
    input: {
      action: z.enum(["read", "append"]).describe("read returns the notes; append adds one dated line."),
      tab: tabParam.optional().describe("Use the host of this tab's current URL."),
      site: z.string().optional().describe("Host name or URL, for example shop.example.com, when no tab is given. A leading www. is ignored."),
      note: z.string().max(2000).optional().describe("For append: the note, one line, for example: search API is GET /api/search?q=&page= returning JSON; 24 items per page."),
    },
    handler: async (input) => {
      const source = input.site ?? (input.tab ? manager.getTab(input.tab).page.url() : undefined);
      if (!source) throw new ToolError("Give tab or site.");
      const host = siteHost(source);
      const { sitesDir } = manager.config;
      if (input.action === "append") {
        if (!input.note) throw new ToolError("append needs note.");
        const file = await appendSiteNote(sitesDir, host, input.note);
        return `Added a note for ${host} to ${file}.`;
      }
      const notes = await readSiteNotes(sitesDir, host);
      if (!notes) return `No notes for ${host} yet. Add one with action append once you learn something worth keeping.`;
      return `Notes for ${host} (${siteNotesPath(sitesDir, host)}):\n${notes.trimEnd()}`;
    },
  });
}
