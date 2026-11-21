import vm from "node:vm";
import { z } from "zod";
import type { Locator, Page } from "playwright-core";
import type { BrowserManager } from "../browser/manager.ts";
import { recordFault } from "../log/faults.ts";
import { ToolError } from "../shared/errors.ts";
import { extractPage } from "../page/extract.ts";
import type { OutputStore, Redactor } from "../shared/output.ts";
import { pageLinks, pageText, rawSnapshot } from "../page/page.ts";
import { registerSecret, type SecretField, type SecretStore } from "../shared/secrets.ts";
import { interactiveOnly } from "../page/snapshot.ts";
import { type CompareOptions, compareDesign } from "../visual/compare.ts";
import type { Tab } from "../browser/tab.ts";
import type { AskAdapterSource } from "../ask/adapter-source.ts";
import { ScriptClock } from "./clock.ts";
import { type Callable, isText, isThenable, ScriptGuard } from "./guard.ts";

export type ScriptDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  ask?: AskAdapterSource;
};

type ScriptOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
};

type ScriptResult = {
  returned: string;
  logs: string[];
};

const jsonTextOr = (space: number | undefined) =>
  z.unknown().transform((value) => {
    try {
      return JSON.stringify(value, null, space) ?? String(value);
    } catch {
      return String(value);
    }
  });

const logPartText = z.union([z.string(), jsonTextOr(undefined)]);

export const valueText = z.union([
  z.undefined().transform(() => "undefined"),
  z.string(),
  jsonTextOr(2),
]);

const withMessage = z.object({ message: z.unknown() });

