import vm from "node:vm";
import type { Locator, Page } from "playwright-core";
import type { BrowserManager, Tab } from "./browser.ts";
import { ToolError } from "./errors.ts";
import { extractPage } from "./extract.ts";
import type { OutputStore, Redactor } from "./output.ts";
import { pageLinks, pageText, rawSnapshot } from "./page.ts";
import type { SecretField, SecretStore } from "./secrets.ts";
import { interactiveOnly } from "./snapshot.ts";

export type ScriptDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
};

export type ScriptOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
};

export type ScriptResult = {
  value: unknown;
  logs: string[];
};

function formatLogPart(part: unknown) {
  if (typeof part === "string") return part;
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
}

export function serializeValue(value: unknown) {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolError("The script was cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ToolError("The script was cancelled."));
      },
      { once: true },
    );
  });
}

export async function runScript(
  deps: ScriptDeps,
  owner: string,
  tab: Tab | undefined,
  code: string,
  options: ScriptOptions = {},
): Promise<ScriptResult> {
  const { manager, store, secrets, redactor } = deps;
  const context = await manager.ensureContext();
  const logs: string[] = [];
  const opened = new Set<Tab>();
  const log = (...parts: unknown[]) => {
    const line = parts.map(formatLogPart).join(" ");
    logs.push(line);
    options.onLog?.(line);
  };

  const pageOf = (candidate?: Page | string) => {
    if (typeof candidate === "string") return manager.getTab(candidate);
    const found = candidate ? manager.tabOf(candidate) : tab;
    if (!found) throw new ToolError("This script has no default tab.", "Pass tab to run_script, or call openTab(url) inside the script.");
    return found;
  };

  const sandbox = {
    page: tab?.page,
    context,
    signal: options.signal,
    tab: (id: string) => manager.getTab(id).page,
    tabId: (page: Page) => manager.tabOf(page)?.id,
    openTab: async (url?: string) => {
      const created = await manager.openTab(owner);
      opened.add(created);
      if (url) await created.page.goto(url, { waitUntil: "domcontentloaded" });
      return created.page;
    },
    closeTab: (candidate: Page | string) => manager.closeTab(pageOf(candidate).id),
    ref: (ref: string, page?: Page | string) => manager.locate(pageOf(page), ref),
    snapshot: async (page?: Page | string, snapshotOptions: { interactive?: boolean; target?: string; depth?: number } = {}) => {
      const full = await rawSnapshot(manager, pageOf(page), snapshotOptions);
      return snapshotOptions.interactive ? interactiveOnly(full) : full;
    },
    text: (page?: Page | string, scope: "main" | "page" = "main") => pageText(pageOf(page).page, scope),
    links: (page?: Page | string, limit = 300) => pageLinks(pageOf(page).page, limit),
    extract: (page?: Page | string) => extractPage(pageOf(page).page),
    save: (name: string, content: string | Buffer) => store.write("scripts", store.uniqueName(name, name.split(".").pop() ?? "txt"), content),
    secrets: {
      list: (query?: string) => secrets.list(query),
      fill: async (target: Locator | string, name: string, field: SecretField = "password") => {
        const value = await secrets.get(name, field);
        redactor.register(`${name}:${field}`, value);
        const locator = typeof target === "string" ? await manager.resolve(pageOf(), target) : target;
        await locator.fill(value);
      },
    },
    sleep: (ms: number) => abortableSleep(ms, options.signal),
    log,
    console: { log, info: log, warn: log, error: log, debug: log },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    URLSearchParams,
    fetch,
    Buffer,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone,
  };

  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "run_script.js" });
  let timer: NodeJS.Timeout | undefined;
  const races: Promise<never>[] = [];
  if (options.timeoutMs !== undefined) {
    const { timeoutMs } = options;
    races.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ToolError(
              `run_script timed out after ${timeoutMs} ms.${logs.length ? `\nLogs so far:\n${logs.join("\n")}` : ""}`,
              "Browser calls already started may still finish. Raise timeout_ms, split the work, or run it with background: true.",
            ),
          );
        }, timeoutMs);
      }),
    );
  }
  if (options.signal) {
    const { signal } = options;
    races.push(
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new ToolError("The script was cancelled.")), { once: true });
      }),
    );
  }

  try {
    const pending = script.runInNewContext(sandbox, { timeout: options.timeoutMs }) as Promise<unknown>;
    const value = await Promise.race([pending, ...races]);
    return { value, logs };
  } catch (error) {
    if (options.signal?.aborted) {
      await Promise.allSettled([...opened].filter((candidate) => !candidate.page.isClosed()).map((candidate) => manager.closeTab(candidate.id)));
    }
    if (error instanceof ToolError || logs.length === 0) throw error;
    const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    throw new Error(`${reason}\nLogs before the error:\n${logs.join("\n")}`);
  } finally {
    clearTimeout(timer);
  }
}
