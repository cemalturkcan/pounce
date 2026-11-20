import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { loadConfig, type Config } from "./config.ts";
import { copyStable, ImportError, importProfile, renderImportFailure, renderImportReport, type ImportOptions } from "./import-profile.ts";

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-agent-import-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fakeChrome(name: string) {
  const userData = path.join(root, name, "chrome");
  const profile = path.join(userData, "Default");
  await mkdir(path.join(profile, "Local Storage", "leveldb"), { recursive: true });
  const database = new DatabaseSync(path.join(profile, "Cookies"));
  database.exec("CREATE TABLE cookies (name TEXT, value TEXT); INSERT INTO cookies VALUES ('sid', 'abc');");
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

  const report = await importProfile(config, options);

  assert.ok(report.backup);
  assert.equal(await readFile(path.join(report.backup, "Default", "Bookmarks"), "utf8"), "old agent bookmarks");
  assert.equal(await readFile(path.join(config.profileDir, "Default", "Bookmarks"), "utf8"), '{"roots":{}}');
  assert.deepEqual(await readdir(path.join(config.profileDir, "Default", "Local Storage", "leveldb")), ["000001.log"]);
  const copied = new DatabaseSync(path.join(config.profileDir, "Default", "Cookies"), { readOnly: true });
  assert.deepEqual({ ...(copied.prepare("SELECT value FROM cookies").get() as object) }, { value: "abc" });
  copied.close();
  assert.ok(report.copied.includes("Cookies") && report.copied.includes("Local Storage/"));
  assert.deepEqual(report.unstable, []);
  const siblings = await readdir(path.dirname(config.profileDir));
  assert.equal(siblings.filter((entry) => entry.includes(".importing-")).length, 0);
  const text = renderImportReport(config, options, report);
  assert.match(text, new RegExp(`Previous agent profile moved to ${report.backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("a failed import leaves the existing profile in place and says so", async () => {
  const from = await fakeChrome("fail");
  await rm(path.join(from, "Default", "Bookmarks"));
  await mkdir(path.join(from, "Default", "Bookmarks"));
  const config = configFor("fail");
  await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
  await writeFile(path.join(config.profileDir, "Default", "Bookmarks"), "keep me");

  const error = await importProfile(config, { from, profile: "Default", live: false }).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof ImportError, String(error));
  assert.equal(await readFile(path.join(config.profileDir, "Default", "Bookmarks"), "utf8"), "keep me");
  const siblings = await readdir(path.dirname(config.profileDir));
  assert.equal(siblings.filter((entry) => entry.includes(".importing-") || entry.includes(".bak-")).length, 0);
  const text = renderImportFailure(config, error);
  assert.match(text, /Import failed while copying/);
  assert.match(text, new RegExp(`No backup was made; the agent profile at ${config.profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} was not moved`));
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
  assert.deepEqual(settled, { healthy: true, stable: true });
  assert.equal(calls, 2);

  let writes = 0;
  const restless = await copyStable([source], async () => {
    writes += 1;
    await appendFile(source, `-${writes}`);
    return true;
  });
  assert.deepEqual(restless, { healthy: true, stable: false });
  assert.equal(writes, 3);
});
