import { readFile, readlink, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export type LockOutcome = "cleared" | "in-use" | "none";

export async function isChromeUsing(pid: number, profileDir: string) {
  const args = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0");
  if (!/chrom(e|ium)/i.test(path.basename(args[0] ?? ""))) return false;
  const wanted = path.resolve(profileDir);
  return args.some((arg) => arg.startsWith("--user-data-dir=") && path.resolve(arg.slice("--user-data-dir=".length)) === wanted);
}

export async function clearStaleProfileLock(
  profileDir: string,
  isUsing: (pid: number, profileDir: string) => Promise<boolean> = isChromeUsing,
  host = hostname(),
): Promise<LockOutcome> {
  const target = await readlink(path.join(profileDir, "SingletonLock")).catch(() => undefined);
  if (target === undefined) return "none";
  const separator = target.lastIndexOf("-");
  const pid = Number(target.slice(separator + 1));
  const local = separator > 0 && target.slice(0, separator) === host;
  if (local && Number.isInteger(pid) && pid > 0 && (await isUsing(pid, profileDir))) return "in-use";
  for (const name of LOCK_FILES) await rm(path.join(profileDir, name), { force: true });
  return "cleared";
}
