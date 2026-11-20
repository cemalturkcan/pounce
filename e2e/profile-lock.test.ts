import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { TIMED_OUT, withDeadline } from "../src/async.ts";
import { BrowserManager } from "../src/browser.ts";
import { loadConfig } from "../src/config.ts";
import { clearStaleProfileLock } from "../src/profile-lock.ts";

const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY"];

let dataDir: string;
let manager: BrowserManager;
const savedDisplay = new Map<string, string | undefined>();

before(async () => {
  for (const key of DISPLAY_KEYS) {
    savedDisplay.set(key, process.env[key]);
    delete process.env[key];
  }
  dataDir = await mkdtemp(path.join(tmpdir(), "web-agent-lock-e2e-"));
  const profileDir = path.join(dataDir, "profile");
  await mkdir(profileDir);
  await symlink(`old-${hostname()}-${process.pid}`, path.join(profileDir, "SingletonLock"));
  manager = new BrowserManager(
    loadConfig({ WEB_AGENT_DATA_DIR: dataDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE }),
  );
});

after(async () => {
  await manager?.shutdown();
  for (const [key, value] of savedDisplay) if (value !== undefined) process.env[key] = value;
  await rm(dataDir, { recursive: true, force: true });
});

test("launch proceeds when the profile has a lock written by another host", async () => {
  const launched = await withDeadline(manager.ensureContext().then(() => "launched", (error: Error) => error.message.split("\n")[0]), 30_000);
  assert.equal(launched === TIMED_OUT ? "timed out" : launched, "launched");
});

test("a lock held by the running Chrome of the profile is kept", async () => {
  const profileDir = manager.config.profileDir;
  assert.equal(await clearStaleProfileLock(profileDir), "in-use");
  assert.ok(await lstat(path.join(profileDir, "SingletonLock")));
});
