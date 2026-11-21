import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { loadConfig, type Config } from "../config/config.ts";
import {
  copyStable,
  ImportError,
  importProfile,
  renderImportFailure,
  renderImportReport,
  type ImportOptions,
} from "./import-profile.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-agent-import-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeChrome(name: string) {
  const userData = path.join(root, name, "chrome");
  const profile = path.join(userData, "Default");
  await mkdir(path.join(profile, "Local Storage", "leveldb"), { recursive: true });
  const database = new Database(path.join(profile, "Cookies"));
  database.exec(
    "CREATE TABLE cookies (name TEXT, value TEXT); INSERT INTO cookies VALUES ('sid', 'abc');",
  );
  database.close();
  await writeFile(path.join(profile, "Bookmarks"), '{"roots":{}}');
  await writeFile(path.join(profile, "Local Storage", "leveldb", "000001.log"), "storage");
  await writeFile(path.join(profile, "Local Storage", "leveldb", "LOCK"), "");
  return userData;
}

function configFor(name: string): Config {
  return loadConfig({ WEB_AGENT_DAEMON_DATA_DIR: path.join(root, name, "data") });
}

test("import copies into a staging folder and swaps it in, keeping a backup", async () => {
  const from = await fakeChrome("swap");
  const config = configFor("swap");
  await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
  await writeFile(path.join(config.profileDir, "Default", "Bookmarks"), "old agent bookmarks");
  const options: ImportOptions = { from, profile: "Default", live: false };

  const report = await importProfile(config, options, () => false);

  expect(report.backup).toStartWith(`${config.profileDir}.bak-`);
  expect(await readFile(path.join(report.backup ?? "", "Default", "Bookmarks"), "utf8")).toBe(
    "old agent bookmarks",
  );
  expect(await readFile(path.join(config.profileDir, "Default", "Bookmarks"), "utf8")).toBe(
    '{"roots":{}}',
  );
  expect(
    await readdir(path.join(config.profileDir, "Default", "Local Storage", "leveldb")),
  ).toStrictEqual(["000001.log"]);
  const copied = new Database(path.join(config.profileDir, "Default", "Cookies"), {
    readonly: true,
  });
  expect(copied.query("SELECT value FROM cookies").get()).toStrictEqual({ value: "abc" });
  copied.close();
  expect(report.copied).toEqual(expect.arrayContaining(["Cookies", "Local Storage/"]));
  expect(report.unstable).toStrictEqual([]);
  const siblings = await readdir(path.dirname(config.profileDir));
  expect(siblings.filter((entry) => entry.includes(".importing-")).length).toBe(0);
  const text = renderImportReport(config, options, report);
  expect(text).toMatch(
    new RegExp(
      `Previous agent profile moved to ${report.backup?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    ),
  );
});

test("a failed import leaves the existing profile in place and says so", async () => {
  const from = await fakeChrome("fail");
  await rm(path.join(from, "Default", "Bookmarks"));
  await mkdir(path.join(from, "Default", "Bookmarks"));
  const config = configFor("fail");
  await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
  await writeFile(path.join(config.profileDir, "Default", "Bookmarks"), "keep me");

  const error = await importProfile(
    config,
    { from, profile: "Default", live: false },
    () => false,
  ).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  expect(error).toBeInstanceOf(ImportError);
  if (!(error instanceof ImportError)) throw error;
  expect(await readFile(path.join(config.profileDir, "Default", "Bookmarks"), "utf8")).toBe(
    "keep me",
  );
  const siblings = await readdir(path.dirname(config.profileDir));
  expect(
    siblings.filter((entry) => entry.includes(".importing-") || entry.includes(".bak-")).length,
  ).toBe(0);
  const text = renderImportFailure(config, error);
  expect(text).toMatch(/Import failed while copying/);
  expect(text).toMatch(
    new RegExp(
      `No backup was made; the agent profile at ${config.profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} was not moved`,
    ),
  );
});

test("copyStable retries when the source changes during a copy and flags a source that keeps changing", async () => {
  const dir = path.join(root, "stable");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, "file");
  await writeFile(source, "v1");

  let calls = 0;
  const settled = await copyStable([source], async () => {
    calls += 1;
    if (calls === 1) await appendFile(source, "-changed");
    return true;
  });
  expect(settled).toStrictEqual({ healthy: true, stable: true });
  expect(calls).toBe(2);

  let writes = 0;
  const restless = await copyStable([source], async () => {
    writes += 1;
    await appendFile(source, `-${writes}`);
    return true;
  });
  expect(restless).toStrictEqual({ healthy: true, stable: false });
  expect(writes).toBe(3);
});
