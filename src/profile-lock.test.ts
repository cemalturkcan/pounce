import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearStaleProfileLock } from "./profile-lock.ts";

const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

async function lockedProfile(owner: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "web-agent-lock-"));
  await symlink(owner, path.join(dir, "SingletonLock"));
  await symlink(path.join(tmpdir(), "missing-socket"), path.join(dir, "SingletonSocket"));
  await symlink(String(Math.floor(Math.random() * 1e12)), path.join(dir, "SingletonCookie"));
  return dir;
}

async function present(dir: string) {
  const found: string[] = [];
  for (const name of LOCK_FILES) if (await lstat(path.join(dir, name)).catch(() => undefined)) found.push(name);
  return found;
}

test("a lock held by a local pid that is not chrome on this profile is removed", async () => {
  const dir = await lockedProfile(`${hostname()}-4242`);
  try {
    assert.equal(await clearStaleProfileLock(dir, async () => false), "cleared");
    assert.deepEqual(await present(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock held by a running chrome on this profile is kept", async () => {
  const dir = await lockedProfile(`${hostname()}-4242`);
  try {
    assert.equal(await clearStaleProfileLock(dir, async (pid, profileDir) => pid === 4242 && profileDir === dir), "in-use");
    assert.deepEqual(await present(dir), LOCK_FILES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lock written by another host is removed", async () => {
  const dir = await lockedProfile(`not-${hostname()}-4242`);
  try {
    assert.equal(await clearStaleProfileLock(dir, async () => true), "cleared");
    assert.deepEqual(await present(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a profile without a lock reports none", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "web-agent-lock-"));
  try {
    assert.equal(await clearStaleProfileLock(dir, async () => false), "none");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real process check does not take this test runner for chrome", async () => {
  const dir = await lockedProfile(`${hostname()}-${process.pid}`);
  try {
    assert.equal(await clearStaleProfileLock(dir), "cleared");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
