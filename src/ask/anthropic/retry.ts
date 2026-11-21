import { setTimeout as delay } from "node:timers/promises";
import { RetryableAnthropicError } from "./errors.ts";

const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const RETRY_JITTER_MS = 250;
const RETRY_BASE_DELAY_MS = 500;

export function shouldRetry(response: Response) {
  const retry = response.headers.get("x-should-retry");
  const retryableStatus =
    [408, 409, 429].includes(response.status) || (response.status >= 500 && response.status < 600);
  return retry === "true" || (retry !== "false" && retryableStatus);
}

function nextRetryWait(cause: unknown, attempt: number, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!(cause instanceof RetryableAnthropicError)) throw cause;
  const wait = cause.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** attempt;
  if (wait > MAX_RETRY_DELAY_MS) throw cause.waitedTooLong(wait);
  if (attempt >= MAX_RETRIES) throw cause.failure;
  return Math.min(wait + Math.random() * RETRY_JITTER_MS, MAX_RETRY_DELAY_MS);
}

function pauseBeforeRetry(ms: number, signal: AbortSignal) {
  return delay(ms, undefined, { signal }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw cause;
  });
}

export async function withRetries<T>(
  signal: AbortSignal,
  run: (attempt: number) => Promise<T>,
  attempt = 0,
): Promise<T> {
  try {
    return await run(attempt);
  } catch (cause) {
    await pauseBeforeRetry(nextRetryWait(cause, attempt, signal), signal);
  }
  return withRetries(signal, run, attempt + 1);
}

export function retryDelay(response: Response) {
  const numberPattern = /^\d+(\.\d+)?$/;
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds && numberPattern.test(milliseconds)) return Number(milliseconds);
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  if (numberPattern.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
