import { cp, mkdir, readlink, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { inSequence } from "../shared/async.ts";
import { listDir } from "../shared/files.ts";
import type { Config } from "../config/config.ts";
import { messageOf } from "../shared/errors.ts";
import { timestampSlug } from "../shared/output.ts";

const SQLITE_FILES = [
  "Cookies",
  "Network/Cookies",
  "Login Data",
  "Login Data For Account",
  "History",
  "Web Data",
  "Favicons",
  "Top Sites",
];
const PLAIN_FILES = ["Bookmarks", "Preferences", "Secure Preferences"];
const DIRECTORIES = ["Local Storage", "IndexedDB", "Session Storage"];
const SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"];
const SQLITE_PARTS = ["", ...SIDECAR_SUFFIXES];
const COPY_ATTEMPTS = 3;

export type ImportOptions = {
  from: string;
  profile: string;
  live: boolean;
};

type ImportReport = {
  backup?: string;
  copied: string[];
  skipped: string[];
  failed: string[];
  unstable: string[];
};

export class ImportError extends Error {
  readonly report: ImportReport;
  readonly profileDir: string;

  constructor(message: string, report: ImportReport, profileDir: string) {
    super(message);
    this.name = "ImportError";
    this.report = report;
    this.profileDir = profileDir;
  }
}

export class SourceBrowserRunning extends Error {
  constructor(from: string) {
    super(
      `Chrome is running on ${from}. Close it for a consistent copy, or pass --live to copy anyway with integrity checks.`,
    );
    this.name = "SourceBrowserRunning";
  }
}

type Signature = Map<string, string>;

export function defaultImportOptions(args: string[]): ImportOptions {
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  return {
    from: value("--from") ?? path.join(homedir(), ".config", "google-chrome"),
    profile: value("--profile") ?? "Default",
    live: args.includes("--live"),
  };
}

async function exists(target: string) {
  return stat(target).then(
    () => true,
    () => false,
  );
}

async function sourceChromeRunning(userDataDir: string) {
  const lock = await readlink(path.join(userDataDir, "SingletonLock")).catch(() => undefined);
  const pid = Number(lock?.split("-").pop());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isHealthy(file: string) {
  try {
    const database = new Database(file, { readonly: true });
    try {
      return database.query("PRAGMA quick_check").values()[0]?.[0] === "ok";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

async function signatureOf(target: string): Promise<Signature> {
  const signature: Signature = new Map();
  const visit = async (entry: string, relative: string): Promise<void> => {
    const info = await stat(entry).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      const names = (await listDir(entry)).filter((name) => name !== "LOCK").toSorted();
      await inSequence(names, (name) => visit(path.join(entry, name), path.join(relative, name)));
      return;
    }
    signature.set(relative, `${info.size}:${info.mtimeMs}`);
  };
  await visit(target, "");
  return signature;
}

function sameSignature(left: Signature, right: Signature) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

type CopyResult = { healthy: boolean; stable: boolean };

export async function copyStable(
  sources: string[],
  copy: () => Promise<boolean>,
  attempts = COPY_ATTEMPTS,
): Promise<CopyResult> {
  if (attempts <= 0) return { healthy: false, stable: false };
  const before = await Promise.all(sources.map(signatureOf));
  const healthy = await copy();
  const after = await Promise.all(sources.map(signatureOf));
  const stable = before.every((signature, index) =>
    sameSignature(signature, after[index] ?? new Map()),
  );
  if (stable && healthy) return { healthy: true, stable: true };
  if (attempts === 1) return { healthy, stable: false };
  return copyStable(sources, copy, attempts - 1);
}

async function copySqliteOnce(source: string, target: string) {
  await inSequence(SQLITE_PARTS, async (suffix) => {
    await rm(target + suffix, { force: true });
    if (await exists(source + suffix)) await cp(source + suffix, target + suffix);
  });
  return isHealthy(target);
}

function removeSqlite(target: string) {
  return inSequence(SQLITE_PARTS, (suffix) => rm(target + suffix, { force: true }));
}

export async function importProfile(
  config: Config,
  options: ImportOptions,
  daemonRunning: () => Promise<boolean>,
): Promise<ImportReport> {
  const sourceDir = path.join(options.from, options.profile);
  if (!(await exists(sourceDir))) throw new Error(`Source profile not found: ${sourceDir}`);
  if (await daemonRunning()) {
    throw new Error(
      "The pounce daemon is running and owns the agent profile. Stop it first with `pounce daemon stop` (or `systemctl --user stop` for its service).",
    );
  }
  if (!options.live && (await sourceChromeRunning(options.from)))
    throw new SourceBrowserRunning(options.from);

  const report: ImportReport = { copied: [], skipped: [], failed: [], unstable: [] };
  const stamp = timestampSlug();
  const staging = `${config.profileDir}.importing-${stamp}`;
  const targetDir = path.join(staging, "Default");

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    await inSequence(SQLITE_FILES, async (name) => {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        return;
      }
      const target = path.join(targetDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      const result = await copyStable(
        SQLITE_PARTS.map((suffix) => source + suffix),
        () => copySqliteOnce(source, target),
      );
      if (!result.healthy) {
        await removeSqlite(target);
        report.failed.push(name);
        return;
      }
      report.copied.push(name);
      if (!result.stable) report.unstable.push(name);
    });
    await inSequence(PLAIN_FILES, async (name) => {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        return;
      }
      const result = await copyStable([source], async () => {
        await cp(source, path.join(targetDir, name));
        return true;
      });
      report.copied.push(name);
      if (!result.stable) report.unstable.push(name);
    });
    await inSequence(DIRECTORIES, async (name) => {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        return;
      }
      const target = path.join(targetDir, name);
      const result = await copyStable([source], async () => {
        await rm(target, { recursive: true, force: true });
        await cp(source, target, {
          recursive: true,
          filter: (entry) => path.basename(entry) !== "LOCK",
        });
        return true;
      });
      report.copied.push(`${name}/`);
      if (!result.stable) report.unstable.push(`${name}/`);
    });
  } catch (cause) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw new ImportError(
      `Import failed while copying: ${messageOf(cause)}`,
      report,
      config.profileDir,
    );
  }

  const existing = await listDir(config.profileDir);
  try {
    if (existing.length > 0) {
      report.backup = `${config.profileDir}.bak-${stamp}`;
      await rename(config.profileDir, report.backup);
    } else {
      await rm(config.profileDir, { recursive: true, force: true });
    }
    await rename(staging, config.profileDir);
  } catch (cause) {
    if (report.backup && !(await exists(config.profileDir)))
      await rename(report.backup, config.profileDir).then(
        () => (report.backup = undefined),
        () => undefined,
      );
    throw new ImportError(
      `Import failed while swapping the profile into place: ${messageOf(cause)}. The copy is in ${staging}.`,
      report,
      config.profileDir,
    );
  }
  return report;
}

function backupLine(config: Config, report: ImportReport) {
  return report.backup
    ? `Previous agent profile moved to ${report.backup}`
    : `No backup was made; the agent profile at ${config.profileDir} was not moved.`;
}

export function renderImportReport(config: Config, options: ImportOptions, report: ImportReport) {
  return [
    `Imported ${path.join(options.from, options.profile)} into ${path.join(config.profileDir, "Default")}`,
    backupLine(config, report),
    `Copied: ${report.copied.join(", ") || "nothing"}`,
    report.skipped.length ? `Not present in source: ${report.skipped.join(", ")}` : "",
    report.failed.length
      ? `FAILED integrity check (not imported): ${report.failed.join(", ")}. Close Chrome and run the import again.`
      : "",
    report.unstable.length
      ? `CHANGED while copying (the copy may be inconsistent): ${report.unstable.join(", ")}. Close Chrome and run the import again.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderImportFailure(config: Config, error: ImportError) {
  return [
    `${error.message}`,
    backupLine(config, error.report),
    error.report.copied.length
      ? `Copied before the failure (discarded): ${error.report.copied.join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
