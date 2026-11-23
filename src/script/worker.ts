import vm from "node:vm";
import { parentPort, receiveMessageOnPort, workerData } from "node:worker_threads";
import { errorLikeName, logPartText, structuredValue, valueText } from "./text.ts";
import {
  type Callable,
  causeOf,
  decode,
  encode,
  errorFromWire,
  errorOf,
  type Exporter,
  type FromWorker,
  type Importer,
  isCallable,
  isError,
  isObject,
  isText,
  isThenable,
  mark,
  scriptSource,
  startData,
  type SyncReply,
  type Waiter,
  syncReply,
  toWorker,
  type WireError,
} from "./wire.ts";

const SERIALIZED_ARGUMENT_METHODS = new Set([
  "evaluate",
  "evaluateHandle",
  "$eval",
  "$$eval",
  "evaluateAll",
  "addInitScript",
  "waitForFunction",
]);

if (!parentPort) throw new Error("run_script's worker must run in a worker thread.");
const parent = parentPort;
const start = startData.parse(workerData);
const flag = new Int32Array(start.flag);

const post = (message: FromWorker) => parent.postMessage(message, []);

function request(message: FromWorker) {
  Atomics.store(flag, 0, 0);
  post(message);
  Atomics.wait(flag, 0, 0);
  return syncReply.parse(receiveMessageOnPort(start.port)?.message);
}

type Token = { handle: number; count: number };

const proxies = new Map<number, { ref: WeakRef<object>; token: Token }>();
const handleOf = new WeakMap<object, number>();
const methods = new Set<string>();
const callbacks = new Map<number, Callable<unknown>>();
const callbackIds = new WeakMap<Callable<unknown>, number>();
const pending = new Map<number, Waiter<unknown>>();
const hostErrors = new WeakMap<object, number>();
let finalReportPending = false;
const releasedErrors = new FinalizationRegistry<number>((origin) => {
  if (!finalReportPending) post({ type: "releaseError", origin });
});
const finalized = new FinalizationRegistry<Token>((token) => {
  if (proxies.get(token.handle)?.token === token) proxies.delete(token.handle);
  post({ type: "release", handle: token.handle, count: token.count });
});

const exportObject: Exporter = (value) => {
  const handle = handleOf.get(value);
  if (handle !== undefined) return { handle, kind: "" };
  if (!isCallable(value)) return undefined;
  let callback = callbackIds.get(value);
  if (callback === undefined) {
    callback = callbacks.size + 1;
    callbacks.set(callback, value);
    callbackIds.set(value, callback);
  }
  return { callback };
};

const importMarker: Importer = (body) => {
  if ("handle" in body) return importHandle(body.handle, body.kind);
  if ("error" in body) return errorFromWire(body.error);
  return undefined;
};

function fromHost(error: WireError) {
  const restored = errorFromWire(error);
  if (error.origin !== undefined) {
    hostErrors.set(restored, error.origin);
    releasedErrors.register(restored, error.origin);
  }
  return restored;
}

function wired(cause: unknown, seen = new Set<unknown>([cause])): WireError {
  const error = { ...errorOf(cause), origin: isObject(cause) ? hostErrors.get(cause) : undefined };
  const inner = causeOf(cause);
  if (inner === undefined || seen.has(inner)) return error;
  seen.add(inner);
  const linked = wired(inner, seen);
  return { ...error, cause: isError(inner) ? linked : { ...linked, name: errorLikeName(inner) } };
}

function settled(reply: SyncReply) {
  if ("error" in reply) throw fromHost(reply.error);
  if ("pending" in reply)
    return new Promise<unknown>((resolve, reject) =>
      pending.set(reply.pending, { resolve, reject }),
    );
  if ("method" in reply) return undefined;
  return decode(reply.value, importMarker);
}

function invoke(target: number, method: string | null, args: unknown[]) {
  const serialized = method !== null && SERIALIZED_ARGUMENT_METHODS.has(method);
  const prepared = args.map((arg) =>
    serialized && isCallable(arg) ? mark({ source: String(arg) }) : encode(arg, exportObject),
  );
  return settled(request({ type: "call", target, method, args: prepared }));
}

const remoteObject = {};

const handleRef = (kind: string) => `ref: <${kind === "ElementHandle" ? "Node" : kind}>`;

