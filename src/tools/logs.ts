import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config/config.ts";
import { consoleHookMode, drainConsole } from "../browser/page-hooks.ts";
import { type ConsoleEntry, documentOrder, readConsole, type Tab } from "../browser/tab.ts";
import { formatEntry, LOG_LEVELS, LOG_RETENTION_DAYS, readLog, shownEntry } from "../log/logger.ts";
import { withDeadline } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";
import { fieldPointer, localClock, shownUrl, untrusted } from "../shared/output.ts";
import { settleFreshPage } from "../page/page.ts";
import { evaluateIsolated } from "../browser/evaluate.ts";
import { structuredJson, structuredValue } from "../script/text.ts";
import { registrableDomain } from "../page/sites.ts";
import { defineTool, tabParam, type ToolDeps } from "./common.ts";

const FLUSH_MS = 2000;
const DEFAULT_LIMIT = 40;
const READY_STATE_MS = 1000;

type LogLevel = (typeof LOG_LEVELS)[number];

function levelOf(entryLevel: string): LogLevel {
  if (/error|assert/i.test(entryLevel)) return "error";
  if (/warn/i.test(entryLevel)) return "warn";
  if (/debug/i.test(entryLevel)) return "debug";
  return "info";
}

export type CaptureSettings = Pick<Config, "engine" | "consoleHook"> & {
  consoleSites?: readonly string[];
};

