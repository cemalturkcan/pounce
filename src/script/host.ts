import { MessageChannel, type MessagePort, Worker } from "node:worker_threads";
import { z } from "zod";
import { recordFault } from "../log/faults.ts";
import { withDeadline } from "../shared/async.ts";
import { type QuotedError, ToolError } from "../shared/errors.ts";
import type { StructuredValue } from "../shared/output.ts";
import {
  type Callable,
  decode,
  encode,
  errorFromWire,
  errorOf,
  type FromWorker,
  fromWorker,
  isCallable,
  isText,
  isThenable,
  type MarkerBody,
  type SyncReply,
  type ToWorker,
  type Waiter,
  type WireError,
} from "./wire.ts";

const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const DISPOSABLE_METHODS = new Set(["addInitScript", "exposeBinding", "exposeFunction"]);
const RELEASE_TIMEOUT_MS = 5000;
const ABORT_GRACE_MS = 200;
const FINAL_REPORT_WAIT_MS = 200;

const callable = z.custom<Callable<unknown>>(isCallable);
const disposable = z.object({ dispose: callable });
const routeFallback = z.object({ fallback: callable });

export function memberOf<Owner extends object>(owner: Owner, property: string) {
  for (let holder: object | null = owner; holder !== null; holder = Object.getPrototypeOf(holder)) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      const member: unknown = descriptor.get ? descriptor.get.call(owner) : descriptor.value;
      return member;
    }
  }
  return undefined;
}

export function callMember<Owner extends object>(owner: Owner, name: string, args: unknown[]) {
  const member = memberOf(owner, name);
  return isCallable(member) ? member.apply(owner, args) : undefined;
}

export function kindOf<Value extends object>(value: Value) {
  if (isCallable(value)) return "Function";
  return (value.constructor?.name ?? "").replace(/^_+|\d+$/g, "");
}

function sourceFunction(source: string) {
  return Object.assign(() => undefined, { toString: () => source });
}

export class ThrownByScript extends Error {
  readonly thrown: WireError;
  readonly quoted: QuotedError[];

  constructor(thrown: WireError, quoted: QuotedError[]) {
    super(thrown.message);
    this.name = thrown.name;
    if (thrown.stack) this.stack = thrown.stack;
    this.thrown = thrown;
    this.quoted = quoted;
  }
}

export type ScriptStop = { reason: "cancelled" | "timeout" | "ended"; message: string };

export class HandleTable {
  private readonly objects = new Map<number, object>();
  private readonly ids = new WeakMap<object, number>();
  private readonly sent = new Map<number, number>();
  private next = 0;

  export<Value extends object>(value: Value) {
    let id = this.ids.get(value);
    if (id === undefined) {
      this.next += 1;
      id = this.next;
      this.ids.set(value, id);
      this.objects.set(id, value);
    }
    this.sent.set(id, (this.sent.get(id) ?? 0) + 1);
    return id;
  }

  get(id: number) {
    return this.objects.get(id);
  }

  release(id: number, count: number) {
    const left = (this.sent.get(id) ?? 0) - count;
    if (left > 0) {
      this.sent.set(id, left);
      return;
    }
    const value = this.objects.get(id);
    if (value) this.ids.delete(value);
    this.objects.delete(id);
    this.sent.delete(id);
  }
}

type HostEvents = {
  onLog: (line: string) => void;
  onCallbackError: (label: string, cause: unknown) => void;
  onUnhandledRejection: (cause: unknown) => void;
  onCallFailedAfterEnd: (cause: unknown) => void;
  onExport: <Value extends object>(value: Value, method?: string) => void;
  replacement: <Owner extends object>(
    owner: Owner,
    method: string,
  ) => Callable<unknown> | undefined;
};

type StartObjects = { page?: object; context: object; scope: object };

export type ScriptOutcome = { returned: string; value?: StructuredValue; undefined?: true };

export class ScriptHost {
  readonly controller = new AbortController();
  readonly outcome: Promise<ScriptOutcome>;
  stop?: ScriptStop;
  private readonly handles = new HandleTable();
  private readonly stubs = new Map<number, Callable<unknown>>();
  private readonly waiting = new Map<number, Waiter<unknown>>();
  private readonly sentErrors = new Map<number, { cause: unknown; error: WireError }>();
  private readonly registrations: (() => Promise<void>)[] = [];
  private readonly settling: Promise<void>[] = [];
  private readonly events: HostEvents;
  private readonly flag = new Int32Array(new SharedArrayBuffer(4));
  private readonly replies: MessagePort;
  private readonly worker: Worker;
  private settleOutcome: Waiter<ScriptOutcome> = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  private acknowledgeAbort: () => void = () => undefined;
  private readonly aborted: Promise<void>;
  private shutdown?: Promise<void>;
  private heldReport?: () => void;
  private reportTimer?: ReturnType<typeof setTimeout>;
  private ended = false;
  private nextPending = 0;
  private nextCall = 0;
  private nextError = 0;