function remote(handle: number, kind: string) {
  const member =
    (property: string) =>
    (...args: unknown[]) =>
      invoke(handle, property, args);
  const target: object = kind === "Function" ? () => undefined : Object.create(remoteObject);
  return new Proxy(target, {
    get: (_target, property) => {
      if (property === "toJSON") return () => handleRef(kind);
      if (!isText(property) || property === "then") return undefined;
      const key = `${kind}.${property}`;
      if (methods.has(key)) return member(property);
      const reply = request({ type: "get", target: handle, property });
      if (!("method" in reply)) return settled(reply);
      methods.add(key);
      return member(property);
    },
    apply: (_target, _self, args: unknown[]) => invoke(handle, null, args),
  });
}

function importHandle(handle: number, kind: string) {
  const entry = proxies.get(handle);
  const existing = entry?.ref.deref();
  if (entry && existing) {
    entry.token.count += 1;
    return existing;
  }
  const proxy = remote(handle, kind);
  const token = { handle, count: 1 };
  proxies.set(handle, { ref: new WeakRef(proxy), token });
  handleOf.set(proxy, handle);
  finalized.register(proxy, token);
  return proxy;
}

async function runCallback(call: number, callback: number, args: unknown[]) {
  try {
    const fn = callbacks.get(callback);
    const value: unknown = await fn?.(...args.map((arg) => decode(arg, importMarker)));
    post({ type: "callbackDone", call, value: encode(value, exportObject) });
  } catch (cause) {
    post({ type: "callbackDone", call, value: undefined, error: wired(cause) });
  }
}

const scriptAbort = new AbortController();

parent.on("message", (raw) => {
  const message = toWorker.parse(raw);
  if (message.type === "settle") {
    const waiter = pending.get(message.pending);
    pending.delete(message.pending);
    if (message.error) waiter?.reject(fromHost(message.error));
    else waiter?.resolve(decode(message.value, importMarker));
    return;
  }
  if (message.type === "callback") {
    void runCallback(message.call, message.callback, message.args);
    return;
  }
  scriptAbort.abort(new Error(message.message));
  post({ type: "aborted" });
});

process.on("unhandledRejection", (cause) => post({ type: "unhandled", error: wired(cause) }));

const log = (...parts: unknown[]) =>
  post({ type: "log", line: parts.map((part) => logPartText.parse(part)).join(" ") });

const timerFailed = (cause: unknown) => post({ type: "timerError", error: wired(cause) });

const safely =
  (callback: Callable<unknown>) =>
  (...args: unknown[]) => {
    try {
      const result = callback(...args);
      if (isThenable(result)) Promise.resolve(result).catch(timerFailed);
    } catch (cause) {
      timerFailed(cause);
    }
  };

const scope =
  (name: string) =>
  (...args: unknown[]) =>
    invoke(start.scope, name, args);

const sandbox = {
  page: decode(start.page, importMarker),
  context: decode(start.context, importMarker),
  signal: scriptAbort.signal,
  tab: scope("tab"),
  tabId: scope("tabId"),
  openTab: scope("openTab"),
  closeTab: scope("closeTab"),
  ref: scope("ref"),
  snapshot: scope("snapshot"),
  text: scope("text"),
  links: scope("links"),
  extract: scope("extract"),
  compareDesign: scope("compareDesign"),
  save: scope("save"),
  secrets: { list: scope("secretsList"), fill: scope("secretsFill") },
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  log,
  console: { log, info: log, warn: log, error: log, debug: log },
  setTimeout: (callback: Callable<unknown>, ms?: number, ...args: unknown[]) =>
    setTimeout(safely(callback), ms, ...args),
  clearTimeout,
  setInterval: (callback: Callable<unknown>, ms?: number, ...args: unknown[]) =>
    setInterval(safely(callback), ms, ...args),
  clearInterval,
  URL,
  URLSearchParams,
  fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
  Buffer,
  TextEncoder,
  TextDecoder,
  AbortController,
  structuredClone,
};

const afterPendingRejections = (message: FromWorker) => {
  finalReportPending = true;
  post(message);
  setImmediate(() => post({ type: "final" }));
};

const failed = (cause: unknown) => afterPendingRejections({ type: "failed", error: wired(cause) });

try {
  const completion: unknown = scriptSource(start.code).runInContext(vm.createContext(sandbox));
  Promise.resolve(completion)
    .then((value) => {
      const structured = structuredValue(value);
      afterPendingRejections({
        type: "done",
        returned: valueText(structured),
        value: structured,
        undefined: structured === undefined || undefined,
      });
    })
    .catch(failed);
} catch (cause) {
  failed(cause);
}
