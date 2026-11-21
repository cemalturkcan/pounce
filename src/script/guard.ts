import { z } from "zod";
import { withDeadline } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";

const SYNC_METHODS = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
  "first",
  "last",
  "nth",
  "filter",
  "and",
  "or",
  "frameLocator",
  "contentFrame",
  "owner",
  "describe",
  "url",
  "mainFrame",
  "frames",
  "frame",
  "parentFrame",
  "childFrames",
  "isDetached",
  "isClosed",
  "name",
  "page",
  "context",
  "pages",
  "browser",
  "viewportSize",
  "on",
  "off",
  "once",
  "addListener",
  "removeListener",
  "removeAllListeners",
  "listenerCount",
  "request",
  "headers",
  "method",
  "postData",
  "postDataBuffer",
  "postDataJSON",
  "resourceType",
  "status",
  "statusText",
  "ok",
  "timing",
  "failure",
  "redirectedFrom",
  "redirectedTo",
  "toString",
  "valueOf",
  "toJSON",
]);
const WRAPPED_CLASSES = new Set([
  "Page",
  "BrowserContext",
  "Frame",
  "Locator",
  "FrameLocator",
  "ElementHandle",
  "JSHandle",
  "Keyboard",
  "Mouse",
  "Touchscreen",
  "APIRequestContext",
  "APIResponse",
  "Response",
  "Request",
  "Route",
  "Download",
  "Dialog",
  "FileChooser",
  "Clock",
  "Tracing",
  "Worker",
  "Blob",
  "ReadableStream",
  "ReadableStreamDefaultReader",
]);
const SERIALIZED_ARGUMENT_METHODS = new Set([
  "evaluate",
  "evaluateHandle",
  "$eval",
  "$$eval",
  "evaluateAll",
  "addInitScript",
  "waitForFunction",
]);
const LISTENER_METHODS = new Set([
  "on",
  "once",
  "addListener",
  "prependListener",
  "prependOnceListener",
]);
const DISPOSABLE_METHODS = new Set(["addInitScript", "exposeBinding", "exposeFunction"]);
const RELEASE_TIMEOUT_MS = 5000;
const IGNORED_ABORT_CALLS = 20;
const ABORTED_CALL_DELAY_MS = 50;

export type Callable<Result> = (...args: unknown[]) => Result;

function isCallable<Value>(value: Value): value is Value & Callable<unknown> {
  return typeof value === "function";
}

export function isText<Other>(value: string | Other): value is string {
  return typeof value === "string";
}

function isObject<Value>(value: Value): value is Value & object {
  return value !== null && typeof value === "object";
}

export function isThenable<Value>(value: Value): value is Value & PromiseLike<unknown> {
  return (isObject(value) || isCallable(value)) && "then" in value && isCallable(value.then);
}

type PredicateOptions = { predicate?: unknown };

