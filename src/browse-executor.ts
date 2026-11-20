import { readFile } from "node:fs/promises";
import type { AskImageBlock, AskImageMediaType, AskTextBlock } from "./ask-adapter.ts";
import { untilAborted, withDeadline } from "./async.ts";
import type { Tab } from "./browser.ts";
import { classifyClick, classifyNavigation, classifyPress, classifySearch, classifySelect, describeFocused, describeTarget, type GuardPolicy, offLimits, type Verdict } from "./browse-guard.ts";
import { type BrowseExecutor, type ToolExecution, validateWith } from "./browse-loop.ts";
import { BROWSE_TOOL_DEFINITIONS, type BrowseTool, browseTool, toModelImage } from "./browse-tools.ts";
import { describeError } from "./errors.ts";
import { browserTranscoder } from "./model-images.ts";
import { collectToolCallbacks } from "./tools/callbacks.ts";
import type { ToolCallResult, ToolDeps } from "./tools/common.ts";

const BROWSE_FLAGS = { dismissDialogs: true, blockDownloads: true } as const;
const POPUP_LOAD_MS = 3000;
const BACK_MS = 10_000;
const CLOSE_MS = 12_000;
const MEDIA_TYPES = new Set<string>(["image/jpeg", "image/png", "image/webp"]);
const TALL_SCREENSHOT = /saved to (\S+\.jpg)\. The page is \d+px tall/;

export type BrowseStart = { kind: "open"; url: string; openTab: () => Promise<Tab> } | { kind: "tab"; tab: Tab };

export type BrowseExecutorOptions = {
  owner: string;
  requestId: string;
  sites: string[];
  start: BrowseStart;
  signal: AbortSignal;
};

export type OpenedExecutor = BrowseExecutor & { tabId: string; startUrl: string };

const text = (value: string, isError = false): ToolExecution => ({ content: [{ type: "text", text: value }], isError });
const textOf = (result: ToolCallResult) => result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

