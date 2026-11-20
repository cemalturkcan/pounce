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
};

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

async function copySqlite(source: string, target: string) {
  await mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    for (const suffix of ["", ...SIDECAR_SUFFIXES]) {
      await rm(target + suffix, { force: true });
      if (await exists(source + suffix)) await cp(source + suffix, target + suffix);
    }
    if (isHealthy(target)) return true;
  }
  for (const suffix of ["", ...SIDECAR_SUFFIXES]) await rm(target + suffix, { force: true });
  return false;
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

  const report: ImportReport = { copied: [], skipped: [], failed: [] };
  const existing = await readdir(config.profileDir).catch(() => [] as string[]);
  if (existing.length > 0) {
    report.backup = `${config.profileDir}.bak-${timestampSlug()}`;
    await rename(config.profileDir, report.backup);
  }
  const targetDir = path.join(config.profileDir, "Default");
  await mkdir(targetDir, { recursive: true });

  for (const name of SQLITE_FILES) {
    const source = path.join(sourceDir, name);
    if (!(await exists(source))) {
      report.skipped.push(name);
      continue;
    }
    ((await copySqlite(source, path.join(targetDir, name))) ? report.copied : report.failed).push(name);
  }
  for (const name of PLAIN_FILES) {
    const source = path.join(sourceDir, name);
    if (!(await exists(source))) {
      report.skipped.push(name);
      continue;
    }
    await cp(source, path.join(targetDir, name));
    report.copied.push(name);
  }
  for (const name of DIRECTORIES) {
    const source = path.join(sourceDir, name);
    if (!(await exists(source))) {
      report.skipped.push(name);
      continue;
    }
    await cp(source, path.join(targetDir, name), { recursive: true, filter: (entry) => path.basename(entry) !== "LOCK" });
    report.copied.push(`${name}/`);
  }
  return report;
}

export function renderImportReport(config: Config, options: ImportOptions, report: ImportReport) {
  return [
    `Imported ${path.join(options.from, options.profile)} into ${path.join(config.profileDir, "Default")}`,
    report.backup ? `Previous agent profile moved to ${report.backup}` : "No previous agent profile existed.",
    `Copied: ${report.copied.join(", ") || "nothing"}`,
    report.skipped.length ? `Not present in source: ${report.skipped.join(", ")}` : "",
    report.failed.length ? `FAILED integrity check (not imported): ${report.failed.join(", ")}. Close Chrome and run the import again.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