function errorMessage(cause: unknown) {
  const error = withMessage.safeParse(cause);
  return error.success ? String(error.data.message) : logPartText.parse(cause);
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
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
  const guard = new ScriptGuard();
  const { signal } = guard.controller;
  const scriptAbort = new AbortController();
  const timers = new Set<NodeJS.Timeout>();
  const log = (...parts: unknown[]) => {
    const line = parts.map((part) => logPartText.parse(part)).join(" ");
    logs.push(line);
    options.onLog?.(line);
  };

  const safely =
    (callback: Callable<unknown>) =>
    (...args: unknown[]) => {
      try {
        const result = callback(...args);
        if (isThenable(result))
          Promise.resolve(result).catch((cause: unknown) =>
            log(`Error in a timer callback: ${errorMessage(cause)}`),
          );
      } catch (cause) {
        log(`Error in a timer callback: ${errorMessage(cause)}`);
      }
    };
  guard.onCallbackError = (label, cause) => {
    log(`Error in a ${label} callback: ${errorMessage(cause)}`);
    recordFault("run_script callback", cause);
  };
  const track = (timer: NodeJS.Timeout) => {
    timers.add(timer);
    return timer;
  };

  const pageOf = (candidate?: Page | string) => {
    if (isText(candidate)) return manager.getTab(candidate);
    const found = candidate ? manager.tabOf(guard.unwrap(candidate)) : tab;
    if (!found)
      throw new ToolError(
        "This script has no default tab.",
        "Pass tab to run_script, or call openTab(url) inside the script.",
      );
    return found;
  };

  const sandbox = {
    page: guard.wrap(tab?.page),
    context: guard.wrap(context),
    signal: scriptAbort.signal,
    tab: (id: string) => guard.wrap(manager.getTab(id).page),
    tabId: (page: Page) => manager.tabOf(guard.unwrap(page))?.id,
    openTab: guard.guard(async (url?: string) => {
      const created = await manager.openTab(owner);
      opened.add(created);
      if (url) await created.page.goto(url, { waitUntil: "domcontentloaded" });
      return guard.wrap(created.page);
    }),
    closeTab: guard.guard((candidate: Page | string) => manager.closeTab(pageOf(candidate).id)),
    ref: (ref: string, page?: Page | string) => guard.wrap(manager.locate(pageOf(page), ref)),
    snapshot: guard.guard(
      async (
        page?: Page | string,
        snapshotOptions: { interactive?: boolean; target?: string; depth?: number } = {},
      ) => {
        const full = await rawSnapshot(manager, pageOf(page), snapshotOptions);
        return snapshotOptions.interactive ? interactiveOnly(full) : full;
      },
    ),
    text: guard.guard((page?: Page | string, scope: "main" | "page" = "main") =>
      pageText(pageOf(page).page, scope),
    ),
    links: guard.guard((page?: Page | string, limit: number = 300) =>
      pageLinks(pageOf(page).page, limit),
    ),
    extract: guard.guard((page?: Page | string) => extractPage(pageOf(page).page)),
    compareDesign: guard.guard(
      async (
        page: Page | string | undefined,
        referencePath: string,
        compareOptions: Omit<CompareOptions, "signal"> = {},
      ) => {
        const { ask } = deps;
        if (!ask) throw new ToolError("compareDesign is not available in this script context.");
        const { text, ...report } = await compareDesign(
          { manager, store, ask },
          pageOf(page),
          referencePath,
          {
            ...compareOptions,
            target: guard.unwrap(compareOptions.target),
            signal,
          },
        );
        return { ...report, summary: text };
      },
    ),
    save: guard.guard((name: string, content: string | Buffer) =>
      store.write(
        "scripts",
        store.uniqueName(
          name,
          /\.[a-z0-9]{1,8}$/i.test(name) ? (name.split(".").pop() ?? "txt") : "txt",
        ),
        content,
      ),
    ),
    secrets: {
      list: guard.guard((query?: string) => secrets.list(query)),
      fill: guard.guard(
        async (target: Locator | string, name: string, field: SecretField = "password") => {
          const value = await secrets.get(name, field);
          registerSecret(redactor, name, field, value);
          const locator = isText(target) ? await manager.resolve(pageOf(), target) : target;
          await locator.fill(value);
        },
      ),
    },
    sleep: (ms: number) => clock.adopt(abortableSleep(ms, signal).finally(() => clock.queuePump())),
    log,
    console: { log, info: log, warn: log, error: log, debug: log },
    setTimeout: (callback: Callable<unknown>, ms?: number, ...args: unknown[]) =>
      track(setTimeout(() => clock.enter(safely(callback), args), ms)),
    clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
    setInterval: (callback: Callable<unknown>, ms?: number, ...args: unknown[]) =>
      track(setInterval(() => clock.enter(safely(callback), args), ms)),
    clearInterval: (timer: NodeJS.Timeout) => clearInterval(timer),
    URL,
    URLSearchParams,
    fetch: (input: string | URL | Request, init?: RequestInit) =>
      clock.adopt(
        fetch(guard.unwrap(input), {
          ...init,
          body: guard.unwrap(init?.body),
          signal: init?.signal ?? signal,
        })
          .then((response) => guard.wrap(response))
          .finally(() => clock.queuePump()),
      ),
    Buffer,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone,
  };

  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "run_script.js" });
  const clock = new ScriptClock(
    vm.createContext(sandbox, { microtaskMode: "afterEvaluate" }),
    guard,
    options.timeoutMs,
  );
  guard.adopt = (pending) => clock.adopt(pending);
  guard.invoke = (fn, args) => clock.enter(fn, args);
  guard.settled = () => clock.queuePump();
  signal.addEventListener(
    "abort",
    () => {
      try {
        clock.bounded(() => scriptAbort.abort(signal.reason));
      } catch (cause) {
        recordFault("run_script abort listener", cause);
      }
    },
    { once: true },
  );
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  stopped.catch(() => undefined);
  if (options.timeoutMs !== undefined) {
    const { timeoutMs } = options;
    timer = setTimeout(
      () =>
        guard.halt({ reason: "timeout", message: `run_script timed out after ${timeoutMs} ms.` }),
      timeoutMs,
    );
  }
  const onCancel = () => guard.halt({ reason: "cancelled", message: "The script was cancelled." });
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const pending = clock.run(script);
    if (isThenable(pending)) void pending.then(undefined, () => undefined);
    const value = await Promise.race([pending, stopped]);
    return { returned: clock.bounded(() => valueText.parse(value)) ?? "undefined", logs };
  } catch (cause) {
    const stop = guard.stop;
    if (stop) {
      await Promise.allSettled(
        [...opened]
          .filter((candidate) => !candidate.page.isClosed())
          .map((candidate) => manager.closeTab(candidate.id)),
      );
      const closed = opened.size ? ` Closed ${opened.size} tab(s) it opened.` : "";
      const hint =
        "Its next browser call, sleep or timer failed and calls already in flight were left to finish.";
      const advice =
        stop.reason === "blocked"
          ? "Synchronous code runs on the server's only thread; await something (such as await sleep(0)) inside long loops, or move heavy computation into the page with page.evaluate."
          : stop.reason === "timeout"
            ? `${hint} Raise timeout_ms, split the work, or run it with background: true.`
            : hint;
      throw new ToolError(
        `${stop.message}${closed}${logs.length ? `\nLogs so far:\n${logs.join("\n")}` : ""}`,
        advice,
      );
    }
    if (cause instanceof ToolError || logs.length === 0) throw cause;
    const error = withMessage.safeParse(cause);
    const reason = error.success ? String(error.data.message) : String(cause);
    throw new Error(`${reason}\nLogs before the error:\n${logs.join("\n")}`, { cause });
  } finally {
    clock.finish();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    guard.halt({
      reason: "ended",
      message: "The script has already ended; browser objects from it can no longer be used.",
    });
    for (const pendingTimer of timers) clearTimeout(pendingTimer);
    await guard.release();
  }
}
