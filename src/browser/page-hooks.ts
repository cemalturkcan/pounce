import { z } from "zod";
import type { ConsoleHookMode, Engine } from "../config/config.ts";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";
import { evaluateMain } from "./evaluate.ts";
import {
  CONSOLE_LIMIT,
  type ConsoleEntry,
  consoleEntrySchema,
  pushBounded,
  pushEvent,
  type Tab,
} from "./tab.ts";

export const PASSKEY_KEY = "webAgent.passkey";

const hookedConsoleSchema = z.array(z.unknown()).optional();

const passkeyCallsSchema = z.array(z.string());

type PageHookState = ConsoleEntry[] | string[] | Float64Array;

declare global {
  interface Window {
    [key: symbol]: PageHookState | undefined;
  }
}

export function installConsoleHook(mode: ConsoleHookMode) {
  const host = location.hostname;
  const isLocal =
    /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /\.(localhost|test)$/.test(host);
  if (mode === "off" || (mode === "local" && !isLocal)) return;
  const key = Symbol.for("web-agent-mcp.console");
  if (key in window) return;
  const buffer: { level: string; text: string; time: string }[] = [];
  Object.defineProperty(window, key, { value: buffer });
  type PageValue = string | number | bigint | boolean | symbol | object | null | undefined;
  const values = {
    isText(part: PageValue): part is string {
      return typeof part === "string";
    },
  };
  const record = (level: string, parts: PageValue[]) => {
    const text = parts
      .map((part) => {
        if (values.isText(part)) return part;
        if (part instanceof Error) return part.stack ?? part.message;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ")
      .slice(0, 2000);
    buffer.push({ level, text, time: new Date().toISOString() });
    if (buffer.length > 300) buffer.shift();
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: PageValue[]) => {
      record(level, parts);
      original(...parts);
    };
  }
  window.addEventListener("error", (event) =>
    record("error", [event.message, event.filename, event.lineno]),
  );
  window.addEventListener("unhandledrejection", (event) =>
    record("error", ["Unhandled rejection:", event.reason]),
  );
}

export function installPasskeyHook(key: string) {
  const symbol = Symbol.for(key);
  if (symbol in window || !("CredentialsContainer" in window)) return;
  const container = CredentialsContainer.prototype;
  const calls: string[] = [];
  Object.defineProperty(window, symbol, { value: calls });
  const note = (
    method: "get" | "create",
    options: CredentialRequestOptions | CredentialCreationOptions | undefined,
  ) => {
    if (!options?.publicKey || ("mediation" in options && options.mediation === "conditional"))
      return;
    calls.push(method);
    if (calls.length > 20) calls.shift();
  };
  container.get = new Proxy(container.get, {
    apply(target, thisArg, args: [CredentialRequestOptions?]) {
      note("get", args[0]);
      return target.call(thisArg, ...args);
    },
  });
  container.create = new Proxy(container.create, {
    apply(target, thisArg, args: [CredentialCreationOptions?]) {
      note("create", args[0]);
      return target.call(thisArg, ...args);
    },
  });
}

export async function drainConsole(engine: Engine, tab: Tab) {
  const hooked = await evaluateMain(
    engine,
    tab.page,
    `(() => { const b = window[Symbol.for("web-agent-mcp.console")]; return Array.isArray(b) ? b.splice(0, b.length) : undefined; })()`,
    hookedConsoleSchema,
  ).catch(() => undefined);
  for (const raw of hooked ?? []) {
    const entry = consoleEntrySchema.safeParse(raw);
    if (entry.success) pushBounded(tab.console, entry.data, CONSOLE_LIMIT);
  }
  return tab.console;
}

export async function drainPasskeyRequests(engine: Engine, tab: Tab) {
  const calls = await withDeadline(
    evaluateMain(
      engine,
      tab.page,
      `(() => { const calls = window[Symbol.for(${JSON.stringify(PASSKEY_KEY)})]; return Array.isArray(calls) ? calls.splice(0, calls.length) : []; })()`,
      passkeyCallsSchema,
    ),
    1500,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  if (calls !== TIMED_OUT && calls.length)
    pushEvent(tab, "the page requested a passkey or security key; use handoff");
}
