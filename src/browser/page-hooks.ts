import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CDPSession, Disposable } from "playwright-core";
import type { Config, ConsoleHookMode, Engine } from "../config/config.ts";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";
import { parseJson } from "../shared/decode.ts";
import { evaluateMain } from "./evaluate.ts";
import {
  type ConsoleEntry,
  consoleEntrySchema,
  deliveryDocument,
  pushEvent,
  stackSource,
  type Tab,
  upsertConsole,
} from "./tab.ts";

export const PASSKEY_KEY = "webAgent.passkey";

const passkeyCallsSchema = z.array(z.string());

type PageHookState = ConsoleEntry[] | string[] | Float64Array | Uint8Array;

declare global {
  interface Window {
    [key: symbol]: PageHookState | undefined;
  }
}

export const ERROR_CHANNEL = `web-agent-${randomUUID()}`;

const CHANNEL_WORLD = "web-agent-errors";

export const consoleHookMode = (config: Pick<Config, "engine" | "consoleHook">): ConsoleHookMode =>
  config.engine === "playwright" ? "off" : config.consoleHook;

type InitScriptHost = {
  addInitScript(
    script: typeof installConsoleHook,
    input: ConsoleHookInput,
  ): Promise<Pick<Disposable, "dispose">>;
};

export class ConsoleHookScript {
  private context?: InitScriptHost;
  private installed?: Pick<Disposable, "dispose">;
  private chosen: string[] = [];
  private turn = Promise.resolve();
  private readonly mode: ConsoleHookMode;

  constructor(mode: ConsoleHookMode) {
    this.mode = mode;
  }

  get sites(): readonly string[] {
    return this.chosen;
  }

  async apply(context: InitScriptHost, sites: string[]) {
    this.context = context;
    this.chosen = sites;
    this.installed = await this.install(context);
  }

  choose(readSites: () => Promise<string[]>) {
    const turn = this.turn.then(async () => {
      this.chosen = await readSites();
      const { context } = this;
      if (!context) return;
      const previous = this.installed;
      this.installed = undefined;
      await previous?.dispose();
      this.installed = await this.install(context);
    });
    this.turn = turn.catch(() => undefined);
    return turn;
  }

  forget() {
    this.context = undefined;
    this.installed = undefined;
  }

  private install(context: InitScriptHost) {
    return context.addInitScript(installConsoleHook, {
      mode: this.mode,
      channel: ERROR_CHANNEL,
      sites: this.chosen,
    });
  }
}

type ConsoleHookInput = { mode: ConsoleHookMode; channel: string; sites: string[] };

