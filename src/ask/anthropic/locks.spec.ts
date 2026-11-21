import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { messagesUrl, tokenUrl } from "../../../tests/anthropicServer.ts";
import {
  authorization,
  input,
  refreshed,
  streamReply,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import { anthropicAskAdapter, settleClaudeRefreshes } from "./adapter.ts";
import { repeatUntil, sleep } from "../../shared/async.ts";
import { ToolError } from "../../shared/errors.ts";

const { anthropic, cleanups, credentialFixture } = useAnthropicAdapter();

test("Anthropic adapter waits for Claude Code's refresh lock and uses the tokens it saved", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const lock = path.join(path.dirname(credentialsPath), ".oauth_refresh.lock");
  await mkdir(lock);
  setTimeout(async () => {
    await writeSession(
      "external-access",
      Date.now() + 60 * 60_000,
      "account-test",
      "external-refresh",
    );
    await rmdir(lock);
  }, 300);
  anthropic.reply(() => streamReply("OK"));
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer external-access",
  ]);
  expect(anthropic.callsTo(tokenUrl)).toHaveLength(0);
});

test("Anthropic adapter holds both refresh locks while refreshing and releases them after", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const dir = path.dirname(credentialsPath);
  const locks = [path.join(dir, ".oauth_refresh.lock"), `${dir}.lock`];
  const heldDuringRefresh: boolean[] = [];
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    const held = await Promise.all(locks.map(async (lock) => (await lstat(lock)).isDirectory()));
    heldDuringRefresh.push(...held);
    return refreshed();
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(heldDuringRefresh).toStrictEqual([true, true]);
  await Promise.all(
    locks.map((lock) => expect(lstat(lock)).rejects.toHaveProperty("code", "ENOENT")),
  );
});

test("Anthropic adapter takes over a stale refresh lock", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const lock = path.join(path.dirname(credentialsPath), ".oauth_refresh.lock");
  await mkdir(lock);
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  anthropic.reply((call) => (call.url === tokenUrl ? refreshed() : streamReply("OK")));
  expect((await adapter.complete(input)).text).toBe("OK");
});

test("Anthropic adapter does not spin on a stale lock it cannot remove", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const lock = path.join(path.dirname(credentialsPath), ".oauth_refresh.lock");
  await writeFile(lock, "not a directory");
  const old = new Date(Date.now() - 120_000);
  await utimes(lock, old, old);
  anthropic.reply((call) => (call.url === tokenUrl ? refreshed() : streamReply("OK")));
  const controller = new AbortController();
  const started = process.cpuUsage();
  const pending = adapter.complete({ ...input, signal: controller.signal });
  await sleep(1_000);
  const used = process.cpuUsage(started);
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow(/caller cancelled/);
  await rm(lock);
  await settleClaudeRefreshes();
  expect(used.user + used.system).toBeLessThan(300_000);
});

test("Anthropic adapter refreshes without the legacy lock when it cannot be created", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "web-agent-ask-parent-"));
  cleanups.push(async () => {
    await chmod(parent, 0o755);
    await rm(parent, { recursive: true, force: true });
  });
  const dir = path.join(parent, "claude");
  await mkdir(dir);
  await writeFile(
    path.join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
      },
      accountUuid: "account-test",
    }),
  );
  await chmod(parent, 0o555);
  anthropic.reply((call) => (call.url === tokenUrl ? refreshed() : streamReply("OK")));
  expect((await anthropicAskAdapter(dir).complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual(["Bearer new-access"]);
});

test("Anthropic adapter releases the refresh lock while the legacy lock is busy", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const dir = path.dirname(credentialsPath);
  const legacy = `${dir}.lock`;
  await mkdir(legacy);
  const controller = new AbortController();
  anthropic.reply((call) => (call.url === tokenUrl ? refreshed() : streamReply("OK")));
  const pending = adapter.complete({ ...input, signal: controller.signal });
  await sleep(300);
  const mainLock = path.join(dir, ".oauth_refresh.lock");
  const acquired = await repeatUntil(
    () =>
      mkdir(mainLock).then(
        () => true,
        () => undefined,
      ),
    { delayMs: () => 25, giveUp: (made) => made >= 20 },
  );
  expect(acquired).toBe(true);
  await rmdir(mainLock);
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow(/caller cancelled/);
  await rmdir(legacy);
  await settleClaudeRefreshes();
});

test("Anthropic adapter reports a config dir it cannot lock as a call failure", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const dir = path.dirname(credentialsPath);
  await chmod(dir, 0o555);
  anthropic.reply(() => streamReply("OK"));
  try {
    const completion = adapter.complete(input);
    await expect(completion).rejects.toThrow();
    await expect(completion).rejects.toBeInstanceOf(ToolError);
  } finally {
    await chmod(dir, 0o755);
  }
});
