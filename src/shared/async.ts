import { setTimeout as delay } from "node:timers/promises";

export const TIMED_OUT = Symbol("timed out");

export function sleep(ms: number) {
  return delay(ms);
}

export async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMED_OUT>(
        (resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  const result = await withDeadline(promise, ms);
  if (result === TIMED_OUT) throw onTimeout();
  return result;
}

export async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => Error,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw onAbort();
  }
  let listener: (() => void) | undefined;
  promise.catch(() => undefined);
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(onAbort());
        signal.addEventListener("abort", listener, { once: true });
      }),
    ]);
  } finally {
    if (listener) signal.removeEventListener("abort", listener);
  }
}

type Pace<T> = { gapMs: number; keyOf: (item: T) => string };

export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number, started: () => void) => Promise<R>,
  signal?: AbortSignal,
  pace?: Pace<T>,
) {
  const results = Array.from<R | undefined>({ length: items.length });
  const pending = items.map((item, index) => ({ item, index, key: pace?.keyOf(item) ?? "" }));
  const nextStart = new Map<string, number>();
  let changed = Promise.withResolvers<void>();
  const markChanged = () => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };
  const gapEnds = new Map<string, number>();
  const readyAt = (key: string) => nextStart.get(key) ?? 0;
  const finishPaced = (key: string) => {
    nextStart.set(key, Math.max(gapEnds.get(key) ?? 0, Date.now()));
    markChanged();
  };
  const worker = async (): Promise<void> => {
    if (signal?.aborted || pending.length === 0) return;
    const now = Date.now();
    const position = pending.findIndex((entry) => readyAt(entry.key) <= now);
    if (position === -1) {
      const earliest = Math.min(...pending.map((entry) => readyAt(entry.key)));
      const waits = [changed.promise];
      if (earliest !== Infinity)
        waits.push(delay(earliest - now, undefined, { signal }).catch(() => undefined));
      await Promise.race(waits);
      return worker();
    }
    const [next] = pending.splice(position, 1);
    if (!next) return;
    if (pace) nextStart.set(next.key, Infinity);
    const started = () => {
      if (pace) gapEnds.set(next.key, Date.now() + pace.gapMs);
    };
    try {
      results[next.index] = await work(next.item, next.index, started);
    } finally {
      if (pace) finishPaced(next.key);
    }
    return worker();
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  return results;
}

export function inSequence<T, R>(
  items: readonly T[],
  step: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return items.reduce<Promise<R[]>>(
    (chain, item, index) =>
      chain.then(async (results) => {
        results.push(await step(item, index));
        return results;
      }),
    Promise.resolve([]),
  );
}

type RepeatOptions = {
  delayMs?: (attempts: number) => number;
  signal?: AbortSignal;
  giveUp?: (attempts: number) => boolean;
};

type Attempt<T> = (attempt: number) => Promise<T | undefined>;

async function repeatFrom<T>(
  attempt: Attempt<T>,
  options: RepeatOptions,
  index: number,
): Promise<T | undefined> {
  const value = await attempt(index);
  if (value !== undefined) return value;
  const made = index + 1;
  const { delayMs, signal, giveUp } = options;
  const wait = delayMs?.(made) ?? 0;
  if (wait > 0) await delay(wait, undefined, { signal });
  if (giveUp?.(made)) return undefined;
  return repeatFrom(attempt, options, made);
}

export function repeatUntil<T>(
  attempt: Attempt<T>,
  options: RepeatOptions & { giveUp: (attempts: number) => boolean },
): Promise<T | undefined>;
export function repeatUntil<T>(
  attempt: Attempt<T>,
  options?: Omit<RepeatOptions, "giveUp">,
): Promise<T>;
export async function repeatUntil<T>(attempt: Attempt<T>, options: RepeatOptions = {}) {
  return repeatFrom(attempt, options, 0);
}