export function installConsoleHook({ mode, channel, sites }: ConsoleHookInput) {
  if (mode === "off") return;
  const host = location.hostname;
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test") ||
    sites.some((site) => host === site || host.endsWith(`.${site}`));
  const key = Symbol.for("web-agent-mcp.console");
  if (key in window) return;
  type PageValue = string | number | bigint | boolean | symbol | object | null | undefined;
  const call = Function.prototype.call;
  const channelNative = {
    assign: Object.assign,
    create: Object.create,
    dispatch: call.bind(EventTarget.prototype.dispatchEvent),
    listen: call.bind(EventTarget.prototype.addEventListener),
    CustomEvent,
  };
  const send = (name: string, detail: string) => {
    const init: CustomEventInit<string> = channelNative.assign(channelNative.create(null), {
      detail,
    });
    channelNative.dispatch(window, new channelNative.CustomEvent(`${channel}-${name}`, init));
  };
  const answerAsks = (take: () => string) =>
    channelNative.listen(window, `${channel}-ask`, () => send("answer", take()));
  const replayOnRequest = (take: () => string) =>
    channelNative.listen(window, `${channel}-replay`, () => {
      const lines = take();
      if (lines) send("push", lines);
    });
  const captureErrors = () => {
    const native = {
      describe: Object.getOwnPropertyDescriptor,
      hasOwn: Object.hasOwn,
      text: String,
      json: JSON.stringify,
      Date,
      NativeError: Error,
      toIso: call.bind(Date.prototype.toISOString),
      slice: call.bind(String.prototype.slice),
      create: Object.create,
      protoOf: Object.getPrototypeOf,
    };
    const brandCheck: PageValue = native.describe(native.NativeError, "isError")?.value;
    const getterOf = (owner: ErrorEvent | PromiseRejectionEvent | DOMException, name: string) => {
      const getter = native.describe(owner, name)?.get;
      return getter ? call.bind(getter) : () => undefined;
    };
    const errorEvent = {
      message: getterOf(ErrorEvent.prototype, "message"),
      filename: getterOf(ErrorEvent.prototype, "filename"),
      lineno: getterOf(ErrorEvent.prototype, "lineno"),
      colno: getterOf(ErrorEvent.prototype, "colno"),
    };
    const reasonOf = getterOf(PromiseRejectionEvent.prototype, "reason");
    const domException = {
      prototype: DOMException.prototype,
      name: getterOf(DOMException.prototype, "name"),
      message: getterOf(DOMException.prototype, "message"),
    };
    const stackGetter = native.describe(new native.NativeError(), "stack")?.get;
    const stackOf = stackGetter ? call.bind(stackGetter) : () => undefined;
    const guards = {
      isText(value: PageValue): value is string {
        return typeof value === "string";
      },
      isPrimitive(value: PageValue): value is string | number | bigint | boolean | symbol {
        return value === null || (typeof value !== "object" && typeof value !== "function");
      },
      isBrandCheck(value: PageValue): value is (candidate: PageValue) => boolean {
        return typeof value === "function";
      },
    };
    const isError = (value: PageValue) =>
      guards.isBrandCheck(brandCheck) && brandCheck(value) === true;
    type HeldEntry = {
      id: number;
      time: string;
      rejected: boolean;
      text: string;
      source: string | undefined;
      reason: PageValue;
    };
    const LIMIT = 300;
    const emptySlots = (): HeldEntry[] => native.create(null);
    const held = { slots: emptySlots(), first: 0, next: 0 };
    const lineOf = (entry: HeldEntry, quiet: boolean) => {
      const text = entry.rejected
        ? `Unhandled rejection: ${reasonText(entry.reason, quiet)}`
        : entry.text;
      const located = entry.source === undefined ? "" : `,"source":${native.json(entry.source)}`;
      return `{"id":${entry.id},"level":"error","text":${native.json(native.slice(text, 0, 2000))},"time":${native.json(entry.time)}${located}}`;
    };
    const keep = (entry: Omit<HeldEntry, "time" | "id">) => {
      const kept: HeldEntry = { ...entry, id: held.next, time: native.toIso(new native.Date()) };
      held.slots[held.next % LIMIT] = kept;
      held.next += 1;
      if (held.next - held.first > LIMIT) held.first = held.next - LIMIT;
      send("push", lineOf(kept, true));
    };
    const ownData = (target: PageValue, name: string) => {
      const descriptor = native.describe(target, name);
      const value: PageValue =
        descriptor && native.hasOwn(descriptor, "value") ? descriptor.value : undefined;
      return guards.isText(value) ? value : undefined;
    };
    const ownText = (target: PageValue, name: string) => {
      const descriptor = native.describe(target, name);
      if (!descriptor) return undefined;
      const value: PageValue = native.hasOwn(descriptor, "value") ? descriptor.value : undefined;
      if (guards.isText(value)) return value;
      if (!stackGetter || !native.hasOwn(descriptor, "get") || descriptor.get !== stackGetter)
        return undefined;
      if (native.describe(native.NativeError, "prepareStackTrace") !== undefined) return undefined;
      const stack: PageValue = stackOf(target);
      return guards.isText(stack) ? stack : undefined;
    };
    const quietText = (reason: PageValue) => {
      if (!isError(reason)) return undefined;
      const own = ownData(reason, "message");
      if (own !== undefined) return own;
      if (native.protoOf(reason) !== domException.prototype) return undefined;
      return `${native.text(domException.name(reason))}: ${native.text(domException.message(reason))}`;
    };
    const reasonText = (reason: PageValue, quiet: boolean) => {
      if (guards.isPrimitive(reason)) return native.text(reason);
      if (quiet) return quietText(reason) ?? "(an object)";
      return ownText(reason, "stack") ?? ownText(reason, "message") ?? "(an object)";
    };
    const heldLines = (quiet: boolean) => {
      let lines = "";
      for (let index = held.first; index < held.next; index += 1) {
        const entry = held.slots[index % LIMIT];
        if (entry) lines += `${lineOf(entry, quiet)}\n`;
      }
      return lines;
    };
    replayOnRequest(() => heldLines(true));
    answerAsks(() => {
      const lines = heldLines(false);
      held.slots = emptySlots();
      held.first = held.next;
      return lines;
    });
    window.addEventListener("error", (event) => {
      try {
        const message = native.text(errorEvent.message(event));
        const filename = native.text(errorEvent.filename(event));
        const lineno = native.text(errorEvent.lineno(event));
        const colno = native.text(errorEvent.colno(event));
        const source = filename ? `${filename}:${lineno}:${colno}` : undefined;
        keep({
          rejected: false,
          text: source === undefined ? message : `${message}\n    at ${source}`,
          source,
          reason: undefined,
        });
      } catch {
        return;
      }
    });
    window.addEventListener("unhandledrejection", (event) => {
      try {
        keep({ rejected: true, text: "", source: undefined, reason: reasonOf(event) });
      } catch {
        return;
      }
    });
  };
  if (mode === "local" && !isLocal) {
    captureErrors();
    return;
  }
  const buffer: { id: number; level: string; text: string; time: string; source?: string }[] = [];
  let recorded = 0;
  Object.defineProperty(window, key, { value: buffer });
  replayOnRequest(() => buffer.map((entry) => JSON.stringify(entry)).join("\n"));
  answerAsks(() =>
    buffer
      .splice(0, buffer.length)
      .map((entry) => {
        try {
          return JSON.stringify(entry);
        } catch {
          return "";
        }
      })
      .join("\n"),
  );
  const values = {
    isText(part: PageValue): part is string {
      return typeof part === "string";
    },
    frameAt(stack: string | undefined, index: number) {
      const body = /^\s+at (.+)$/.exec(stack?.split("\n")[index] ?? "")?.[1];
      if (body === undefined) return undefined;
      const opening = body.indexOf(" (");
      const location =
        /^[a-z][\w+.-]*:/i.test(body) || opening === -1
          ? body
          : body.slice(opening + 2).replace(/\)$/, "");
      return /:\d+:\d+$/.test(location) ? location : undefined;
    },
  };
  const record = (level: string, parts: PageValue[], source?: string) => {
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
    const entry = { id: recorded, level, text, time: new Date().toISOString(), source };
    recorded += 1;
    buffer.push(entry);
    if (buffer.length > 300) buffer.shift();
    send("push", JSON.stringify(entry));
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: PageValue[]) => {
      const located = level === "error" || level === "warn";
      record(level, parts, located ? values.frameAt(new Error().stack, 2) : undefined);
      original(...parts);
    };
  }
  window.addEventListener("error", (event) => {
    const source = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined;
    record(
      "error",
      [source === undefined ? event.message : `${event.message}\n    at ${source}`],
      source,
    );
  });
  window.addEventListener("unhandledrejection", (event) =>
    record(
      "error",
      ["Unhandled rejection:", event.reason],
      event.reason instanceof Error ? values.frameAt(event.reason.stack, 1) : undefined,
    ),
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

export function rejectionSource(text: string) {
  return text.startsWith("Unhandled rejection: ") ? stackSource(text) : undefined;
}

const CHANNEL_RETRY_MS = 100;
const CHANNEL_RETRIES = 10;

const keyedEntrySchema = consoleEntrySchema.extend({ id: z.number().optional() });
const deliverySchema = z.object({
  url: z.string(),
  token: z.string().optional(),
  text: z.string().optional(),
});
const deliveriesSchema = z.array(deliverySchema);
type Delivery = z.infer<typeof deliverySchema>;

function installChannelWorld(channel: string) {
  if (window !== top) return;
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
    part.toString(36),
  ).join("");
  const queue: { url: string; token: string; text: string }[] = [];
  let wake: (() => void) | undefined;
  type ChannelValue = string | number | boolean | object | null | undefined;
  const guards = {
    isText(value: ChannelValue): value is string {
      return typeof value === "string";
    },
  };
  addEventListener(`${channel}-push`, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: ChannelValue = event.detail;
    if (!guards.isText(detail)) return;
    queue.push({ url: location.href, token, text: detail });
    wake?.();
    wake = undefined;
  });
  dispatchEvent(new CustomEvent(`${channel}-replay`));
  Object.defineProperty(window, "webAgentToken", { value: token });
  Object.defineProperty(window, "webAgentNext", {
    value: async () => {
      if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
      return queue.splice(0, queue.length);
    },
  });
}