export async function openBrowseExecutor(deps: ToolDeps, options: BrowseExecutorOptions): Promise<OpenedExecutor> {
  const { manager } = deps;
  const callbacks = collectToolCallbacks(deps);
  const startedAt = Date.now();
  const tabs = new Set<string>();
  const opened = new Set<string>();
  const notes: string[] = [];
  let callerTab: Tab | undefined;
  let mainId: string;
  let startUrl: string;

  const callTool = (name: string, input: Record<string, unknown>, signal: AbortSignal) => {
    const callback = callbacks.get(name);
    if (!callback) throw new Error(`no tool ${name}`);
    return untilAborted(callback.call(input, { sessionId: options.owner, signal, parentRequestId: options.requestId }), signal, () => new Error("cancelled"));
  };

  const closeOne = async (id: string) => {
    if (manager.peekTab(id)) await withDeadline(manager.closeTab(id), CLOSE_MS).catch(() => undefined);
  };

  if (options.start.kind === "tab") {
    callerTab = options.start.tab;
    callerTab.browse = BROWSE_FLAGS;
    mainId = callerTab.id;
    startUrl = callerTab.page.url();
  } else {
    const tab = await untilAborted(options.start.openTab(), options.signal, () => new Error("cancelled"));
    tab.browse = BROWSE_FLAGS;
    opened.add(tab.id);
    mainId = tab.id;
    try {
      const loaded = await callTool("navigate", { tab: tab.id, url: options.start.url }, options.signal);
      if (loaded.isError) throw new Error(textOf(loaded).split("\n")[0]);
    } catch (error) {
      await closeOne(tab.id);
      throw new Error(`could not open ${options.start.url}: ${describeError(error).split("\n")[0]}`);
    }
    startUrl = tab.page.isClosed() ? options.start.url : tab.page.url();
  }
  tabs.add(mainId);
  let current = mainId;
  const policy: GuardPolicy = { startUrl, sites: options.sites };

  const toExecution = async (result: ToolCallResult, tool: BrowseTool, tab: Tab): Promise<ToolExecution> => {
    const content: (AskTextBlock | AskImageBlock)[] = [];
    for (const part of result.content) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else {
        const mediaType = (MEDIA_TYPES.has(part.mimeType) ? part.mimeType : "image/jpeg") as AskImageMediaType;
        content.push({ type: "image", image: await toModelImage(Buffer.from(part.data, "base64"), mediaType, browserTranscoder(tab.page), `screenshot of ${tab.id}`) });
      }
    }
    const tall = tool.name === "screenshot" && !result.isError ? TALL_SCREENSHOT.exec(textOf(result)) : null;
    if (tall?.[1]) {
      const file = tall[1];
      const image = await toModelImage(await readFile(file), "image/jpeg", browserTranscoder(tab.page), `full page of ${tab.id}`);
      return { content: [{ type: "text", text: `Screenshot of ${tab.page.url()} saved to ${file}` }, { type: "image", image }], isError: false };
    }
    return { content, isError: result.isError === true };
  };

  const check = async (tool: BrowseTool, input: Record<string, unknown>, tab: Tab): Promise<Verdict> => {
    if (tool.guard === "navigate") return classifyNavigation(String(input.url), policy);
    const target = typeof input.target === "string" ? input.target : undefined;
    const described = target ? await describeTarget(await manager.resolve(tab, target)) : undefined;
    if (tool.guard === "press") return classifyPress(String(input.key), target ? described : await describeFocused(tab.page), policy);
    if (!described) return { allow: false, reason: `${tool.name} needs a target` };
    if (tool.guard === "click") return classifyClick(described, policy);
    if (tool.guard === "select") return classifySelect(described);
    return classifySearch(described);
  };

  const bounceOffLimits = async () => {
    for (const id of tabs) {
      const tab = manager.peekTab(id);
      if (!tab) continue;
      const url = tab.page.url();
      if (url === "about:blank" || !offLimits(url, policy)) continue;
      await withDeadline(tab.page.goBack({ waitUntil: "commit", timeout: BACK_MS }), BACK_MS + 1000).catch(() => undefined);
      return `The action led to ${url}, which is off-limits; the tab went back.`;
    }
    return undefined;
  };

  const adoptPopups = async () => {
    const popups = manager.listTabs().filter((tab) => tab.openerId !== undefined && tabs.has(tab.openerId) && !tabs.has(tab.id) && tab.createdAt >= startedAt);
    for (const popup of popups) {
      popup.browse = BROWSE_FLAGS;
      await withDeadline(popup.page.waitForLoadState("domcontentloaded", { timeout: POPUP_LOAD_MS }), POPUP_LOAD_MS + 500).catch(() => undefined);
      const url = popup.page.url();
      if (url !== "about:blank" && offLimits(url, policy)) {
        await closeOne(popup.id);
        notes.push(`New tab ${popup.id} (${url}) leads off this site and was closed.`);
        continue;
      }
      tabs.add(popup.id);
      opened.add(popup.id);
      notes.push(`New tab ${popup.id} opened from ${popup.openerId}: ${url}. Pass tab ${popup.id} to work in it, and close_tab when you are done.`);
    }
  };

  const listTabs = () => {
    const lines = [...tabs].map((id) => {
      const tab = manager.peekTab(id);
      return `${id}${id === current ? " (current)" : ""}${id === mainId ? " (the page you started on)" : ""}: ${tab ? tab.page.url() : "closed"}`;
    });
    return text(lines.join("\n"));
  };

  const run = async (name: string, value: unknown, signal: AbortSignal): Promise<ToolExecution> => {
    const tool = browseTool(name);
    if (!tool) return text(`Unknown tool ${name}.`, true);
    const input = value as Record<string, unknown>;
    if (tool.name === "list_tabs") return listTabs();
    const id = typeof input.tab === "string" ? input.tab.trim() : current;
    if (!tabs.has(id)) return text(`Tab ${id} is not one of this task's tabs (${[...tabs].join(", ")}).`, true);
    const tab = manager.peekTab(id);
    if (!tab) {
      tabs.delete(id);
      if (current === id) current = mainId;
      return text(`Tab ${id} is closed.`, true);
    }
    if (tool.name === "close_tab" && !(opened.has(id) && id !== mainId)) return text(`Only tabs a click opened during this task can be closed; ${id} is the page you are working on.`, true);
    if (tool.guard) {
      let verdict: Verdict;
      try {
        verdict = await untilAborted(check(tool, input, tab), signal, () => new Error("cancelled"));
      } catch (error) {
        return text(describeError(error), true);
      }
      if (!verdict.allow) return { content: [], isError: true, blocked: verdict.reason };
    }
    current = tool.name === "close_tab" ? current : id;
    const result = await callTool(tool.mcp ?? tool.name, tool.toMcp(input, id), signal);
    if (tool.name === "close_tab" && !result.isError) {
      tabs.delete(id);
      opened.delete(id);
      if (current === id) current = mainId;
    }
    const execution = await toExecution(result, tool, tab);
    if (tool.action) {
      const bounced = await bounceOffLimits();
      if (bounced) {
        await adoptPopups();
        return text(bounced, true);
      }
    }
    await adoptPopups();
    return execution;
  };

  return {
    tabId: mainId,
    startUrl,
    tools: BROWSE_TOOL_DEFINITIONS,
    validate: (name, input) => {
      const tool = browseTool(name);
      return tool ? validateWith(tool.schema, input) : { ok: false, error: `Unknown tool ${name}.` };
    },
    run,
    newTabsNote: () => (notes.length ? notes.splice(0).join("\n") : undefined),
    currentUrl: () => manager.peekTab(mainId)?.page.url(),
    close: async () => {
      if (callerTab) delete callerTab.browse;
      const late = manager.listTabs().filter((tab) => tab.openerId !== undefined && tabs.has(tab.openerId) && tab.createdAt >= startedAt);
      for (const tab of late) opened.add(tab.id);
      for (const id of opened) await closeOne(id);
      opened.clear();
    },
  };
}
