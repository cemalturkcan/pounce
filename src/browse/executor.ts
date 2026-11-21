import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { AskImageBlock, AskTextBlock } from "../ask/adapter.ts";
import { inSequence, untilAborted, withDeadline } from "../shared/async.ts";
import {
  classifyClick,
  classifyNavigation,
  classifyPress,
  classifySearch,
  classifySelect,
  describeFocused,
  describeTarget,
  type GuardPolicy,
  offLimits,
  type Verdict,
} from "./guard.ts";
import type { BrowseExecutor, ToolExecution } from "./loop.ts";
import { validated } from "./report.ts";
import {
  BROWSE_TOOL_DEFINITIONS,
  type BrowseInput,
  browseInputOf,
  type BrowseTool,
  browseTool,
  type McpArguments,
  toModelImage,
} from "./tool-table.ts";
import { describeError } from "../shared/errors.ts";
import { browserTranscoder } from "../ask/model-images.ts";
import type { ToolCallExtra, ToolCallResult } from "../shared/tool-call.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tab.ts";

const BROWSE_FLAGS = { dismissDialogs: true, blockDownloads: true } as const;
const POPUP_LOAD_MS = 3000;
const BACK_MS = 10_000;
const CLOSE_MS = 12_000;
const mediaType = z.enum(["image/jpeg", "image/png", "image/webp"]).catch("image/jpeg");
const TALL_SCREENSHOT = /saved to (\S+\.jpg)\. The page is \d+px tall/;

type BrowseStart =
  | { kind: "open"; url: string; openTab: () => Promise<Tab> }
  | { kind: "tab"; tab: Tab };

type BrowseExecutorOptions = {
  owner: string;
  requestId: string;
  sites: string[];
  start: BrowseStart;
  signal: AbortSignal;
};

export type BrowseHost = {
  manager: BrowserManager;
  tools: ReadonlyMap<
    string,
    { call(input: McpArguments, extra: ToolCallExtra): Promise<ToolCallResult> }
  >;
};

type OpenedExecutor = BrowseExecutor & { tabId: string; startUrl: string };

export const textExecution = (value: string, isError = false): ToolExecution => ({
  content: [{ type: "text", text: value }],
  isError,
});
const textOf = (result: ToolCallResult) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

async function toExecution(
  result: ToolCallResult,
  tool: BrowseTool,
  tab: Tab,
): Promise<ToolExecution> {
  const content = await inSequence(
    result.content,
    async (part): Promise<AskTextBlock | AskImageBlock> => {
      if (part.type === "text") return { type: "text", text: part.text };
      return {
        type: "image",
        image: await toModelImage(
          Buffer.from(part.data, "base64"),
          mediaType.parse(part.mimeType),
          browserTranscoder(tab.page),
          `screenshot of ${tab.id}`,
        ),
      };
    },
  );
  const tall =
    tool.name === "screenshot" && !result.isError ? TALL_SCREENSHOT.exec(textOf(result)) : null;
  if (tall?.[1]) {
    const file = tall[1];
    const image = await toModelImage(
      await readFile(file),
      "image/jpeg",
      browserTranscoder(tab.page),
      `full page of ${tab.id}`,
    );
    return {
      content: [
        { type: "text", text: `Screenshot of ${tab.page.url()} saved to ${file}` },
        { type: "image", image },
      ],
      isError: false,
    };
  }
  return { content, isError: result.isError === true };
}

