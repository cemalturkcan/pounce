import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { messagesUrl, profileUrl, tokenUrl } from "../../../tests/anthropicServer.ts";
import {
  authorization,
  input,
  refreshed,
  rejectionOf,
  streamReply,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import type { JsonObject } from "../adapter.ts";
import { AskSetupError } from "../errors.ts";
import { ToolError } from "../../shared/errors.ts";

const { anthropic, credentialFixture } = useAnthropicAdapter();

test("Anthropic adapter refreshes an expiring session once and atomically saves the rotated tokens", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply((call) =>
    call.url === tokenUrl
      ? Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
        })
      : streamReply("OK"),
  );
  const [first, second] = await Promise.all([adapter.complete(input), adapter.complete(input)]);
  expect(first.text).toBe("OK");
  expect(second.text).toBe("OK");
  const refreshes = anthropic.callsTo(tokenUrl);
  expect(refreshes).toHaveLength(1);
  const refreshBody = JSON.parse(refreshes[0]?.body ?? "null");
  expect(refreshBody.refresh_token).toBe("old-refresh");
  expect(refreshBody.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  expect(refreshBody.scope).toMatch(/user:inference/);
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer new-access",
    "Bearer new-access",
  ]);
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  expect(saved.claudeAiOauth.accessToken).toBe("new-access");
  expect(saved.claudeAiOauth.refreshToken).toBe("new-refresh");
  expect(saved.claudeAiOauth.expiresAt > Date.now() + 60 * 60_000).toBe(true);
});

test("Anthropic adapter retries token refresh without scopes when the endpoint rejects the scope", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let refreshCalls = 0;
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    refreshCalls += 1;
    if (refreshCalls === 1) return Response.json({ error: "invalid_scope" }, { status: 400 });
    return Response.json({ access_token: "new-access", expires_in: 3600 });
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(JSON.parse(anthropic.callsTo(tokenUrl)[1]?.body ?? "null").scope).toBeUndefined();
  expect(refreshCalls).toBe(2);
});

test("Anthropic adapter does not overwrite credentials refreshed concurrently by Claude Code", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await writeSession(
      "external-access",
      Date.now() + 60 * 60_000,
      "account-test",
      "external-refresh",
    );
    return refreshed("mcp-access", "mcp-refresh");
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer external-access",
  ]);
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  expect(saved.claudeAiOauth.accessToken).toBe("external-access");
  expect(saved.claudeAiOauth.refreshToken).toBe("external-refresh");
});

test("Anthropic adapter uses credentials Claude Code refreshed while its own refresh was rejected", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await writeSession(
      "external-access",
      Date.now() + 60 * 60_000,
      "account-test",
      "external-refresh",
    );
    return Response.json(
      { error: "invalid_grant", error_description: "Refresh token already used" },
      { status: 400 },
    );
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer external-access",
  ]);
});

test("Anthropic adapter waits briefly for a concurrent refresh that writes after its own was rejected", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    setTimeout(
      () =>
        void writeSession(
          "external-access",
          Date.now() + 60 * 60_000,
          "account-test",
          "external-refresh",
        ),
      300,
    );
    return Response.json({ error: "invalid_grant" }, { status: 400 });
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer external-access",
  ]);
});

test("Anthropic adapter masks both tokens in refresh errors", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply(() =>
    Response.json(
      { error: "invalid_grant", error_description: "old-access and old-refresh are revoked" },
      { status: 400 },
    ),
  );
  const completion = adapter.complete(input);
  await expect(completion).rejects.toThrow();
  const message = (await rejectionOf(completion)).message;
  expect(message).not.toMatch(/old-access|old-refresh/);
  expect(message).toMatch(/\[REDACTED\] and \[REDACTED\] are revoked/);
});

test("Anthropic adapter saves its refreshed tokens over credentials another client blanked", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await writeFile(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 },
        accountUuid: "account-test",
      }),
    );
    return refreshed();
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  expect(saved.claudeAiOauth.accessToken).toBe("new-access");
  expect(saved.claudeAiOauth.refreshToken).toBe("new-refresh");
});

test("Anthropic adapter refreshes with the client id stored in the credentials", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  await writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
        clientId: "stored-client",
      },
      accountUuid: "account-test",
    }),
  );
  anthropic.reply((call) =>
    call.url === tokenUrl
      ? Response.json({ access_token: "new-access", expires_in: 3600 })
      : streamReply("OK"),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(JSON.parse(anthropic.callsTo(tokenUrl)[0]?.body ?? "null").client_id).toBe(
    "stored-client",
  );
});

test("Anthropic adapter writes refreshed tokens through a symlinked credentials file", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  const target = `${credentialsPath}.real`;
  await writeFile(
    target,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
      },
      accountUuid: "account-test",
    }),
  );
  await symlink(target, credentialsPath);
  anthropic.reply((call) => (call.url === tokenUrl ? refreshed() : streamReply("OK")));
  expect((await adapter.complete(input)).text).toBe("OK");
  expect((await lstat(credentialsPath)).isSymbolicLink()).toBe(true);
  expect(JSON.parse(await readFile(target, "utf8")).claudeAiOauth.accessToken).toBe("new-access");
});

test("Anthropic adapter does not sign back in when the session was logged out during its refresh", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await writeFile(credentialsPath, JSON.stringify({ mcpOAuth: {} }));
    return refreshed();
  });
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
  expect(JSON.parse(await readFile(credentialsPath, "utf8")).claudeAiOauth).toBeUndefined();
});

