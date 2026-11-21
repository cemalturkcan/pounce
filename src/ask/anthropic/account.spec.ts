import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { messagesUrl, profileUrl } from "../../../tests/anthropicServer.ts";
import {
  input,
  rejectionOf,
  streamReply,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import { simulateNetworkFailure } from "../../../tests/unitFetchServer.ts";
import { anthropicAskAdapter } from "./adapter.ts";
import { AskSetupError } from "../errors.ts";
import { sleep } from "../../shared/async.ts";
import { ToolError } from "../../shared/errors.ts";

const { anthropic, cleanups, credentialFixture, sentJson } = useAnthropicAdapter();

test("Anthropic adapter resolves and caches the account UUID from the Claude profile", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 10 * 60_000, null);
  anthropic.reply((call) =>
    call.url === profileUrl
      ? Response.json({ account: { uuid: "profile-account" } })
      : streamReply("OK"),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(profileUrl)).toHaveLength(1);
  const body = JSON.parse(anthropic.callsTo(messagesUrl)[0]?.body ?? "null");
  expect(JSON.parse(body.metadata.user_id).account_uuid).toBe("profile-account");
});

test("Anthropic adapter retries a transient profile failure", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 60 * 60_000, null);
  let profileCalls = 0;
  anthropic.reply((call) => {
    if (call.url !== profileUrl) return streamReply("OK");
    profileCalls += 1;
    return profileCalls === 1
      ? new Response("unavailable", { status: 503 })
      : Response.json({ account: { uuid: "profile-account" } });
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(profileCalls).toBe(2);
});

test("Anthropic adapter reads the profile once for concurrent first calls", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 60 * 60_000, null);
  anthropic.reply(async (call) => {
    if (call.url !== profileUrl) return streamReply("OK");
    await sleep(50);
    return Response.json({ account: { uuid: "profile-account" } });
  });
  await Promise.all([adapter.complete(input), adapter.complete(input), adapter.complete(input)]);
  expect(anthropic.callsTo(profileUrl)).toHaveLength(1);
});

test("Anthropic adapter takes the account UUID from Claude Code's global config before asking the profile endpoint", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 60 * 60_000, null);
  await writeFile(
    path.join(path.dirname(credentialsPath), ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "config-account" } }),
  );
  anthropic.reply(() => streamReply("OK"));
  await adapter.complete(input);
  expect(anthropic.calls).toHaveLength(1);
  expect(JSON.parse(sentJson().metadata.user_id).account_uuid).toBe("config-account");
});

test("Anthropic adapter reads the global config inside an explicit CLAUDE_CONFIG_DIR", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "web-agent-ask-home-"));
  const saved = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  cleanups.push(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const configDir = path.join(home, ".claude");
  await mkdir(configDir);
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  await writeFile(
    path.join(configDir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: "test-token", expiresAt: Date.now() + 60 * 60_000 },
    }),
  );
  await writeFile(
    path.join(configDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "inner-account" } }),
  );
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "home-account" } }),
  );
  anthropic.reply(() => streamReply("OK"));
  await anthropicAskAdapter().complete(input);
  expect(JSON.parse(sentJson().metadata.user_id).account_uuid).toBe("inner-account");
});

test("Anthropic adapter prefers Claude Code's legacy .config.json for the account UUID", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 60 * 60_000, null);
  const dir = path.dirname(credentialsPath);
  await writeFile(
    path.join(dir, ".config.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "legacy-account" } }),
  );
  await writeFile(
    path.join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { accountUuid: "config-account" } }),
  );
  anthropic.reply(() => streamReply("OK"));
  await adapter.complete(input);
  expect(JSON.parse(sentJson().metadata.user_id).account_uuid).toBe("legacy-account");
});

test("Anthropic retries profile network failures, then reports them with their cause and masks the token", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token", Date.now() + 10 * 60_000, null);
  anthropic.reply(() =>
    simulateNetworkFailure(
      Object.assign(new Error("DNS failed for test-token"), { code: "ENOTFOUND" }),
    ),
  );
  const error = await rejectionOf(adapter.complete(input));
  expect(error).toBeInstanceOf(ToolError);
  expect(error).not.toBeInstanceOf(AskSetupError);
  expect(anthropic.calls).toHaveLength(3);
  expect(error.message).toMatch(/profile: ENOTFOUND: DNS failed for \[REDACTED\]/);
});
