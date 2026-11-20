import vm from "node:vm";
import type { Locator, Page } from "playwright-core";
import type { AskAdapterSource } from "./ask.ts";
import type { BrowserManager, Tab } from "./browser.ts";
import { recordFault, ToolError } from "./errors.ts";
import { extractPage } from "./extract.ts";
import type { OutputStore, Redactor } from "./output.ts";
import { pageLinks, pageText, rawSnapshot } from "./page.ts";
import type { SecretField, SecretStore } from "./secrets.ts";
import { interactiveOnly } from "./snapshot.ts";
import { type CompareOptions, compareDesign } from "./visual.ts";

export type ScriptDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  ask?: AskAdapterSource;
};

export const OTP_MASK_MS = 2 * 60 * 1000;

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

const SYNC_METHODS = new Set([
  "locator", "getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByAltText", "getByTitle", "getByTestId",
  "first", "last", "nth", "filter", "and", "or", "frameLocator", "contentFrame", "owner", "describe",
  "url", "mainFrame", "frames", "frame", "parentFrame", "childFrames", "isDetached", "isClosed", "name", "page", "context", "pages",
  "browser", "viewportSize", "on", "off", "once", "addListener", "removeListener", "removeAllListeners", "listenerCount",
  "request", "headers", "method", "postData", "postDataBuffer", "postDataJSON", "resourceType", "status", "statusText", "ok",
  "timing", "failure", "redirectedFrom", "redirectedTo", "toString", "valueOf", "toJSON",
]);
const WRAPPED_CLASSES = new Set([
  "Page", "BrowserContext", "Frame", "Locator", "FrameLocator", "ElementHandle", "JSHandle", "Keyboard", "Mouse", "Touchscreen",
  "APIRequestContext", "APIResponse", "Response", "Request", "Route", "Download", "Dialog", "FileChooser", "Clock", "Tracing", "Worker",
]);
const SERIALIZED_ARGUMENT_METHODS = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval", "evaluateAll", "addInitScript", "waitForFunction"]);
const LISTENER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener"]);
const IGNORED_ABORT_CALLS = 20;
const ABORTED_CALL_DELAY_MS = 50;

export type ScriptStop = { reason: "cancelled" | "timeout" | "ended"; message: string };

class ScriptGuard {
  readonly controller = new AbortController();
  private readonly proxies = new WeakMap<object, object>();
  private readonly targets = new WeakMap<object, object>();
  private readonly callbacks = new WeakMap<object, (...args: unknown[]) => unknown>();
  private rejectedCalls = 0;
  stop?: ScriptStop;
  onCallbackError: (label: string, error: unknown) => void = () => undefined;

  get stopped() {
    return this.stop !== undefined;
  }

  halt(stop: ScriptStop) {
    if (this.stop) return;
    this.stop = stop;
    this.controller.abort(new ToolError(stop.message));
  }

  error() {
    return new ToolError(this.stop?.message ?? "The script was stopped.");
  }

  refused<T>(): Promise<T> {
    this.rejectedCalls += 1;
    if (this.rejectedCalls > IGNORED_ABORT_CALLS) return new Promise<T>(() => undefined);
    return new Promise<T>((_resolve, reject) => setTimeout(() => reject(this.error()), ABORTED_CALL_DELAY_MS));
  }

  unwrap<T>(value: T): T {
    if (value && typeof value === "object") return (this.targets.get(value) as T | undefined) ?? value;
    return value;
  }

  private callback(label: string, fn: (...args: unknown[]) => unknown) {
    const existing = this.callbacks.get(fn);
    if (existing) return existing;
    const wrapped = (...args: unknown[]) => {
      const failed = (error: unknown) => {
        this.onCallbackError(label, error);
        if (label === "route") void (args[0] as { fallback?: () => Promise<void> } | undefined)?.fallback?.().catch(() => undefined);
        return undefined;
      };
      try {
        const result = fn(...args.map((arg) => this.wrap(arg)));
        if (isThenable(result)) return Promise.resolve(result).catch(failed);
        return result;
      } catch (error) {
        return failed(error);
      }
    };
    this.callbacks.set(fn, wrapped);
    return wrapped;
  }

