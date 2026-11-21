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

export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
) {
  const results = Array.from<R | undefined>({ length: items.length });
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    if (signal?.aborted) return;
    const next = queue.next();
    if (next.done) return;
    const [index, item] = next.value;
    results[index] = await work(item, index);
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
