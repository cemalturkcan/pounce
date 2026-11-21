import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { messagesUrl, profileUrl, tokenUrl } from "../../../tests/anthropicServer.ts";
import {
  authorization,
  input,
  refreshed,
  rejectionOf,
  streamReply,
  useAnthropicAdapter,
  whenAbortListenerAdded,
} from "../../../tests/anthropicAdapter.ts";
import { simulateNetworkFailure } from "../../../tests/unitFetchServer.ts";
import { settleClaudeRefreshes } from "./adapter.ts";
import { AskSetupError } from "../errors.ts";
import { inSequence, sleep } from "../../shared/async.ts";

const { anthropic, cleanups, credentialFixture, sentJson } = useAnthropicAdapter();

test("Anthropic adapter forwards the prompt, Haiku model, token limit and abort signal", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => streamReply("First second"));
  expect(await adapter.complete(input)).toStrictEqual({
    text: "First second",
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "end_turn",
  });
  await writeSession("new-token");
  await inSequence(["claude-custom", "sonnet", "opus"], (model) =>
    adapter.complete({ ...input, model }),
  );
  const [request, retryRequest, ...aliases] = anthropic.calls;
  expect(request).toBeDefined();
  expect(retryRequest).toBeDefined();
  expect(request?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(request?.redirect).toBe("error");
  expect(request?.signal).toBe(input.signal);
  expect(authorization(request)).toBe("Bearer test-token");
  const body = JSON.parse(request?.body ?? "null");
  expect(body.model).toBe("claude-haiku-5-5");
  expect(body.max_tokens).toBe(123);
  expect(body.stream).toBe(true);
  expect(body.messages).toStrictEqual([{ role: "user", content: input.prompt }]);
  expect(body.system[0].text).toMatch(
    /^x-anthropic-billing-header: cc_version=2\.1\.329\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/,
  );
  expect(body.system[1].text).toBe(
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  expect(body.system[2].text).toBe(input.system);
  expect(JSON.parse(body.metadata.user_id)).toStrictEqual({
    device_id: JSON.parse(body.metadata.user_id).device_id,
    account_uuid: "account-test",
    session_id: JSON.parse(body.metadata.user_id).session_id,
  });
  expect(JSON.parse(body.metadata.user_id).device_id).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.parse(body.metadata.user_id).session_id).toMatch(/^[0-9a-f-]{36}$/);
  const headers = request?.headers;
  expect(headers?.get("anthropic-beta") ?? "").toMatch(/claude-code-20250219/);
  expect(headers?.get("anthropic-beta") ?? "").toMatch(/oauth-2025-04-20/);
  expect(headers?.get("anthropic-dangerous-direct-browser-access")).toBe("true");
  expect(headers?.get("user-agent")).toBe("claude-cli/2.1.329 (external, sdk-cli)");
  expect(headers?.get("x-app")).toBe("cli");
  expect(headers?.get("x-claude-code-session-id")).toBe(
    JSON.parse(body.metadata.user_id).session_id,
  );
  expect(authorization(retryRequest)).toBe("Bearer new-token");
  expect(JSON.parse(retryRequest?.body ?? "null").model).toBe("claude-custom");
  expect(aliases.map((call) => JSON.parse(call.body).model)).toStrictEqual([
    "claude-sonnet-5-5",
    "claude-opus-5-5",
  ]);
});

test("Anthropic adapter refreshes a rejected session once and retries the request", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("revoked-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  anthropic.reply((call) => {
    if (call.url === tokenUrl) return refreshed();
    if (authorization(call) === "Bearer revoked-access") {
      return Response.json(
        { error: { type: "authentication_error", message: "Invalid token" } },
        { status: 401 },
      );
    }
    return streamReply("OK");
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  expect(saved.claudeAiOauth.accessToken).toBe("new-access");
});