  private prepare(method: string, args: unknown[]) {
    const label = LISTENER_METHODS.has(method) && typeof args[0] === "string" ? args[0] : method;
    return args.map((arg) => {
      if (typeof arg === "function" && !SERIALIZED_ARGUMENT_METHODS.has(method)) return this.callback(label, arg as (...input: unknown[]) => unknown);
      if (isPlainObject(arg) && typeof arg.predicate === "function") return { ...arg, predicate: this.callback(label, arg.predicate as (...input: unknown[]) => unknown) };
      return this.unwrap(arg);
    });
  }

  wrap<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => this.wrap(item)) as T;
    if (!value || typeof value !== "object") return value;
    if (this.targets.has(value)) return value;
    if (!WRAPPED_CLASSES.has(((value as object).constructor?.name ?? "").replace(/^_+|\d+$/g, ""))) return value;
    const target = value as object;
    const existing = this.proxies.get(target);
    if (existing) return existing as T;
    const proxy = new Proxy(target, {
      get: (object, property, receiver) => {
        const member = Reflect.get(object, property, receiver === proxy ? object : receiver) as unknown;
        if (typeof property === "symbol" || property.startsWith("_")) return member;
        if (typeof member !== "function") return this.wrap(member);
        return (...args: unknown[]) => {
          if (this.stopped && !SYNC_METHODS.has(property)) return this.refused();
          const result = (member as (...input: unknown[]) => unknown).apply(object, this.prepare(property, args));
          if (result instanceof Promise) return result.then((resolved) => this.wrap(resolved));
          return this.wrap(result);
        };
      },
    });
    this.proxies.set(target, proxy);
    this.targets.set(proxy, target);
    return proxy as T;
  }

  guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> => (this.stopped ? this.refused<R>() : fn(...(args.map((arg) => this.unwrap(arg)) as A)));
  }
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return formatLogPart(error);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value) && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === null || Object.getPrototypeOf(prototype) === null;
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
  const timers = new Set<NodeJS.Timeout>();
  const log = (...parts: unknown[]) => {
    const line = parts.map(formatLogPart).join(" ");
    logs.push(line);
    options.onLog?.(line);
  };

  const safely = (callback: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    try {
      const result = callback(...args);
      if (isThenable(result)) Promise.resolve(result).catch((error: unknown) => log(`Error in a timer callback: ${errorMessage(error)}`));
    } catch (error) {
      log(`Error in a timer callback: ${errorMessage(error)}`);
    }
  };
  guard.onCallbackError = (label, error) => {
    log(`Error in a ${label} callback: ${errorMessage(error)}`);
    recordFault("run_script callback", error);
  };
  const track = (timer: NodeJS.Timeout) => {
    timers.add(timer);
    return timer;
  };

  const pageOf = (candidate?: Page | string) => {
    if (typeof candidate === "string") return manager.getTab(candidate);
    const found = candidate ? manager.tabOf(guard.unwrap(candidate)) : tab;
    if (!found) throw new ToolError("This script has no default tab.", "Pass tab to run_script, or call openTab(url) inside the script.");
    return found;
  };

  const sandbox = {
    page: guard.wrap(tab?.page),
    context: guard.wrap(context),
    signal,
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
    snapshot: guard.guard(async (page?: Page | string, snapshotOptions: { interactive?: boolean; target?: string; depth?: number } = {}) => {
      const full = await rawSnapshot(manager, pageOf(page), snapshotOptions);
      return snapshotOptions.interactive ? interactiveOnly(full) : full;
    }),
    text: guard.guard((page?: Page | string, scope: "main" | "page" = "main") => pageText(pageOf(page).page, scope)),
    links: guard.guard((page?: Page | string, limit: number = 300) => pageLinks(pageOf(page).page, limit)),
    extract: guard.guard((page?: Page | string) => extractPage(pageOf(page).page)),
    compareDesign: guard.guard(async (page: Page | string | undefined, referencePath: string, compareOptions: Omit<CompareOptions, "signal"> = {}) => {
      const { ask } = deps;
      if (!ask) throw new ToolError("compareDesign is not available in this script context.");
      const { text, ...report } = await compareDesign({ manager, store, ask }, pageOf(page), referencePath, {
        ...compareOptions,
        target: compareOptions.target && typeof compareOptions.target !== "string" ? guard.unwrap(compareOptions.target) : compareOptions.target,
        signal,
      });
      return { ...report, summary: text };
    }),
    save: guard.guard((name: string, content: string | Buffer) =>
      store.write("scripts", store.uniqueName(name, /\.[a-z0-9]{1,8}$/i.test(name) ? (name.split(".").pop() ?? "txt") : "txt"), content),
    ),
    secrets: {
      list: guard.guard((query?: string) => secrets.list(query)),
      fill: guard.guard(async (target: Locator | string, name: string, field: SecretField = "password") => {
        const value = await secrets.get(name, field);
        registerSecret(redactor, name, field, value);
        const locator = typeof target === "string" ? await manager.resolve(pageOf(), target) : target;
        await locator.fill(value);
      }),
    },
    sleep: (ms: number) => abortableSleep(ms, signal),
    log,
    console: { log, info: log, warn: log, error: log, debug: log },
    setTimeout: (callback: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => track(setTimeout(() => safely(callback)(...args), ms)),
    clearTimeout: (timer: NodeJS.Timeout) => clearTimeout(timer),
    setInterval: (callback: (...args: unknown[]) => unknown, ms?: number, ...args: unknown[]) => track(setInterval(() => safely(callback)(...args), ms)),
    clearInterval: (timer: NodeJS.Timeout) => clearInterval(timer),
    URL,
    URLSearchParams,
    fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, { ...init, signal: init?.signal ?? signal }),
    Buffer,
    TextEncoder,
    TextDecoder,
    AbortController,
    structuredClone,
  };

  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: "run_script.js" });
  let timer: NodeJS.Timeout | undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  stopped.catch(() => undefined);
  if (options.timeoutMs !== undefined) {
    const { timeoutMs } = options;
    timer = setTimeout(() => guard.halt({ reason: "timeout", message: `run_script timed out after ${timeoutMs} ms.` }), timeoutMs);
  }
  const onCancel = () => guard.halt({ reason: "cancelled", message: "The script was cancelled." });
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const pending = script.runInNewContext(sandbox, { timeout: options.timeoutMs }) as Promise<unknown>;
    pending.catch(() => undefined);
    const value = await Promise.race([pending, stopped]);
    return { value, logs };
  } catch (error) {
    const stop = guard.stop;
    if (stop) {
      await Promise.allSettled([...opened].filter((candidate) => !candidate.page.isClosed()).map((candidate) => manager.closeTab(candidate.id)));
      const closed = opened.size ? ` Closed ${opened.size} tab(s) it opened.` : "";
      const hint = "Its next browser call, sleep or timer failed and calls already in flight were left to finish.";
      throw new ToolError(`${stop.message}${closed}${logs.length ? `\nLogs so far:\n${logs.join("\n")}` : ""}`, stop.reason === "timeout" ? `${hint} Raise timeout_ms, split the work, or run it with background: true.` : hint);
    }
    if (error instanceof ToolError || logs.length === 0) throw error;
    const reason = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
    throw new Error(`${reason}\nLogs before the error:\n${logs.join("\n")}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    guard.halt({ reason: "ended", message: "The script has already ended; browser objects from it can no longer be used." });
    for (const pendingTimer of timers) clearTimeout(pendingTimer);
  }
}

export function registerSecret(redactor: Redactor, name: string, field: SecretField, value: string) {
  if (field === "username") return;
  redactor.register(`${name}:${field}`, value, field === "otp" ? OTP_MASK_MS : undefined);
}