const isLocalHost = (host: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /\.(localhost|test)$/.test(host);

export const onConsoleSite = (sites: readonly string[], host: string) =>
  sites.some((site) => host === site || host.endsWith(`.${site}`));

function capturesPageCalls(config: CaptureSettings, url: string) {
  if (!/^https?:/i.test(url) || config.engine === "playwright" || config.consoleHook === "all")
    return true;
  if (config.consoleHook === "off") return false;
  const host = new URL(url).hostname;
  return isLocalHost(host) || onConsoleSite(config.consoleSites ?? [], host);
}

const webHost = (url: string) => (/^https?:/i.test(url) ? URL.parse(url)?.host : undefined);

export function uncapturedNote(config: CaptureSettings, urls: string[]) {
  const uncaptured = urls.filter((url) => !capturesPageCalls(config, url));
  if (uncaptured.length === 0) return undefined;
  const hosts = new Set(urls.map(webHost).filter(Boolean));
  const site = hosts.size > 1 ? [...new Set(uncaptured.map(webHost))].join(" and ") : "this site";
  const setting = `engine ${config.engine}, WEB_AGENT_CONSOLE_HOOK=${config.consoleHook}`;
  const restart =
    "ask the user to restart the server with WEB_AGENT_CONSOLE_HOOK=all or WEB_AGENT_ENGINE=playwright and reload the page; to inspect the page now, use evaluate.";
  if (config.consoleHook === "off")
    return `The page's own console calls and uncaught errors are not captured on ${site} (${setting}), so a missing entry does not mean the page logged nothing. To capture them, ${restart}`;
  const domains = [
    ...new Set(
      uncaptured
        .map((url) => URL.parse(url)?.hostname)
        .filter((host) => host !== undefined)
        .map(registrableDomain),
    ),
  ];
  const turnOn = domains
    .map((domain) => `call site with site ${domain} and console_capture true`)
    .join(" and ");
  return `The page's own console calls (console.log, console.error and the like) are not captured on ${site} (${setting}); its uncaught errors and unhandled rejections are, but not those inside iframes, rejections raised in a beforeunload handler, anything raised in a pagehide handler or errors of a page that navigates away within a few milliseconds of loading. To capture console calls too, ${turnOn}, then reload the page; or ${restart}`;
}

function checkedKinds(config: CaptureSettings, url: string) {
  if (capturesPageCalls(config, url))
    return "the console calls, uncaught errors and unhandled rejections of";
  if (config.consoleHook === "off") return "the messages Chrome itself logs about";
  return "the uncaught errors and unhandled rejections of";
}

export function checkedSentence(config: CaptureSettings, urls: string[]) {
  const web = urls.filter((url) => webHost(url) !== undefined);
  if (web.length === 0)
    return `Checked ${checkedKinds(config, urls.at(-1) ?? "about:blank")} the pages this tab showed.`;
  const hostsByKinds = new Map<string, Set<string>>();
  for (const url of web) {
    const kinds = checkedKinds(config, url);
    hostsByKinds.set(kinds, (hostsByKinds.get(kinds) ?? new Set()).add(webHost(url) ?? url));
  }
  const parts = [...hostsByKinds].map(
    ([kinds, hosts]) => `${kinds} the pages on ${[...hosts].join(" and ")}`,
  );
  return `Checked ${parts.join(", and ")}.`;
}

async function stillLoading(engine: Config["engine"], page: Tab["page"]) {
  const state = await withDeadline(
    evaluateIsolated(engine, page, "document.readyState", z.string()),
    READY_STATE_MS,
  ).catch(() => undefined);
  return state === "loading" || state === "interactive";
}

function groupByPage(tab: Tab, entries: ConsoleEntry[]) {
  const ids = documentOrder(tab, [...new Set(entries.map((entry) => entry.documentId))]);
  return ids.map((id) => {
    const own = entries.filter((entry) => entry.documentId === id);
    const url = tab.documents.find((document) => document.id === id)?.url ?? own[0]?.url ?? "";
    return { id, url, entries: own };
  });
}

export function quietCurrentSentence(
  url: string,
  { filtered, newOnly }: { filtered: boolean; newOnly: boolean },
) {
  return `No ${newOnly ? "new " : ""}${filtered ? "matching " : ""}entries from the current page (${shownUrl(url)}).`;
}

const POSITION = /:\d+:\d+$/;
const STACK_FRAME = /\n\s+at /g;

export function shownLogEntry(
  entry: Pick<ConsoleEntry, "time" | "level" | "text" | "source" | "url">,
) {
  const dataUrls = [entry.url, entry.source?.replace(POSITION, "")]
    .filter((url): url is string => url?.startsWith("data:") === true)
    .toSorted((first, second) => second.length - first.length);
  const shorten = (text: string) =>
    dataUrls.reduce((shortened, url) => shortened.replaceAll(url, shownUrl(url)), text);
  const source = entry.source === undefined ? undefined : shorten(entry.source);
  const shortened = shorten(entry.text);
  const cutAt = shortened.lastIndexOf("data:");
  const cutTail = shortened.slice(cutAt);
  const cutUrl = dataUrls.find(
    (url) => url.startsWith(cutTail) && cutTail.length > shownUrl(url).length,
  );
  const cutInTopFrame = (shortened.slice(0, cutAt).match(STACK_FRAME) ?? []).length <= 1;
  const text =
    cutAt === -1 || cutUrl === undefined
      ? shortened
      : `${shortened.slice(0, cutAt)}${cutInTopFrame && entry.source?.startsWith(cutUrl) && source ? source : shownUrl(cutUrl)}`;
  return {
    time: localClock(entry.time),
    level: entry.level,
    text,
    source,
  };
}

export function logEntryLine(
  entry: Pick<ConsoleEntry, "time" | "level" | "text" | "source" | "url">,
) {
  const shown = shownLogEntry(entry);
  const located = shown.source !== undefined && !shown.text.includes(shown.source);
  return `${shown.time} ${shown.level}: ${shown.text}${located ? ` (at ${shown.source})` : ""}`;
}

function lines(...parts: (string | undefined)[]) {
  return parts.filter(Boolean).join("\n");
}

function misplaced(parameter: string, source: "page" | "server"): never {
  const other = source === "page" ? "server" : "page";
  throw new ToolError(
    `${parameter} belongs to source ${other}.`,
    `With source ${source}, leave ${parameter} out.`,
  );
}

export function registerLogsTool(server: McpServer, deps: ToolDeps) {
  const { manager, log } = deps;

  async function pageLogs(
    input: {
      tab?: string;
      level?: LogLevel;
      contains?: string;
      limit?: number;
      new_only?: boolean;
    },
    owner: string,
  ) {
    if (!input.tab)
      throw new ToolError("source page needs tab.", "Pass the tab id, for example from tabs.");
    const tab = manager.getTab(input.tab);
    const contains = input.contains?.toLowerCase();
    const lowest = LOG_LEVELS.indexOf(input.level ?? "debug");
    await settleFreshPage(tab);
    await drainConsole(consoleHookMode(manager.config), tab);
    const entries = readConsole(tab, owner, input.new_only ?? false)
      .filter((entry) => LOG_LEVELS.indexOf(levelOf(entry.level)) >= lowest)
      .filter((entry) => !contains || entry.text.toLowerCase().includes(contains))
      .slice(-(input.limit ?? DEFAULT_LIMIT));
    const url = tab.page.url();
    const groups = groupByPage(tab, entries);
    const capture = { ...manager.config, consoleSites: await manager.consoleSites() };
    const note = uncapturedNote(capture, [url, ...groups.map((group) => group.url)]);
    const notePointer = note && fieldPointer("notCaptured");
    const filtered = input.level !== undefined || contains !== undefined;
    if (entries.length === 0) {
      const loading = (await stillLoading(manager.config.engine, tab.page))
        ? " The page is still loading, so errors it raises later are not in this result."
        : "";
      const quiet = `No ${input.new_only ? "new " : ""}console entries${filtered ? " matching your filters" : ""} captured on this tab (${shownUrl(url)}). ${checkedSentence(
        capture,
        tab.documents.map((document) => document.url),
      )}${loading}`;
      return {
        text: lines(note, quiet),
        payloadFrame: () => lines(notePointer, quiet),
        data: { pages: [], notCaptured: note },
      };
    }
    const header =
      groups.length > 1 ? [`Entries from ${groups.length} pages, newest page last:`] : [];
    const quietCurrent = groups.every((group) => group.id !== tab.currentDocument)
      ? quietCurrentSentence(url, { filtered, newOnly: input.new_only ?? false })
      : undefined;
    const text = lines(
      note,
      ...header,
      ...groups.map((group) => untrusted(group.url, group.entries.map(logEntryLine).join("\n"))),
      quietCurrent,
    );
    const pages = groups.map((group) => ({
      url: shownUrl(group.url),
      current: group.id === tab.currentDocument,
      entries: group.entries.map(shownLogEntry),
    }));
    return {
      text,
      payloadFrame: (shown: string) =>
        lines(notePointer, ...header, untrusted(url, shown), quietCurrent),
      data: { pages, notCaptured: note },
    };
  }

  async function serverLogs(input: {
    level?: LogLevel;
    contains?: string;
    limit?: number;
    request_id?: string;
    tool?: string;
    since_minutes?: number;
  }) {
    await withDeadline(log.flush(), FLUSH_MS);
    const result = await readLog(log.dir, {
      level: input.level,
      tool: input.tool,
      requestId: input.request_id
        ?.trim()
        .replace(/^\[?req\s+/i, "")
        .replace(/\]$/, ""),
      sinceMinutes: input.since_minutes,
      contains: input.contains,
      limit: input.limit ?? DEFAULT_LIMIT,
    });
    const lead = lines(
      `Log directory: ${log.dir} (level ${log.level}, daily JSON Lines files kept ${LOG_RETENTION_DAYS} days)`,
      log.failures ? `${log.failures} log entries could not be written.` : undefined,
      result.unreadable.length ? `Could not read: ${result.unreadable.join(", ")}.` : undefined,
    );
    const listed = (shown: string) =>
      lines(
        lead,
        result.entries.length === 0
          ? "No matching entries."
          : `${result.entries.length} entries (newest last):${shown}`,
      );
    return {
      text: listed(`\n${result.entries.map(formatEntry).join("\n")}`),
      payloadFrame: (shown: string) => listed(` ${shown}`),
      data: {
        dir: log.dir,
        entries: result.entries.map((entry) => structuredValue(shownEntry(entry))),
      },
    };
  }

  defineTool(server, deps, {
    name: "logs",
    title: "Page console and server logs",
    description: [
      "Read logs: source page returns a tab's console messages and uncaught errors, grouped by the page they came from with each page's URL, newest last, and source server returns this server's own log of tool calls, failures, browser launches, crashes and background jobs.",
      "With the default patchright engine, uncaught errors and unhandled rejections are captured on every site but the page's own console calls only on local development hosts (localhost, 127.0.0.1, *.localhost, *.test); WEB_AGENT_CONSOLE_HOOK=all captures console calls on every site and off captures neither. Where they are not captured, a missing entry does not mean the page has no errors, and that page's entries start with a note saying so. With patchright, entries from inside iframes are not captured, a page that navigates away within a few milliseconds of loading may lose its errors, errors raised in a beforeunload handler are captured but its unhandled rejections are not, and with either engine nothing raised in a pagehide handler is captured; where console calls are not captured, an unhandled rejection of a page the tab has left shows its message without the stack. With WEB_AGENT_ENGINE=playwright they are captured on every site and WEB_AGENT_CONSOLE_HOOK has no effect. Messages Chrome itself logs about the page, such as a Permissions-Policy header error, are captured on every site. site with console_capture true also captures the page's own console calls on one site, from its next page load.",
      "Page entries name their source file, line and column when the browser reports one. Use source page when a page misbehaves or shows a blank area, to look for JavaScript errors or warnings; failed requests are in network. Use source server when a tool call failed or behaved oddly, before retrying or asking the user: a failed result ends with [req <id>], request_id finds that call, and level, tool, since_minutes and contains show what happened around it, such as a browser crash or a relaunch.",
      "The server log holds only the server's own events. Its inputs are summarized: secret, text, value, code, post data and similar fields appear only as their length, URLs keep their query keys with each value replaced by its length, and stored secrets are masked.",
    ].join("\n"),
    input: {
      source: z
        .enum(["page", "server"])
        .describe("page: console messages and errors of the tab; server: the server's own log."),
      tab: tabParam.optional().describe("Source page: the tab to read."),
      level: z
        .enum(LOG_LEVELS)
        .optional()
        .describe(
          "Lowest level to include: debug, info, warn or error. Default debug for page (everything) and info for server. For page, log counts as info and warning as warn; failed server tool calls are warn, faults and crashes error.",
        ),
      contains: z
        .string()
        .optional()
        .describe(
          "Only entries containing this text, case-insensitive: for source page, in the message; for source server, anywhere in the raw JSON log line, field names and values included.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(`Most entries to return, newest last. Default ${DEFAULT_LIMIT}.`),
      new_only: z
        .boolean()
        .optional()
        .describe(
          "Source page: return only entries captured since your last logs call on this tab. Default false.",
        ),
      request_id: z
        .string()
        .optional()
        .describe(
          "Source server: only the entry with this request id, the 6 hex characters from [req <id>] at the end of a failed result.",
        ),
      tool: z
        .string()
        .optional()
        .describe("Source server: only calls of this tool, for example click."),
      since_minutes: z
        .number()
        .int()
        .min(1)
        .max(LOG_RETENTION_DAYS * 24 * 60)
        .optional()
        .describe("Source server: only entries from the last this many minutes."),
    },
    output: {
      pages: z
        .array(
          z.object({
            url: z.string(),
            current: z.boolean(),
            entries: z.array(
              z.object({
                time: z.string(),
                level: z.string(),
                text: z.string(),
                source: z.string().optional(),
              }),
            ),
          }),
        )
        .optional(),
      notCaptured: z.string().optional(),
      dir: z.string().optional(),
      entries: z.array(structuredJson).optional(),
    },
    payload: ["pages", "entries"],
    readOnly: true,
    handler: async (input, owner) => {
      if (input.source === "page") {
        if (input.request_id !== undefined) misplaced("request_id", "page");
        if (input.tool !== undefined) misplaced("tool", "page");
        if (input.since_minutes !== undefined) misplaced("since_minutes", "page");
        return pageLogs(input, owner);
      }
      if (input.tab !== undefined) misplaced("tab", "server");
      if (input.new_only !== undefined) misplaced("new_only", "server");
      return serverLogs({ ...input, level: input.level ?? "info" });
    },
  });
}