const mainFrames = new WeakMap<Tab, string>();

async function mainFrameOf(tab: Tab, session: CDPSession) {
  const known = mainFrames.get(tab);
  if (known) return known;
  const { frameTree } = await session.send("Page.getFrameTree");
  mainFrames.set(tab, frameTree.frame.id);
  return frameTree.frame.id;
}

async function channelEvaluate(tab: Tab, expression: string) {
  const session = await tab.session;
  const { executionContextId } = await session
    .send("Page.createIsolatedWorld", {
      frameId: await mainFrameOf(tab, session),
      worldName: CHANNEL_WORLD,
    })
    .catch((error: Error) => {
      mainFrames.delete(tab);
      throw error;
    });
  const documentId = tab.currentDocument;
  const { result } = await session.send("Runtime.evaluate", {
    contextId: executionContextId,
    returnByValue: true,
    awaitPromise: true,
    expression,
  });
  return { value: result.value, documentId };
}

function takeDelivery(
  tab: Tab,
  delivery: Delivery,
  source: number | undefined,
  options: { keepKnown: boolean },
) {
  for (const line of (delivery.text ?? "").split("\n").filter(Boolean)) {
    const parsed = parseJson(line, keyedEntrySchema);
    if (!parsed.success) continue;
    const { id, ...entry } = parsed.data;
    upsertConsole(
      tab,
      {
        ...entry,
        source: entry.source ?? rejectionSource(entry.text),
        url: delivery.url,
        documentId: deliveryDocument(tab, delivery.url, source),
        key:
          id === undefined || delivery.token === undefined ? undefined : `${delivery.token}:${id}`,
      },
      options,
    );
  }
}