test("Anthropic adapter reports a credentials file holding null as a sign-in problem", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  await writeFile(credentialsPath, "null");
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
});

test("Anthropic adapter keeps the session's extra scopes when refreshing and saves the granted ones", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  await writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
        scopes: ["user:inference", "user:projects:read"],
      },
      accountUuid: "account-test",
    }),
  );
  anthropic.reply((call) =>
    call.url === tokenUrl
      ? Response.json({
          access_token: "new-access",
          expires_in: 3600,
          scope: "user:inference user:projects:read user:profile",
        })
      : streamReply("OK"),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(JSON.parse(anthropic.callsTo(tokenUrl)[0]?.body ?? "null").scope).toMatch(
    /(^| )user:projects:read( |$)/,
  );
  expect(JSON.parse(await readFile(credentialsPath, "utf8")).claudeAiOauth.scopes).toStrictEqual([
    "user:inference",
    "user:projects:read",
    "user:profile",
  ]);
});

test("Anthropic adapter falls back to the session's stored scopes when the defaults are rejected", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  await writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1,
        scopes: ["user:inference"],
      },
      accountUuid: "account-test",
    }),
  );
  const scopes: unknown[] = [];
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    scopes.push(JSON.parse(call.body).scope);
    return scopes.length === 1
      ? Response.json({ error: "invalid_scope" }, { status: 400 })
      : Response.json({ access_token: "new-access", expires_in: 3600 });
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(scopes[1]).toBe("user:inference");
});

function expiredSessionWith(mcpOAuth: JsonObject) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: Date.now() - 1,
    },
    accountUuid: "account-test",
    mcpOAuth,
  });
}

test("Anthropic adapter saves refreshed tokens under Claude Code's credentials write lock", async () => {
  const { adapter, credentialsPath } = await credentialFixture();
  await writeFile(credentialsPath, expiredSessionWith({}));
  const writeLock = path.join(path.dirname(credentialsPath), ".storage-write.lock");
  await mkdir(writeLock);
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    setTimeout(async () => {
      await writeFile(credentialsPath, expiredSessionWith({ server: "token" }));
      await rmdir(writeLock);
    }, 300);
    return refreshed();
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  expect(saved.claudeAiOauth.accessToken).toBe("new-access");
  expect(saved.mcpOAuth).toStrictEqual({ server: "token" });
});

test("Anthropic adapter does not resend a refresh token the server already rejected", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "dead-refresh");
  anthropic.reply(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
  const startedAt = Date.now();
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
  expect(anthropic.calls).toHaveLength(1);
  expect(Date.now() - startedAt).toBeLessThan(500);
});

test("Anthropic sends refresh and profile requests without following redirects", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, null, "old-refresh");
  anthropic.reply((call) => {
    if (call.url === tokenUrl)
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    if (call.url === profileUrl) return Response.json({ account: { uuid: "profile-account" } });
    return streamReply("OK");
  });
  await adapter.complete(input);
  expect(anthropic.calls.map((call) => [call.url, call.redirect])).toStrictEqual([
    [tokenUrl, "error"],
    [profileUrl, "error"],
    [messagesUrl, "error"],
  ]);
});

test("Anthropic adapter retries a refresh token after a failure other than invalid_grant", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let refreshCalls = 0;
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    refreshCalls += 1;
    return refreshCalls === 1 ? new Response("<html>blocked</html>", { status: 403 }) : refreshed();
  });
  const error = await rejectionOf(adapter.complete(input));
  expect(error).toBeInstanceOf(ToolError);
  expect(error).not.toBeInstanceOf(AskSetupError);
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(refreshCalls).toBe(2);
});

test("Anthropic adapter reads an object-shaped invalid_scope error", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let refreshCalls = 0;
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    refreshCalls += 1;
    return refreshCalls === 1
      ? Response.json({ error: { type: "invalid_scope" } }, { status: 400 })
      : Response.json({ access_token: "new-access", expires_in: 3600 });
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(refreshCalls).toBe(2);
});

test("Anthropic adapter writes refreshed tokens in place when the file cannot be replaced", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const dir = path.dirname(credentialsPath);
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await chmod(dir, 0o555);
    return refreshed();
  });
  try {
    expect((await adapter.complete(input)).text).toBe("OK");
  } finally {
    await chmod(dir, 0o755);
  }
  expect(JSON.parse(await readFile(credentialsPath, "utf8")).claudeAiOauth.refreshToken).toBe(
    "new-refresh",
  );
});

test("Anthropic adapter reports an unreadable credentials file as a call failure, not a sign-in problem", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("test-token");
  await chmod(credentialsPath, 0o000);
  try {
    const error = await rejectionOf(adapter.complete(input));
    expect(error).toBeInstanceOf(ToolError);
    expect(error).not.toBeInstanceOf(AskSetupError);
  } finally {
    await chmod(credentialsPath, 0o600);
  }
});

test("missing or expired session is reported before sending the prompt", async () => {
  const { adapter, writeSession } = await credentialFixture();
  anthropic.reply(() => new Response());
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
  await writeSession("expired-token", Date.now() - 1);
  await expect(adapter.complete(input)).rejects.toThrow(/expired without a refresh token/);
  expect(anthropic.calls).toHaveLength(0);
});