function isPlainObject<Value>(value: Value): value is Value & PredicateOptions {
  if (!isObject(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

export const callable = z.custom<Callable<unknown>>(isCallable);
const disposable = z.object({ dispose: callable });
const routeFallback = z.object({ fallback: callable });

function memberOf<Owner extends object>(owner: Owner, property: string | symbol) {
  for (let holder: object | null = owner; holder !== null; holder = Object.getPrototypeOf(holder)) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, property);
    if (descriptor) {
      const member: unknown = descriptor.get ? descriptor.get.call(owner) : descriptor.value;
      return member;
    }
  }
  return undefined;
}

function callMember<Owner extends object>(owner: Owner, name: string, args: unknown[]) {
  const member = memberOf(owner, name);
  return isCallable(member) ? member.apply(owner, args) : undefined;
}

function isGuardedClass<Value extends object>(value: Value) {
  return WRAPPED_CLASSES.has((value.constructor?.name ?? "").replace(/^_+|\d+$/g, ""));
}

type ScriptStop = { reason: "cancelled" | "timeout" | "blocked" | "ended"; message: string };

class ProxyPairs {
  private readonly proxies = new WeakMap<object, object>();
  private readonly targets = new WeakMap<object, object>();

  add<Target extends object>(target: Target, proxy: Target) {
    this.proxies.set(target, proxy);
    this.targets.set(proxy, target);
  }

  isProxy<Value extends object>(value: Value) {
    return this.targets.has(value);
  }

  proxyOf<Target extends object>(target: Target) {
    // SAFETY: add() is the only writer and pairs a target with a proxy of the same type.
    return this.proxies.get(target) as Target | undefined;
  }

  targetOf<Proxied extends object>(proxy: Proxied) {
    // SAFETY: add() is the only writer and pairs a proxy with a target of the same type.
    return this.targets.get(proxy) as Proxied | undefined;
  }
}

export class ScriptGuard {
  readonly controller = new AbortController();
  private readonly pairs = new ProxyPairs();
  private readonly callbacks = new WeakMap<Callable<unknown>, Callable<unknown>>();
  private readonly registrations: (() => Promise<void>)[] = [];
  private readonly settling: Promise<void>[] = [];
  private rejectedCalls = 0;
  stop?: ScriptStop;
  onCallbackError: (label: string, cause: unknown) => void = () => undefined;
  adopt: <Result>(pending: Promise<Result>) => Promise<Result> = (pending) => pending;
  invoke: <Result>(fn: Callable<Result>, args: unknown[]) => Result | undefined = (fn, args) =>
    fn(...args);
  settled: () => void = () => undefined;

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
    if (this.rejectedCalls > IGNORED_ABORT_CALLS)
      return this.adopt(new Promise<T>(() => undefined));
    return this.adopt(
      new Promise<T>((_resolve, reject) =>
        setTimeout(() => reject(this.error()), ABORTED_CALL_DELAY_MS),
      ),
    );
  }

  unwrap<T>(value: T): T {
    if (!isObject(value)) return value;
    return this.pairs.targetOf(value) ?? value;
  }

  private unwrapAll<A extends unknown[]>(args: A) {
    // SAFETY: unwrap() returns each argument with the type it was given, so the mapped tuple keeps its element types.
    return args.map((arg) => this.unwrap(arg)) as A;
  }

  private callback(label: string, fn: Callable<unknown>) {
    const existing = this.callbacks.get(fn);
    if (existing) return existing;
    const wrapped = (...args: unknown[]) => {
      const failed = (cause: unknown) => {
        this.onCallbackError(label, cause);
        if (label === "route") {
          const route = routeFallback.safeParse(args[0]);
          if (route.success)
            void Promise.resolve(route.data.fallback.call(args[0])).catch(() => undefined);
        }
        return undefined;
      };
      try {
        const result = this.invoke(
          fn,
          args.map((arg) => this.wrap(arg)),
        );
        if (isThenable(result)) return Promise.resolve(result).catch(failed);
        return result;
      } catch (cause) {
        return failed(cause);
      }
    };
    this.callbacks.set(fn, wrapped);
    return wrapped;
  }

  private prepare(method: string, args: unknown[]) {
    const [first] = args;
    const label = LISTENER_METHODS.has(method) && isText(first) ? first : method;
    return args.map((arg) => {
      if (isCallable(arg) && !SERIALIZED_ARGUMENT_METHODS.has(method))
        return this.callback(label, arg);
      if (isPlainObject(arg) && isCallable(arg.predicate))
        return { ...arg, predicate: this.callback(label, arg.predicate) };
      return this.unwrap(arg);
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

  async release() {
    await withDeadline(Promise.all(this.settling.splice(0)), RELEASE_TIMEOUT_MS);
    const pending = this.registrations.splice(0).toReversed();
    await Promise.all(
      pending.map((undo) => withDeadline(undo(), RELEASE_TIMEOUT_MS).catch(() => undefined)),
    );
  }

  private settle<Result>(pending: Promise<Result>) {
    return this.adopt(
      pending.then(
        (resolved) => {
          this.settled();
          return this.wrap(resolved);
        },
        (cause: unknown) => {
          this.settled();
          throw cause;
        },
      ),
    );
  }

  private adoptIterator<Iterator extends object>(iterator: Iterator) {
    const step =
      (name: string) =>
      (...args: unknown[]) => {
        const result = callMember(
          iterator,
          name,
          args.map((arg) => this.unwrap(arg)),
        );
        return result instanceof Promise ? this.settle(result) : result;
      };
    const adopted = {
      next: step("next"),
      return: step("return"),
      throw: step("throw"),
      [Symbol.asyncIterator]: () => adopted,
    };
    return adopted;
  }

  private symbolMember<Owner extends object>(owner: Owner, property: symbol) {
    const member = memberOf(owner, property);
    if (!isCallable(member)) return member;
    return (...args: unknown[]) => {
      const result = member.apply(owner, this.unwrapAll(args));
      return property === Symbol.asyncIterator && isObject(result)
        ? this.adoptIterator(result)
        : result;
    };
  }

  private member<Owner extends object>(owner: Owner, property: string | symbol) {
    if (!isText(property)) return this.symbolMember(owner, property);
    const member = memberOf(owner, property);
    if (property.startsWith("_")) return member;
    if (!isCallable(member)) return this.wrap(member);
    return (...args: unknown[]) => {
      if (this.stopped && !SYNC_METHODS.has(property)) return this.refused();
      const prepared = this.prepare(property, args);
      const result = member.apply(owner, prepared);
      this.track(owner, property, prepared);
      if (DISPOSABLE_METHODS.has(property) && result instanceof Promise)
        this.trackDisposable(result);
      if (result instanceof Promise) return this.settle(result);
      return this.wrap(result);
    };
  }

  wrap<T>(value: T): T {
    if (Array.isArray(value)) {
      // SAFETY: wrap() returns each element with the type it was given, so the mapped array keeps the input's type.
      return value.map((item) => this.wrap(item)) as T;
    }
    if (!isObject(value) || this.pairs.isProxy(value) || !isGuardedClass(value)) return value;
    const existing = this.pairs.proxyOf(value);
    if (existing) return existing;
    const proxy = new Proxy(value, { get: (owner, property) => this.member(owner, property) });
    this.pairs.add(value, proxy);
    return proxy;
  }

  guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return (...args: A): Promise<R> =>
      this.stopped
        ? this.refused<R>()
        : this.adopt(fn(...this.unwrapAll(args)).finally(() => this.settled()));
  }
}