test("Anthropic adapter refreshes a rejected session after joining an expiry refresh that left the token in place", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  const controller = new AbortController();
  const expiryRefreshStarted = Promise.withResolvers<void>();
  const rejectedCallWaits = Promise.withResolvers<void>();
  const others: Promise<unknown>[] = [];
  anthropic.reply(async (call) => {
    if (call.url === tokenUrl) {
      if (JSON.parse(call.body).refresh_token !== "old-refresh") return refreshed();
      expiryRefreshStarted.resolve();
      await rejectedCallWaits.promise;
      await writeSession("old-access", Date.now() + 60 * 60_000, "account-test", "rotated-refresh");
      return refreshed("lost-access", "lost-refresh");
    }
    if (authorization(call) !== "Bearer old-access") return streamReply("OK");
    if (!others.length) {
      await writeSession("old-access", Date.now() + 60_000, "account-test", "old-refresh");
      others.push(adapter.complete(input));
      await expiryRefreshStarted.promise;
      whenAbortListenerAdded(controller.signal, rejectedCallWaits.resolve);
    }
    return Response.json(
      { error: { type: "authentication_error", message: "Invalid token" } },
      { status: 401 },
    );
  });
  const reply = await adapter.complete({ ...input, signal: controller.signal });
  await Promise.allSettled(others);
  expect(reply.text).toBe("OK");
  expect(JSON.parse(await readFile(credentialsPath, "utf8")).claudeAiOauth.accessToken).toBe(
    "new-access",
  );
});

test("Anthropic adapter reports a session still rejected after one refresh", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("revoked-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  let refreshCalls = 0;
  anthropic.reply((call) => {
    if (call.url === tokenUrl) {
      refreshCalls += 1;
      return refreshed(`new-access-${refreshCalls}`);
    }
    return Response.json(
      { error: { type: "authentication_error", message: "Invalid token" } },
      { status: 401 },
    );
  });
  await expect(adapter.complete(input)).rejects.toBeInstanceOf(AskSetupError);
  expect(refreshCalls).toBe(1);
});

test("Anthropic adapter stops waiting for a shared refresh when its call is aborted", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const controller = new AbortController();
  const hanging: Array<(response: Response) => void> = [];
  cleanups.push(async () => {
    hanging.forEach((answer) =>
      answer(
        Response.json(
          { error: "invalid_request", error_description: "test finished" },
          { status: 400 },
        ),
      ),
    );
    await settleClaudeRefreshes();
  });
  anthropic.reply(
    () =>
      new Promise<Response>((resolve) => {
        hanging.push(resolve);
        controller.abort(new Error("caller cancelled"));
      }),
  );
  const pending = adapter.complete({ ...input, signal: controller.signal });
  const startedAt = Date.now();
  await expect(pending).rejects.toThrow(/caller cancelled/);
  expect(Date.now() - startedAt < 1_000).toBe(true);
});

test("Anthropic adapter refreshes a session the profile endpoint rejects", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("revoked-access", Date.now() + 60 * 60_000, null, "old-refresh");
  anthropic.reply((call) => {
    if (call.url === tokenUrl) return refreshed();
    const authorized = authorization(call) === "Bearer new-access";
    if (call.url === profileUrl) {
      return authorized
        ? Response.json({ account: { uuid: "profile-account" } })
        : Response.json(
            { error: { type: "authentication_error", message: "Invalid token" } },
            { status: 401 },
          );
    }
    return streamReply("OK");
  });
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual(["Bearer new-access"]);
});

test("Anthropic adapter keeps using a still valid token when its refresh fails transiently", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("current-access", Date.now() + 60_000, "account-test", "old-refresh");
  anthropic.reply((call) =>
    call.url === tokenUrl
      ? simulateNetworkFailure(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      : streamReply("OK"),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.callsTo(messagesUrl).map(authorization)).toStrictEqual([
    "Bearer current-access",
  ]);
});

test("Anthropic adapter retries a transient refresh failure and reports it as a call failure, not a sign-in problem", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let refreshCalls = 0;
  anthropic.reply((call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    refreshCalls += 1;
    return Response.json({ error: "server_error" }, { status: 503 });
  });
  const error = await rejectionOf(adapter.complete(input));
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(AskSetupError);
  expect(error.message).toMatch(/refresh.*HTTP 503/);
  expect(refreshCalls).toBe(3);
});

test("Anthropic adapter uses a token without a refresh token until it really expires", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("short-lived", Date.now() + 60_000);
  anthropic.reply(() => streamReply("OK"));
  expect((await adapter.complete(input)).text).toBe("OK");
});

