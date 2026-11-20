import { cp, mkdir, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config.ts";
import { daemonStatus } from "./daemon.ts";
import { timestampSlug } from "./output.ts";

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
const COPY_ATTEMPTS = 3;

export type ImportOptions = {
  from: string;
  profile: string;
  live: boolean;
};

export type ImportReport = {
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
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
      return row !== undefined && Object.values(row)[0] === "ok";
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}

export async function signatureOf(target: string): Promise<Signature> {
  const signature: Signature = new Map();
  const visit = async (entry: string, relative: string) => {
    const info = await stat(entry).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of (await readdir(entry).catch(() => [] as string[])).sort()) {
        if (name !== "LOCK") await visit(path.join(entry, name), path.join(relative, name));
      }
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

export async function copyStable(sources: string[], copy: () => Promise<boolean>, attempts = COPY_ATTEMPTS) {
  let healthy = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await Promise.all(sources.map(signatureOf));
    healthy = await copy();
    const after = await Promise.all(sources.map(signatureOf));
    const stable = before.every((signature, index) => sameSignature(signature, after[index] ?? new Map()));
    if (stable && healthy) return { healthy: true, stable: true };
    if (stable && !healthy) continue;
  }
  return { healthy, stable: false };
}

async function copySqliteOnce(source: string, target: string) {
  for (const suffix of ["", ...SIDECAR_SUFFIXES]) {
    await rm(target + suffix, { force: true });
    if (await exists(source + suffix)) await cp(source + suffix, target + suffix);
  }
  return isHealthy(target);
}

export async function importProfile(config: Config, options: ImportOptions): Promise<ImportReport> {
  const sourceDir = path.join(options.from, options.profile);
  if (!(await exists(sourceDir))) throw new Error(`Source profile not found: ${sourceDir}`);
  if (daemonStatus(config).running) {
    throw new Error("The web-agent daemon is running and owns the agent profile. Stop it first (npm run daemon:stop or systemctl --user stop).");
  }
  if (!options.live && (await sourceChromeRunning(options.from))) {
    throw new Error(`Chrome is running on ${options.from}. Close it for a consistent copy, or pass --live to copy anyway with integrity checks.`);
  }

  const report: ImportReport = { copied: [], skipped: [], failed: [], unstable: [] };
  const stamp = timestampSlug();
  const staging = `${config.profileDir}.importing-${stamp}`;
  const targetDir = path.join(staging, "Default");

  try {
    await rm(staging, { recursive: true, force: true });
    await mkdir(targetDir, { recursive: true });

    for (const name of SQLITE_FILES) {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        continue;
      }
      const target = path.join(targetDir, name);
      await mkdir(path.dirname(target), { recursive: true });
      const result = await copyStable(
        ["", ...SIDECAR_SUFFIXES].map((suffix) => source + suffix),
        () => copySqliteOnce(source, target),
      );
      if (!result.healthy) {
        for (const suffix of ["", ...SIDECAR_SUFFIXES]) await rm(target + suffix, { force: true });
        report.failed.push(name);
        continue;
      }
      report.copied.push(name);
      if (!result.stable) report.unstable.push(name);
    }
    for (const name of PLAIN_FILES) {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        continue;
      }
      const result = await copyStable([source], async () => {
        await cp(source, path.join(targetDir, name));
        return true;
      });
      report.copied.push(name);
      if (!result.stable) report.unstable.push(name);
    }
    for (const name of DIRECTORIES) {
      const source = path.join(sourceDir, name);
      if (!(await exists(source))) {
        report.skipped.push(name);
        continue;
      }
      const target = path.join(targetDir, name);
      const result = await copyStable([source], async () => {
        await rm(target, { recursive: true, force: true });
        await cp(source, target, { recursive: true, filter: (entry) => path.basename(entry) !== "LOCK" });
        return true;
      });
      report.copied.push(`${name}/`);
      if (!result.stable) report.unstable.push(`${name}/`);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw new ImportError(`Import failed while copying: ${error instanceof Error ? error.message : String(error)}`, report, config.profileDir);
  }

  const existing = await readdir(config.profileDir).catch(() => [] as string[]);
  try {
    if (existing.length > 0) {
      report.backup = `${config.profileDir}.bak-${stamp}`;
      await rename(config.profileDir, report.backup);
    } else {
      await rm(config.profileDir, { recursive: true, force: true });
    }
    await rename(staging, config.profileDir);
  } catch (error) {
    if (report.backup && !(await exists(config.profileDir))) await rename(report.backup, config.profileDir).then(() => (report.backup = undefined), () => undefined);
    throw new ImportError(
      `Import failed while swapping the profile into place: ${error instanceof Error ? error.message : String(error)}. The copy is in ${staging}.`,
      report,
      config.profileDir,
    );
  }
  return report;
}

function backupLine(config: Config, report: ImportReport) {
  return report.backup ? `Previous agent profile moved to ${report.backup}` : `No backup was made; the agent profile at ${config.profileDir} was not moved.`;
}

export function renderImportReport(config: Config, options: ImportOptions, report: ImportReport) {
  return [
    `Imported ${path.join(options.from, options.profile)} into ${path.join(config.profileDir, "Default")}`,
    backupLine(config, report),
    `Copied: ${report.copied.join(", ") || "nothing"}`,
    report.skipped.length ? `Not present in source: ${report.skipped.join(", ")}` : "",
    report.failed.length ? `FAILED integrity check (not imported): ${report.failed.join(", ")}. Close Chrome and run the import again.` : "",
    report.unstable.length ? `CHANGED while copying (the copy may be inconsistent): ${report.unstable.join(", ")}. Close Chrome and run the import again.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderImportFailure(config: Config, error: ImportError) {
  return [`${error.message}`, backupLine(config, error.report), error.report.copied.length ? `Copied before the failure (discarded): ${error.report.copied.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");
}
