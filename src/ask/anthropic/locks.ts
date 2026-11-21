import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { repeatUntil } from "../../shared/async.ts";
import { ToolError } from "../../shared/errors.ts";
import { errorCode } from "./errors.ts";

export const REFRESH_RACE_POLL_MS = 100;
const REFRESH_LOCK_STALE_MS = 60_000;

const NO_LOCK = async () => undefined;

async function tryLock(
  lockPath: string,
  staleMs: number,
): Promise<(() => Promise<void>) | undefined> {
  try {
    await mkdir(lockPath);
    const { birthtimeMs } = await lstat(lockPath);
    return async () => {
      const lock = await lstat(lockPath).catch(() => undefined);
      if (lock?.birthtimeMs === birthtimeMs) await rmdir(lockPath).catch(() => undefined);
    };
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause;
  }
  const lock = await lstat(lockPath).catch(() => undefined);
  const stale = lock !== undefined && Date.now() - lock.mtimeMs > staleMs;
  if (
    stale &&
    (await rmdir(lockPath).then(
      () => true,
      () => false,
    ))
  )
    return tryLock(lockPath, staleMs);
  return undefined;
}

export function acquireLock(lockPath: string, signal: AbortSignal, staleMs: number) {
  return repeatUntil(() => tryLock(lockPath, staleMs), {
    delayMs: () => REFRESH_RACE_POLL_MS,
    signal,
  });
}

export function proceedWithoutLock(cause: unknown) {
  if (errorCode(cause) === undefined) throw cause;
  return NO_LOCK;
}

export async function withRefreshLocks<T>(
  credentialsPath: string,
  signal: AbortSignal,
  run: () => Promise<T>,
) {
  const configDir = path.dirname(credentialsPath);
  const legacyLockPath = `${await realpath(configDir).catch(() => configDir)}.lock`;
  const lockPath = path.join(configDir, ".oauth_refresh.lock");
  const held = await repeatUntil(
    async () => {
      const releaseLock = await acquireLock(lockPath, signal, REFRESH_LOCK_STALE_MS).catch(
        (cause: unknown) => {
          const code = errorCode(cause);
          if (code === undefined || signal.aborted) throw cause;
          throw new ToolError(
            `Could not lock ${lockPath} to refresh the Claude session (${code}).`,
          );
        },
      );
      const releaseLegacyLock = await tryLock(legacyLockPath, REFRESH_LOCK_STALE_MS).catch(
        proceedWithoutLock,
      );
      if (!releaseLegacyLock) {
        await releaseLock();
        return undefined;
      }
      try {
        return { value: await run() };
      } finally {
        await releaseLegacyLock();
        await releaseLock();
      }
    },
    { delayMs: () => REFRESH_RACE_POLL_MS, signal },
  );
  return held.value;
}