test("Anthropic adapter refreshes a session the API reports as revoked", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("revoked-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  anthropic.reply((call) => {
    if (call.url === tokenUrl) return refreshed();
    if (authorization(call) === "Bearer revoked-access") {
      return Response.json(
        {
          error: {
            type: "permission_error",
            message: "OAuth token has been revoked. Please obtain a new token.",
          },
        },
        { status: 403 },
      );
    }
    return streamReply("OK");
  });
  expect((await adapter.complete(input)).text).toBe("OK");
});

test("Anthropic adapter fingerprints the first text block it sends", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => streamReply("OK"));
  await adapter.complete({
    ...input,
    images: [{ mediaType: "image/png", data: "aGVsbG8=", label: "home.png" }],
  });
  const body = sentJson();
  const firstText = "Screenshot: home.png";
  const suffix = createHash("sha256")
    .update(`59cf53e54c78${firstText[4]}${firstText[7]}${firstText[20] ?? "0"}2.1.329`)
    .digest("hex")
    .slice(0, 3);
  expect(body.system[0].text).toBe(
    `x-anthropic-billing-header: cc_version=2.1.329.${suffix}; cc_entrypoint=sdk-cli;`,
  );
});

test("settleClaudeRefreshes waits until an in-flight refresh has saved its tokens", async () => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture();
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let answered = false;
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await sleep(200);
    answered = true;
    return refreshed();
  });
  const pending = adapter.complete(input);
  await sleep(50);
  await settleClaudeRefreshes();
  expect(answered).toBe(true);
  expect(JSON.parse(await readFile(credentialsPath, "utf8")).claudeAiOauth.refreshToken).toBe(
    "new-refresh",
  );
  await pending;
});

test("settleClaudeRefreshes also waits for a refresh that starts while it is waiting", async () => {
  const first = await credentialFixture();
  const second = await credentialFixture();
  await first.writeSession("a-access", Date.now() - 1, "account-test", "a-refresh");
  await second.writeSession("b-access", Date.now() - 1, "account-test", "b-refresh");
  anthropic.reply(async (call) => {
    if (call.url !== tokenUrl) return streamReply("OK");
    await sleep(200);
    const prefix = String(JSON.parse(call.body).refresh_token).slice(0, 1);
    return refreshed(`${prefix}-new-access`, `${prefix}-new-refresh`);
  });
  const calls = [first.adapter.complete(input)];
  await sleep(20);
  const settled = settleClaudeRefreshes();
  setTimeout(() => calls.push(second.adapter.complete(input)), 100);
  await settled;
  expect(
    JSON.parse(await readFile(second.credentialsPath, "utf8")).claudeAiOauth.refreshToken,
  ).toBe("b-new-refresh");
  await Promise.all(calls);
});

test("Anthropic adapter sends ordered base64 image blocks and preserves stop reasons", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.replyOnce(() => streamReply("", "refusal"));
  anthropic.replyOnce(() => streamReply("Partial", "max_tokens"));
  const visualInput = {
    ...input,
    model: "claude-haiku-5-5",
    images: [
      { mediaType: "image/webp", data: "AAAA", label: "page 1, slice 1" },
      { mediaType: "image/jpeg", data: "BBBB", label: "page 1, slice 2" },
      { mediaType: "image/png", data: "CCCC" },
    ] as const,
  };
  const request = { ...visualInput, images: [...visualInput.images] };
  const refusal = await adapter.complete(request);
  expect(refusal.stopReason).toBe("refusal");
  expect(refusal.text).toBe("");
  const truncated = await adapter.complete(request);
  expect(truncated.stopReason).toBe("max_tokens");
  expect(truncated.text).toBe("Partial");
  const params = sentJson();
  expect(params.model).toBe("claude-haiku-5-5");
  expect(params.messages).toStrictEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "Screenshot: page 1, slice 1" },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
        { type: "text", text: "Screenshot: page 1, slice 2" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
        { type: "text", text: input.prompt },
      ],
    },
  ]);
});

test("Anthropic rejects credentials without retrying or dumping the response body", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    Response.json(
      {
        error: { type: "authentication_error", message: "Invalid token test-token" },
      },
      { status: 401 },
    ),
  );
  const completion = adapter.complete(input);
  await expect(completion).rejects.toThrow();
  const error = await rejectionOf(completion);
  expect(error).toBeInstanceOf(AskSetupError);
  expect(error.message).toMatch(/authentication_error: Invalid token \[REDACTED\]/);
  expect(anthropic.calls).toHaveLength(1);
});