export async function openBrowseExecutor(
  host: BrowseHost,
  options: BrowseExecutorOptions,
): Promise<OpenedExecutor> {
  const { manager } = host;
  const startedAt = Date.now();
  const tabs = new Set<string>();
  const opened = new Set<string>();
  const notes: string[] = [];
  let callerTab: Tab | undefined;
  let mainId: string;
  let startUrl: string;

  const callTool = (name: string, input: McpArguments, signal: AbortSignal) => {
    const callback = host.tools.get(name);
    if (!callback) throw new Error(`no tool ${name}`);
    return untilAborted(
      callback.call(input, {
        sessionId: options.owner,
        signal,
        parentRequestId: options.requestId,
      }),
      signal,
      () => new Error("cancelled"),
    );
  };

  const closeOne = async (id: string) => {
    if (manager.peekTab(id))
      await withDeadline(manager.closeTab(id), CLOSE_MS).catch(() => undefined);
  };

  if (options.start.kind === "tab") {
    callerTab = options.start.tab;
    callerTab.browse = BROWSE_FLAGS;
    mainId = callerTab.id;
    startUrl = callerTab.page.url();
  } else {
    const tab = await untilAborted(
      options.start.openTab(),
      options.signal,
      () => new Error("cancelled"),
    );
    tab.browse = BROWSE_FLAGS;
    opened.add(tab.id);
    mainId = tab.id;
    try {
      const loaded = await callTool(
        "navigate",
        { tab: tab.id, url: options.start.url },
        options.signal,
      );
      if (loaded.isError) throw new Error(textOf(loaded).split("\n")[0]);
    } catch (cause) {
      await closeOne(tab.id);
      throw new Error(
        `could not open ${options.start.url}: ${describeError(cause).split("\n")[0]}`,
        { cause },
      );
    }
    startUrl = tab.page.isClosed() ? options.start.url : tab.page.url();
  }
  tabs.add(mainId);
  let current = mainId;
  const policy: GuardPolicy = { startUrl, sites: options.sites };

  const check = async (tool: BrowseTool, input: BrowseInput, tab: Tab): Promise<Verdict> => {
    if (tool.guard === "navigate") return classifyNavigation(String(input.url), policy);
    const target = input.target;
    const described = target ? await describeTarget(await manager.resolve(tab, target)) : undefined;
    if (tool.guard === "press")
      return classifyPress(
        String(input.key),
        target ? described : await describeFocused(tab.page),
        policy,
      );
    if (!described) return { allow: false, reason: `${tool.name} needs a target` };
    if (tool.guard === "click") return classifyClick(described, policy);
    if (tool.guard === "select") return classifySelect(described);
    return classifySearch(described);
  };

  const bounceOffLimits = async () => {
    const strayed = [...tabs]
      .map((id) => manager.peekTab(id))
      .map((tab) => ({ tab, url: tab?.page.url() ?? "about:blank" }))
      .find(({ url }) => url !== "about:blank" && offLimits(url, policy));
    if (!strayed?.tab) return undefined;
    await withDeadline(
      strayed.tab.page.goBack({ waitUntil: "commit", timeout: BACK_MS }),
      BACK_MS + 1000,
    ).catch(() => undefined);
    return `The action led to ${strayed.url}, which is off-limits; the tab went back.`;
  };

  const adoptPopups = async () => {
    const popups = manager
      .listTabs()
      .filter(
        (tab) =>
          tab.openerId !== undefined &&
          tabs.has(tab.openerId) &&
          !tabs.has(tab.id) &&
          tab.createdAt >= startedAt,
      );
    await inSequence(popups, async (popup) => {
      popup.browse = BROWSE_FLAGS;
      await withDeadline(
        popup.page.waitForLoadState("domcontentloaded", { timeout: POPUP_LOAD_MS }),
        POPUP_LOAD_MS + 500,
      ).catch(() => undefined);
      const url = popup.page.url();
      if (url !== "about:blank" && offLimits(url, policy)) {
        await closeOne(popup.id);
        notes.push(`New tab ${popup.id} (${url}) leads off this site and was closed.`);
        return;
      }
      tabs.add(popup.id);
      opened.add(popup.id);
      notes.push(
        `New tab ${popup.id} opened from ${popup.openerId}: ${url}. Pass tab ${popup.id} to work in it, and close_tab when you are done.`,
      );
    });
  };

  const listTabs = () => {
    const lines = [...tabs].map((id) => {
      const tab = manager.peekTab(id);
      return `${id}${id === current ? " (current)" : ""}${id === mainId ? " (the page you started on)" : ""}: ${tab ? tab.page.url() : "closed"}`;
    });
    return textExecution(lines.join("\n"));
  };

  const run = async (
    name: string,
    input: BrowseInput,
    signal: AbortSignal,
  ): Promise<ToolExecution> => {
    const tool = browseTool(name);
    if (!tool) return textExecution(`Unknown tool ${name}.`, true);
    if (tool.name === "list_tabs") return listTabs();
    const id = input.tab?.trim() ?? current;
    if (!tabs.has(id))
      return textExecution(
        `Tab ${id} is not one of this task's tabs (${[...tabs].join(", ")}).`,
        true,
      );
    const tab = manager.peekTab(id);
    if (!tab) {
      tabs.delete(id);
      if (current === id) current = mainId;
      return textExecution(`Tab ${id} is closed.`, true);
    }
    if (tool.name === "close_tab" && !(opened.has(id) && id !== mainId))
      return textExecution(
        `Only tabs a click opened during this task can be closed; ${id} is the page you are working on.`,
        true,
      );
    if (tool.guard) {
      let verdict: Verdict;
      try {
        verdict = await untilAborted(check(tool, input, tab), signal, () => new Error("cancelled"));
      } catch (cause) {
        return textExecution(describeError(cause), true);
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
        return textExecution(bounced, true);
      }
    }
    await adoptPopups();
    return execution;
  };

  return {
    tabId: mainId,
    startUrl,
    tools: BROWSE_TOOL_DEFINITIONS,
    validate: (use) => {
      const tool = browseTool(use.name);
      return tool
        ? validated(browseInputOf(tool).safeParse(use.input))
        : { ok: false, error: `Unknown tool ${use.name}.` };
    },
    run,
    newTabsNote: () => (notes.length ? notes.splice(0).join("\n") : undefined),
    currentUrl: () => manager.peekTab(mainId)?.page.url(),
    close: async () => {
      if (callerTab) delete callerTab.browse;
      const late = manager
        .listTabs()
        .filter(
          (tab) =>
            tab.openerId !== undefined && tabs.has(tab.openerId) && tab.createdAt >= startedAt,
        );
      for (const tab of late) opened.add(tab.id);
      await inSequence([...opened], closeOne);
      opened.clear();
    },
  };
}