  constructor(code: string, objects: StartObjects, events: HostEvents) {
    this.events = events;
    this.outcome = new Promise<ScriptOutcome>((resolve, reject) => {
      this.settleOutcome = { resolve, reject };
    });
    this.outcome.catch(() => undefined);
    this.aborted = new Promise<void>((resolve) => {
      this.acknowledgeAbort = resolve;
    });
    const { port1, port2 } = new MessageChannel();
    this.replies = port1;
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: {
        code,
        port: port2,
        flag: this.flag.buffer,
        page: this.encode(objects.page),
        context: this.encode(objects.context),
        scope: this.handles.export(objects.scope),
      },
      transferList: [port2],
    });
    this.worker.on("message", (raw) => this.receive(fromWorker.parse(raw)));
    this.worker.on("error", (cause) => this.fail(cause));
    this.worker.on("exit", (exitCode) => {
      if (!this.ended)
        this.fail(new Error(`The script's worker stopped unexpectedly (exit code ${exitCode}).`));
    });
  }

  error() {
    return new ToolError(this.stop?.message ?? "The script was stopped.");
  }

  private fail(cause: unknown) {
    if (!this.stop) this.settleOutcome.reject(cause);
  }

  private post(message: ToWorker) {
    if (!this.ended) this.worker.postMessage(message, []);
  }

  private reply(compute: () => SyncReply) {
    let reply: SyncReply;
    try {
      reply = compute();
      this.replies.postMessage(reply, []);
    } catch (cause) {
      this.replies.postMessage({ error: this.sent(cause) }, []);
    }
    Atomics.store(this.flag, 0, 1);
    Atomics.notify(this.flag, 0);
  }

  private receive(message: FromWorker) {
    switch (message.type) {
      case "call":
        this.reply(() => this.call(message.target, message.method, message.args));
        return;
      case "get":
        this.reply(() => this.get(message.target, message.property));
        return;
      case "log":
        this.events.onLog(message.line);
        return;
      case "done":
        this.holdReport(() => {
          if (!this.stop)
            this.settleOutcome.resolve({
              returned: message.returned,
              value: message.value,
              undefined: message.undefined,
            });
        });
        return;
      case "failed": {
        const cause = this.restore(message.error);
        this.holdReport(() => this.fail(cause));
        return;
      }
      case "final":
        this.releaseReport();
        return;
      case "timerError":
        if (!this.stop) this.events.onCallbackError("timer", this.restore(message.error));
        return;
      case "unhandled":
        if (!this.stop) this.events.onUnhandledRejection(this.restore(message.error));
        return;
      case "aborted":
        this.acknowledgeAbort();
        return;
      case "callbackDone":
        this.callbackDone(message);
        return;
      case "release":
        this.handles.release(message.handle, message.count);
        return;
      case "releaseError":
        this.sentErrors.delete(message.origin);
    }
  }

  private holdReport(report: () => void) {
    this.heldReport = report;
    this.reportTimer = setTimeout(() => this.releaseReport(), FINAL_REPORT_WAIT_MS);
  }

  private releaseReport() {
    clearTimeout(this.reportTimer);
    const report = this.heldReport;
    this.heldReport = undefined;
    report?.();
  }

  private sent(cause: unknown): WireError {
    const error = errorOf(cause);
    this.nextError += 1;
    this.sentErrors.set(this.nextError, { cause, error });
    return { ...error, origin: this.nextError };
  }

  private restore(error: WireError) {
    const restored = this.restoreOne(error);
    let holder = restored;
    for (let link = error.cause; link && holder instanceof ThrownByScript; link = link.cause) {
      const cause = this.restoreOne(link);
      holder.cause = cause;
      holder = cause;
    }
    return restored;
  }

  private restoreOne(error: WireError) {
    const sent = error.origin === undefined ? undefined : this.sentErrors.get(error.origin);
    if (sent && sent.error.name === error.name && sent.error.message === error.message)
      return sent.cause;
    const quoted = [...this.sentErrors.values()].flatMap(({ cause, error: { message } }) =>
      message.trim() && error.message.includes(message.trimEnd()) ? [{ text: message, cause }] : [],
    );
    return new ThrownByScript(error, quoted);
  }

  private callbackDone(done: Extract<FromWorker, { type: "callbackDone" }>) {
    const waiter = this.waiting.get(done.call);
    this.waiting.delete(done.call);
    if (done.error) waiter?.reject(this.restore(done.error));
    else waiter?.resolve(this.decode(done.value, "callback"));
  }

  private encode<Value>(value: Value, method?: string) {
    return encode(value, (object) => {
      if (!this.ended) this.events.onExport(object, method);
      return { handle: this.handles.export(object), kind: kindOf(object) };
    });
  }

  private decode<Value>(value: Value, label: string) {
    return decode(value, (body: MarkerBody) => {
      if ("handle" in body) {
        const target = this.handles.get(body.handle);
        if (!target)
          throw new ToolError("This browser object is no longer available to the script.");
        return target;
      }
      if ("callback" in body) return this.stub(label, body.callback);
      if ("source" in body) return sourceFunction(body.source);
      return errorFromWire(body.error);
    });
  }

  private target(id: number) {
    if (this.stop) throw this.error();
    const target = this.handles.get(id);
    if (!target) throw new ToolError("This browser object is no longer available to the script.");
    return target;
  }

  private get(id: number, property: string): SyncReply {
    const owner = this.target(id);
    if (this.events.replacement(owner, property)) return { method: true };
    const member = memberOf(owner, property);
    return isCallable(member) ? { method: true } : { value: this.encode(member) };
  }

  private call(id: number, method: string | null, args: unknown[]): SyncReply {
    const owner = this.target(id);
    const [first] = args;
    const label =
      method && LISTENER_METHODS.has(method) && isText(first) ? first : (method ?? "function");
    const prepared = args.map((arg) => this.decode(arg, label));
    let result: unknown;
    if (method === null) {
      if (!isCallable(owner)) throw new TypeError("This object is not a function.");
      result = owner(...prepared);
    } else {
      const member = this.events.replacement(owner, method) ?? memberOf(owner, method);
      if (!isCallable(member)) throw new TypeError(`${method} is not a function.`);
      result = member.apply(owner, prepared);
      this.track(owner, method, prepared);
      if (DISPOSABLE_METHODS.has(method) && isThenable(result))
        this.trackDisposable(Promise.resolve(result));
    }
    const via = method ?? undefined;
    if (isThenable(result)) return { pending: this.pend(Promise.resolve(result), via) };
    return { value: this.encode(result, via) };
  }

  private pend(pending: Promise<unknown>, method?: string) {
    this.nextPending += 1;
    const id = this.nextPending;
    void pending.then(
      (value) => {
        try {
          this.post({ type: "settle", pending: id, value: this.encode(value, method) });
        } catch (cause) {
          this.post({ type: "settle", pending: id, value: undefined, error: this.sent(cause) });
        }
      },
      (cause: unknown) => {
        if (this.ended && this.stop?.reason === "ended") {
          this.events.onCallFailedAfterEnd(cause);
          return;
        }
        this.post({ type: "settle", pending: id, value: undefined, error: this.sent(cause) });
      },
    );
    return id;
  }

  private stub(label: string, callback: number) {
    const existing = this.stubs.get(callback);
    if (existing) return existing;
    const stub = (...args: unknown[]) => {
      const fallBack = () => {
        if (label === "route") {
          const route = routeFallback.safeParse(args[0]);
          if (route.success)
            void Promise.resolve(route.data.fallback.call(args[0])).catch(() => undefined);
        }
        return undefined;
      };
      const failed = (cause: unknown) => {
        if (!this.stop) this.events.onCallbackError(label, cause);
        return fallBack();
      };
      if (this.ended) return failed(this.error());
      try {
        return this.invoke(callback, args).catch(failed);
      } catch (cause) {
        recordFault("run_script callback", cause);
        return fallBack();
      }
    };
    this.stubs.set(callback, stub);
    return stub;
  }

  private invoke(callback: number, args: unknown[]) {
    this.nextCall += 1;
    const call = this.nextCall;
    this.post({ type: "callback", call, callback, args: args.map((arg) => this.encode(arg)) });
    return new Promise<unknown>((resolve, reject) => {
      this.waiting.set(call, { resolve, reject });
    });
  }

  private track<Owner extends object>(owner: Owner, method: string, prepared: unknown[]) {
    const [first, second] = prepared;
    if (LISTENER_METHODS.has(method) && isText(first) && isCallable(second)) {
      this.registrations.push(async () => {
        callMember(owner, "removeListener", [first, second]);
      });
    }
    if (method === "route" && isCallable(second)) {
      this.registrations.push(async () => {
        await callMember(owner, "unroute", [first, second]);
      });
    }
  }

  private trackDisposable(pending: Promise<unknown>) {
    this.settling.push(
      pending.then(
        (value) => {
          const registered = disposable.safeParse(value);
          if (registered.success)
            this.registrations.push(async () => {
              await registered.data.dispose.call(value);
            });
        },
        () => undefined,
      ),
    );
  }

  halt(stop: ScriptStop) {
    if (this.shutdown) return this.shutdown;
    this.stop = stop;
    this.controller.abort(new ToolError(stop.message));
    this.shutdown = this.end(stop.reason !== "ended");
    return this.shutdown;
  }

  private async end(graceful: boolean) {
    if (graceful) {
      this.post({ type: "abort", message: this.error().message });
      await withDeadline(this.aborted, ABORT_GRACE_MS);
    }
    this.ended = true;
    await this.worker.terminate();
    this.replies.close();
    for (const waiter of this.waiting.values()) waiter.reject(this.error());
    this.waiting.clear();
    this.settleOutcome.reject(this.error());
  }

  async release() {
    await withDeadline(Promise.all(this.settling.splice(0)), RELEASE_TIMEOUT_MS);
    const pending = this.registrations.splice(0).toReversed();
    await Promise.all(
      pending.map((undo) => withDeadline(undo(), RELEASE_TIMEOUT_MS).catch(() => undefined)),
    );
  }
}