type ChannelWatch = { session: CDPSession; documents: number };

function nextDocument(tab: Tab, session: CDPSession, waitMs?: number) {
  return new Promise<void>((resolve) => {
    const timer = waitMs === undefined ? undefined : setTimeout(() => done(), waitMs);
    const done = () => {
      clearTimeout(timer);
      session.off("Page.frameNavigated", navigated);
      tab.page.off("close", done);
      resolve();
    };
    const navigated = ({ frame }: { frame: { parentId?: string } }) => {
      if (!frame.parentId) done();
    };
    session.on("Page.frameNavigated", navigated);
    tab.page.once("close", done);
  });
}

async function pollChannel(tab: Tab, watch: ChannelWatch, failures = 0): Promise<void> {
  if (tab.page.isClosed()) return;
  const documents = watch.documents;
  const answer = await channelEvaluate(tab, "webAgentNext()").catch(() => undefined);
  const deliveries = deliveriesSchema.safeParse(answer?.value);
  if (deliveries.success) {
    for (const delivery of deliveries.data)
      takeDelivery(tab, delivery, answer?.documentId, { keepKnown: true });
    return pollChannel(tab, watch);
  }
  if (watch.documents !== documents) return pollChannel(tab, watch);
  const exhausted = failures >= CHANNEL_RETRIES;
  await nextDocument(tab, watch.session, exhausted ? undefined : CHANNEL_RETRY_MS);
  return pollChannel(tab, watch, exhausted ? 0 : failures + 1);
}

export async function openErrorChannel(mode: ConsoleHookMode, tab: Tab, session: CDPSession) {
  if (mode === "off") return;
  const watch: ChannelWatch = { session, documents: 0 };
  session.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId) watch.documents += 1;
  });
  await session.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${installChannelWorld.toString()})(${JSON.stringify(ERROR_CHANNEL)})`,
    worldName: CHANNEL_WORLD,
    runImmediately: true,
  });
  void pollChannel(tab, watch).catch(() => undefined);
}

export async function drainConsole(mode: ConsoleHookMode, tab: Tab) {
  if (mode === "off") return;
  const answer = await channelEvaluate(
    tab,
    `(() => { let text; const take = (event) => { text = event.detail; }; addEventListener("${ERROR_CHANNEL}-answer", take); dispatchEvent(new CustomEvent("${ERROR_CHANNEL}-ask")); removeEventListener("${ERROR_CHANNEL}-answer", take); return { url: location.href, token: globalThis.webAgentToken, text }; })()`,
  ).catch(() => undefined);
  const delivery = deliverySchema.safeParse(answer?.value);
  if (delivery.success) takeDelivery(tab, delivery.data, answer?.documentId, { keepKnown: false });
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
