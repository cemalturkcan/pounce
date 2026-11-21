import { afterAll, beforeAll, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { TIMED_OUT, withDeadline } from "../src/shared/async.ts";
import { BrowserManager } from "../src/browser/manager.ts";
import { loadConfig } from "../src/config/config.ts";
import { clearStaleProfileLock } from "../src/browser/profile-lock.ts";

const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY"];

let dataDir: string;
let manager: BrowserManager;
const savedDisplay = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of DISPLAY_KEYS) {
    savedDisplay.set(key, process.env[key]);
    delete process.env[key];
  }
  dataDir = await mkdtemp(path.join(tmpdir(), "web-agent-lock-e2e-"));
  const profileDir = path.join(dataDir, "profile");
  await mkdir(profileDir);
  await symlink(`old-${hostname()}-${process.pid}`, path.join(profileDir, "SingletonLock"));
  manager = new BrowserManager(
    loadConfig({
      WEB_AGENT_DATA_DIR: dataDir,
      WEB_AGENT_HEADLESS: "true",
      WEB_AGENT_PASSWORD_STORE: "basic",
      WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE,
    }),
  );
});

afterAll(async () => {
  await manager?.shutdown();
  for (const [key, value] of savedDisplay) if (value !== undefined) process.env[key] = value;
  await rm(dataDir, { recursive: true, force: true });
});

test("launch proceeds when the profile has a lock written by another host", async () => {
  const launched = await withDeadline(
    manager.ensureContext().then(
      () => "launched",
      (error: Error) => error.message.split("\n")[0],
    ),
    30_000,
  );
  expect(launched === TIMED_OUT ? "timed out" : launched).toBe("launched");
});

test("a lock held by the running Chrome of the profile is kept", async () => {
  const profileDir = manager.config.profileDir;
  expect(await clearStaleProfileLock(profileDir)).toBe("in-use");
  expect((await lstat(path.join(profileDir, "SingletonLock"))).isSymbolicLink()).toBe(true);
});
