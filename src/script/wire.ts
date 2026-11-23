import { types } from "node:util";
import { MessagePort } from "node:worker_threads";
import vm from "node:vm";
import { z } from "zod";
import { errorMessage, structuredJson, unconvertible } from "./text.ts";

const WIRE = "~webAgentWire";
const SCRIPT_FRAME = /^at (.*\brun_script\.js:)(\d+)(:\d+\)?)$/;

export function scriptSource(code: string) {
  return new vm.Script(`(async () => {\n${code}\n})()`, { filename: "run_script.js" });
}

export function scriptFrames(stack: string | undefined, code: string) {
  const lastLine = code.split("\n").length;
  const frames = (stack ?? "").split("\n").flatMap((line) => {
    const frame = SCRIPT_FRAME.exec(line.trim());
    const codeLine = Number(frame?.[2]) - 1;
    if (!frame || codeLine < 1 || codeLine > lastLine) return [];
    return [`at ${frame[1]}${codeLine}${frame[3]}`];
  });
  return frames.length ? frames.join("\n") : undefined;
}

export function isError<Value>(value: Value): value is Value & Error {
  try {
    return value instanceof Error || types.isNativeError(value);
  } catch {
    return false;
  }
}

export type Callable<Result> = (...args: unknown[]) => Result;

export function isCallable<Value>(value: Value): value is Value & Callable<unknown> {
  return typeof value === "function";
}

export function isText<Other>(value: string | Other): value is string {
  return typeof value === "string";
}

export function isObject<Value>(value: Value): value is Value & object {
  return value !== null && typeof value === "object";
}

export function isThenable<Value>(value: Value): value is Value & PromiseLike<unknown> {
  return (isObject(value) || isCallable(value)) && "then" in value && isCallable(value.then);
}

function isPlainObject<Value>(value: Value): value is Value & object {
  if (!isObject(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function isCloneable<Value extends object>(value: Value) {
  return (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set
  );
}

export type Waiter<Value> = {
  resolve: (value: Value) => void;
  reject: (cause: unknown) => void;
};

export const wireError = z.object({
  name: z.string(),
  message: z.string(),
  stack: z.string().optional(),
  hint: z.string().optional(),
  origin: z.number().optional(),
  get cause() {
    return wireError.optional();
  },
});

export type WireError = z.infer<typeof wireError>;

const markerBody = z.union([
  z.object({ handle: z.number(), kind: z.string() }),
  z.object({ callback: z.number() }),
  z.object({ source: z.string() }),
  z.object({ error: wireError }),
]);

export type MarkerBody = z.infer<typeof markerBody>;

const marker = z.object({ [WIRE]: markerBody });

export function mark(body: MarkerBody) {
  return { [WIRE]: body };
}

const withHint = z.object({ hint: z.string() });

function fieldText<Value>(read: () => Value, absent: string) {
  try {
    const value = read();
    return value === undefined ? absent : String(value);
  } catch (failure) {
    return unconvertible(failure);
  }
}

function textField<Value>(read: () => Value) {
  try {
    const value = read();
    return isText(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function errorOf(cause: unknown): WireError {
  if (!isError(cause)) return { name: "Error", message: errorMessage(cause) };
  return {
    name: fieldText(() => cause.name, "Error"),
    message: fieldText(() => cause.message, ""),
    stack: textField(() => cause.stack),
    hint: textField(() => withHint.safeParse(cause).data?.hint),
  };
}

export function causeOf(cause: unknown) {
  if (!isError(cause)) return undefined;
  try {
    return cause.cause;
  } catch {
    return undefined;
  }
}

export type Exporter = <Value extends object>(value: Value) => MarkerBody | undefined;

export function encode<Value>(value: Value, exportObject: Exporter) {
  const walk = <Item>(item: Item) => {
    if (item instanceof Error) return mark({ error: errorOf(item) });
    if (isCallable(item)) {
      const body = exportObject(item);
      return body ? mark(body) : undefined;
    }
    if (!isObject(item)) return item;
    if (Array.isArray(item)) {
      const copy: unknown[] = [];
      for (const entry of item) copy.push(walk(entry));
      return copy;
    }
    if (isPlainObject(item))
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => {
          const walked: unknown = walk(entry);
          return [key, walked];
        }),
      );
    if (isCloneable(item)) return item;
    const body = exportObject(item);
    return body ? mark(body) : item;
  };
  const encoded: unknown = walk(value);
  return encoded;
}

export type Importer = (body: MarkerBody) => object | undefined;

export function decode<Value>(value: Value, importMarker: Importer) {
  const walk = <Item>(item: Item) => {
    if (item instanceof Uint8Array && !Buffer.isBuffer(item))
      return Buffer.from(item.buffer, item.byteOffset, item.byteLength);
    if (!isObject(item)) return item;
    const marked = marker.safeParse(item);
    if (marked.success) return importMarker(marked.data[WIRE]);
    if (Array.isArray(item)) {
      const copy: unknown[] = [];
      for (const entry of item) copy.push(walk(entry));
      return copy;
    }
    if (!isPlainObject(item)) return item;
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => {
        const walked: unknown = walk(entry);
        return [key, walked];
      }),
    );
  };
  const decoded: unknown = walk(value);
  return decoded;
}

export function errorFromWire(error: WireError) {
  const restored = Object.assign(new Error(error.message), { hint: error.hint });
  restored.name = error.name;
  if (error.stack) restored.stack = error.stack;
  return restored;
}

const callRequest = z.object({
  type: z.literal("call"),
  target: z.number(),
  method: z.string().nullable(),
  args: z.array(z.unknown()),
});
const getRequest = z.object({ type: z.literal("get"), target: z.number(), property: z.string() });

export const fromWorker = z.discriminatedUnion("type", [
  callRequest,
  getRequest,
  z.object({ type: z.literal("log"), line: z.string() }),
  z.object({
    type: z.literal("done"),
    returned: z.string(),
    value: structuredJson.optional(),
    undefined: z.literal(true).optional(),
  }),
  z.object({ type: z.literal("failed"), error: wireError }),
  z.object({ type: z.literal("final") }),
  z.object({ type: z.literal("unhandled"), error: wireError }),
  z.object({ type: z.literal("timerError"), error: wireError }),
  z.object({ type: z.literal("aborted") }),
  z.object({
    type: z.literal("callbackDone"),
    call: z.number(),
    value: z.unknown(),
    error: wireError.optional(),
  }),
  z.object({ type: z.literal("release"), handle: z.number(), count: z.number() }),
  z.object({ type: z.literal("releaseError"), origin: z.number() }),
]);

export type FromWorker = z.infer<typeof fromWorker>;

export const toWorker = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("settle"),
    pending: z.number(),
    value: z.unknown(),
    error: wireError.optional(),
  }),
  z.object({
    type: z.literal("callback"),
    call: z.number(),
    callback: z.number(),
    args: z.array(z.unknown()),
  }),
  z.object({ type: z.literal("abort"), message: z.string() }),
]);

export type ToWorker = z.infer<typeof toWorker>;

export const syncReply = z.union([
  z.object({ error: wireError }),
  z.object({ pending: z.number() }),
  z.object({ method: z.literal(true) }),
  z.object({ value: z.unknown() }),
]);

export type SyncReply = z.infer<typeof syncReply>;

export const startData = z.object({
  code: z.string(),
  port: z.instanceof(MessagePort),
  flag: z.instanceof(SharedArrayBuffer),
  scope: z.number(),
  page: z.unknown(),
  context: z.unknown(),
});
