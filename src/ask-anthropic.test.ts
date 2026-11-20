import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { anthropicAskAdapter } from "./ask-anthropic.ts";
import { AskSetupError } from "./ask.ts";

const input = {
  system: "Answer from the page.",
  prompt: "Example page",
  model: "haiku",
  maxTokens: 123,
  signal: new AbortController().signal,
};

async function credentialFixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "web-agent-ask-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, ".credentials.json");
  const writeSession = (
    accessToken: string,
    expiresAt = Date.now() + 10 * 60_000,
    accountUuid: string | null = "account-test",
    refreshToken?: string,
  ) => writeFile(credentialsPath, JSON.stringify({
    claudeAiOauth: { accessToken, expiresAt, ...(refreshToken ? { refreshToken } : {}) },
    ...(accountUuid ? { accountUuid } : {}),
  }));
  return { adapter: anthropicAskAdapter(dir), credentialsPath, writeSession };
}

function encodeEvents(events: Array<Record<string, unknown>>) {
  const frames = events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  return new TextEncoder().encode(frames);
}

function eventStream(events: Array<Record<string, unknown>>) {
  const bytes = encodeEvents(events);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 7));
      offset += 7;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function textDelta(text: string, index = 0) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

function streamReply(text: string, stopReason = "end_turn") {
  return eventStream([
    { type: "message_start", message: { content: [], usage: { input_tokens: 10, output_tokens: 1, nested: { ignored: 1 } } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "ping" },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ignored" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "test-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    textDelta(text, 1),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

test("Anthropic adapter forwards the prompt, Haiku model, token limit and abort signal", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, _options: RequestInit) => streamReply("First second"));
  assert.deepEqual(await adapter.complete(input), {
    text: "First second",
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "end_turn",
  });
  await writeSession("new-token");
  for (const model of ["claude-custom", "sonnet", "opus"]) await adapter.complete({ ...input, model });
  const [first, second, ...aliases] = fetch.mock.calls.map((call) => call.arguments);
  const [url, request] = first ?? [];
  const retryRequest = second?.[1];
  assert.ok(request);
  assert.ok(retryRequest);
  assert.equal(url, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(request.redirect, "error");
  assert.equal(request.signal, input.signal);
  assert.equal(new Headers(request.headers).get("authorization"), "Bearer test-token");
  const body = JSON.parse(String(request.body));
  assert.equal(body.model, "claude-haiku-5-5");
  assert.equal(body.max_tokens, 123);
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: input.prompt }]);
  assert.match(body.system[0].text, /^x-anthropic-billing-header: cc_version=2\.1\.296\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;$/);
  assert.equal(body.system[1].text, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.equal(body.system[2].text, input.system);
  assert.deepEqual(JSON.parse(body.metadata.user_id), {
    device_id: JSON.parse(body.metadata.user_id).device_id,
    account_uuid: "account-test",
    session_id: JSON.parse(body.metadata.user_id).session_id,
  });
  assert.match(JSON.parse(body.metadata.user_id).device_id, /^[0-9a-f]{64}$/);
  assert.match(JSON.parse(body.metadata.user_id).session_id, /^[0-9a-f-]{36}$/);
  const headers = new Headers(request.headers);
  assert.match(headers.get("anthropic-beta") ?? "", /claude-code-20250219/);
  assert.match(headers.get("anthropic-beta") ?? "", /oauth-2025-04-20/);
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(headers.get("user-agent"), "claude-cli/2.1.296 (external, sdk-cli)");
  assert.equal(headers.get("x-app"), "cli");
  assert.equal(headers.get("x-claude-code-session-id"), JSON.parse(body.metadata.user_id).session_id);
  assert.equal(new Headers(retryRequest.headers).get("authorization"), "Bearer new-token");
  assert.equal(JSON.parse(String(retryRequest.body)).model, "claude-custom");
  assert.deepEqual(aliases.map((args) => JSON.parse(String(args[1]?.body)).model), ["claude-sonnet-5-5", "claude-opus-5-5"]);
});

test("Anthropic adapter resolves and caches the account UUID from the Claude profile", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token", Date.now() + 10 * 60_000, null);
  const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/oauth/profile")) return Response.json({ account: { uuid: "profile-account" } });
    return streamReply("OK");
  });
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(fetch.mock.calls.filter((call) => String(call.arguments[0]).endsWith("/api/oauth/profile")).length, 1);
  const messageCall = fetch.mock.calls.find((call) => String(call.arguments[0]).includes("/v1/messages"));
  const body = JSON.parse(String(messageCall?.arguments[1]?.body));
  assert.equal(JSON.parse(body.metadata.user_id).account_uuid, "profile-account");
});

test("Anthropic adapter refreshes an expiring session once and atomically saves the rotated tokens", async (t) => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture(t);
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  const fetch = t.mock.method(globalThis, "fetch", async (url: string, request?: RequestInit) => {
    if (url.includes("/v1/oauth/token")) {
      const body = JSON.parse(String(request?.body));
      assert.equal(body.refresh_token, "old-refresh");
      assert.equal(body.client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      assert.match(body.scope, /user:inference/);
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 7200 });
    }
    assert.equal(new Headers(request?.headers).get("authorization"), "Bearer new-access");
    return streamReply("OK");
  });
  const [first, second] = await Promise.all([adapter.complete(input), adapter.complete(input)]);
  assert.equal(first.text, "OK");
  assert.equal(second.text, "OK");
  assert.equal(fetch.mock.calls.filter((call) => String(call.arguments[0]).includes("/v1/oauth/token")).length, 1);
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(saved.claudeAiOauth.accessToken, "new-access");
  assert.equal(saved.claudeAiOauth.refreshToken, "new-refresh");
  assert.ok(saved.claudeAiOauth.expiresAt > Date.now() + 60 * 60_000);
});

test("Anthropic adapter retries token refresh without scopes when the endpoint rejects the scope", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  let refreshCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, request?: RequestInit) => {
    if (url.includes("/v1/oauth/token")) {
      refreshCalls += 1;
      const body = JSON.parse(String(request?.body));
      if (refreshCalls === 1) return Response.json({ error: "invalid_scope" }, { status: 400 });
      assert.equal(body.scope, undefined);
      return Response.json({ access_token: "new-access", expires_in: 3600 });
    }
    return streamReply("OK");
  });
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(refreshCalls, 2);
});

test("Anthropic adapter does not overwrite credentials refreshed concurrently by Claude Code", async (t) => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture(t);
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  t.mock.method(globalThis, "fetch", async (url: string, request?: RequestInit) => {
    if (url.includes("/v1/oauth/token")) {
      await writeSession("external-access", Date.now() + 60 * 60_000, "account-test", "external-refresh");
      return Response.json({ access_token: "mcp-access", refresh_token: "mcp-refresh", expires_in: 3600 });
    }
    assert.equal(new Headers(request?.headers).get("authorization"), "Bearer external-access");
    return streamReply("OK");
  });
  assert.equal((await adapter.complete(input)).text, "OK");
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(saved.claudeAiOauth.accessToken, "external-access");
  assert.equal(saved.claudeAiOauth.refreshToken, "external-refresh");
});

test("Anthropic adapter uses credentials Claude Code refreshed while its own refresh was rejected", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  t.mock.method(globalThis, "fetch", async (url: string, request?: RequestInit) => {
    if (url.includes("/v1/oauth/token")) {
      await writeSession("external-access", Date.now() + 60 * 60_000, "account-test", "external-refresh");
      return Response.json({ error: "invalid_grant", error_description: "Refresh token already used" }, { status: 400 });
    }
    assert.equal(new Headers(request?.headers).get("authorization"), "Bearer external-access");
    return streamReply("OK");
  });
  assert.equal((await adapter.complete(input)).text, "OK");
});

test("Anthropic adapter refreshes a rejected session once and retries the request", async (t) => {
  const { adapter, credentialsPath, writeSession } = await credentialFixture(t);
  await writeSession("revoked-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  t.mock.method(globalThis, "fetch", async (url: string, request?: RequestInit) => {
    if (url.includes("/v1/oauth/token")) return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    if (new Headers(request?.headers).get("authorization") === "Bearer revoked-access") {
      return Response.json({ error: { type: "authentication_error", message: "Invalid token" } }, { status: 401 });
    }
    return streamReply("OK");
  });
  assert.equal((await adapter.complete(input)).text, "OK");
  const saved = JSON.parse(await readFile(credentialsPath, "utf8"));
  assert.equal(saved.claudeAiOauth.accessToken, "new-access");
});

test("Anthropic adapter reports a session still rejected after one refresh", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("revoked-access", Date.now() + 60 * 60_000, "account-test", "old-refresh");
  let refreshCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (url.includes("/v1/oauth/token")) {
      refreshCalls += 1;
      return Response.json({ access_token: `new-access-${refreshCalls}`, refresh_token: "new-refresh", expires_in: 3600 });
    }
    return Response.json({ error: { type: "authentication_error", message: "Invalid token" } }, { status: 401 });
  });
  await assert.rejects(adapter.complete(input), AskSetupError);
  assert.equal(refreshCalls, 1);
});

test("Anthropic adapter stops waiting for a shared refresh when its call is aborted", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("old-access", Date.now() - 1, "account-test", "old-refresh");
  t.mock.method(globalThis, "fetch", (url: string, request?: RequestInit) => new Promise((_, reject) => {
    request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
  }));
  const controller = new AbortController();
  const pending = adapter.complete({ ...input, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("caller cancelled")), 20);
  const startedAt = Date.now();
  await assert.rejects(pending, /caller cancelled/);
  assert.ok(Date.now() - startedAt < 1_000);
});

test("Anthropic adapter sends ordered base64 image blocks and preserves stop reasons", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const responses = [
    streamReply("", "refusal"),
    streamReply("Partial", "max_tokens"),
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, _request: RequestInit) => responses.shift());
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
  assert.equal(refusal.stopReason, "refusal");
  assert.equal(refusal.text, "");
  const truncated = await adapter.complete(request);
  assert.equal(truncated.stopReason, "max_tokens");
  assert.equal(truncated.text, "Partial");
  const params = JSON.parse(String(fetch.mock.calls[0]?.arguments[1]?.body));
  assert.equal(params.model, "claude-haiku-5-5");
  assert.deepEqual(params.messages, [{
    role: "user",
    content: [
      { type: "text", text: "Screenshot: page 1, slice 1" },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
      { type: "text", text: "Screenshot: page 1, slice 2" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
      { type: "text", text: input.prompt },
    ],
  }]);
});

test("Anthropic adapter rejects an output limit reached before any text", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  t.mock.method(globalThis, "fetch", async () => streamReply("", "max_tokens"));
  await assert.rejects(adapter.complete(input), /reached max_tokens before producing text/);
});

test("missing or expired session is reported before sending the prompt", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response());
  await assert.rejects(adapter.complete(input), AskSetupError);
  await writeSession("expired-token", Date.now() - 1);
  await assert.rejects(adapter.complete(input), /expired without a refresh token/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Anthropic joins fragmented UTF-8 text deltas and detects interrupted streams", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const responses = [
    eventStream([
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      textDelta("Mavi "), textDelta("çizgili 📘"), { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" },
    ]),
    eventStream([
      textDelta("Partial"), { type: "error", error: { type: "invalid_request_error", message: "invalid media" } },
    ]),
  ];
  const fetch = t.mock.method(globalThis, "fetch", async () => responses.shift() ?? eventStream([{ type: "ping" }]));
  assert.equal((await adapter.complete(input)).text, "Mavi çizgili 📘");
  await assert.rejects(adapter.complete(input), { message: "Anthropic Messages stream error: invalid_request_error: invalid media" });
  assert.equal(fetch.mock.callCount(), 2);
  await assert.rejects(adapter.complete(input), /stream ended before message_stop/);
  assert.equal(fetch.mock.callCount(), 5);
});

test("Anthropic rejects credentials without retrying or dumping the response body", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { type: "authentication_error", message: "Invalid token test-token" },
  }, { status: 401 }));
  await assert.rejects(adapter.complete(input), (error: unknown) => {
    assert.ok(error instanceof AskSetupError);
    assert.match(error.message, /authentication_error: Invalid token \[REDACTED\]/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("Anthropic retries 429 twice and obeys the abort signal during backoff", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const throttled = () => new Response("private error detail", { status: 429, headers: { "retry-after": "0" } });
  const responses = [throttled(), new Response(null, { status: 429 }), streamReply("OK")];
  const fetch = t.mock.method(globalThis, "fetch", async () => responses.shift() ?? throttled());
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(fetch.mock.callCount(), 3);
  assert.deepEqual(fetch.mock.calls.slice(0, 3).map((call) => new Headers(call.arguments[1]?.headers).get("x-stainless-retry-count")), ["0", "1", "2"]);
  await assert.rejects(adapter.complete(input), {
    message: "Anthropic Messages returned HTTP 429.",
  });
  assert.equal(fetch.mock.callCount(), 6);

  const controller = new AbortController();
  const abortReason = new Error("canceled during retry");
  fetch.mock.mockImplementationOnce(async () => {
    setImmediate(() => controller.abort(abortReason));
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  });
  await assert.rejects(adapter.complete({ ...input, signal: controller.signal }), abortReason);
  assert.equal(fetch.mock.callCount(), 7);
});

test("Anthropic retries HTTP 408, 409, 5xx, network failures and SSE overloads", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const random = t.mock.method(Math, "random", () => 0.5);
  const failures = [
    () => new Response(null, { status: 408, headers: { "retry-after-ms": "0" } }),
    () => new Response(null, { status: 409, headers: { "retry-after-ms": "0" } }),
    () => Response.json({ error: { type: "overloaded_error", message: "Busy" } }, { status: 529, headers: { "retry-after-ms": "0" } }),
    () => Response.json({ error: { type: "api_error", message: "Unavailable" } }, { status: 503, headers: { "retry-after": "0" } }),
    () => { throw new TypeError("fetch failed"); },
    () => eventStream([{ type: "error", error: { type: "overloaded_error", message: "Busy" } }]),
    () => eventStream([{ type: "error", error: { type: "api_error", message: "Unavailable" } }]),
  ];
  for (const fail of failures) {
    const fetch = t.mock.method(globalThis, "fetch", async () => streamReply("OK"));
    fetch.mock.mockImplementationOnce(async () => fail());
    assert.equal((await adapter.complete(input)).text, "OK");
    assert.equal(fetch.mock.callCount(), 2);
    fetch.mock.restore();
  }
  assert.equal(random.mock.callCount(), failures.length);
});

test("Anthropic preserves partial text and usage after an interrupted stream without retrying", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const partial = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    textDelta("Partial answer"),
  ];
  let sent = false;
  const disconnected = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encodeEvents(partial));
        return;
      }
      return new Promise<void>((resolve) => setImmediate(() => {
        controller.error(new TypeError("connection terminated"));
        resolve();
      }));
    },
  });
  const responses = [
    eventStream(partial),
    eventStream([...partial, { type: "error", error: { type: "overloaded_error", message: "Busy" } }]),
    eventStream([...partial, { type: "error", error: { type: "api_error", message: "Unavailable" } }]),
    new Response(disconnected),
  ];
  const fetch = t.mock.method(globalThis, "fetch", async () => responses.shift());
  for (const calls of [1, 2, 3, 4]) {
    assert.deepEqual(await adapter.complete(input), {
      text: "Partial answer",
      usage: { input_tokens: 10 },
      stopReason: "interrupted",
    });
    assert.equal(fetch.mock.callCount(), calls);
  }
});

test("Anthropic honors explicit x-should-retry overrides on HTTP failures", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  t.mock.method(Math, "random", () => 0);
  const fetch = t.mock.method(globalThis, "fetch", async () => streamReply("OK"));
  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 529, headers: { "x-should-retry": "false" } }));
  await assert.rejects(adapter.complete(input), /HTTP 529/);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 400, headers: { "x-should-retry": "true", "retry-after-ms": "0" } }));
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(fetch.mock.callCount(), 3);
  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 503, headers: { "x-should-retry": "unknown", "retry-after-ms": "0" } }));
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(fetch.mock.callCount(), 5);
});

test("Anthropic parses retry delays and rejects server waits above 60 seconds", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  t.mock.method(Math, "random", () => 0);
  const fetch = t.mock.method(globalThis, "fetch", async () => streamReply("OK"));
  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 529, headers: { "retry-after": "0.04" } }));
  const started = performance.now();
  await adapter.complete(input);
  assert.ok(performance.now() - started >= 30);

  fetch.mock.mockImplementationOnce(async () => new Response(null, { status: 429, headers: { "retry-after": "120", "retry-after-ms": "0" } }));
  await adapter.complete(input);
  assert.equal(fetch.mock.callCount(), 4);
  for (const headers of [new Headers({ "retry-after": "3600" }), new Headers({ "retry-after-ms": "3600000" })]) {
    fetch.mock.mockImplementationOnce(async () => Response.json({
      error: { type: "overloaded_error", message: "Try later" },
    }, { status: 529, headers }));
    await assert.rejects(adapter.complete(input), {
      message: "Anthropic Messages returned HTTP 529: overloaded_error: Try later Retry-After (3600 s) exceeds the 60-second wait limit.",
    });
  }
  assert.equal(fetch.mock.callCount(), 6);
});

test("Anthropic preserves the login error when an explicitly retryable 401 exceeds the wait limit", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { type: "authentication_error", message: "Session expired" },
  }, { status: 401, headers: { "x-should-retry": "true", "retry-after": "61" } }));
  await assert.rejects(adapter.complete(input), (error: unknown) => {
    assert.ok(error instanceof AskSetupError);
    assert.match(error.message, /authentication_error: Session expired.*60-second wait limit/);
    assert.match(error.hint ?? "", /claude auth login/);
    return true;
  });
  assert.equal(fetch.mock.callCount(), 1);
});

test("Anthropic cancels a stalled stream on abort without retrying", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const controller = new AbortController();
  const abortReason = new Error("canceled mid-stream");
  let canceled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (++pulls === 1) streamController.enqueue(encodeEvents([textDelta("Partial")]));
      else setImmediate(() => controller.abort(abortReason));
    },
    cancel() { canceled = true; },
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(stream));
  await assert.rejects(adapter.complete({ ...input, signal: controller.signal }), abortReason);
  assert.equal(canceled, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test("Anthropic preserves meaningful partial text on timeout and reports a timeout without text", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  for (const text of ["Partial", "   "]) {
    const controller = new AbortController();
    const reason = new DOMException("deadline reached", "TimeoutError");
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(encodeEvents([textDelta(text)]));
        setImmediate(() => controller.abort(reason));
      },
    })));
    const completion = adapter.complete({ ...input, signal: controller.signal });
    if (text.trim()) {
      assert.deepEqual(await completion, { text, usage: {}, stopReason: "interrupted" });
    } else {
      await assert.rejects(completion, reason);
    }
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("Anthropic retries a whitespace-only interruption only below the output token limit", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const interrupted = (outputTokens: number) => eventStream([
    textDelta("   "),
    { type: "message_delta", usage: { output_tokens: outputTokens } },
    { type: "error", error: { type: "overloaded_error", message: "Busy" } },
  ]);
  const fetch = t.mock.method(globalThis, "fetch", async () => streamReply("OK"));
  fetch.mock.mockImplementationOnce(async () => interrupted(4095));
  assert.equal((await adapter.complete(input)).text, "OK");
  assert.equal(fetch.mock.callCount(), 2);
  fetch.mock.mockImplementationOnce(async () => interrupted(4096));
  await assert.rejects(adapter.complete(input), /overloaded_error: Busy.*Retry skipped after 4096 output tokens/);
  assert.equal(fetch.mock.callCount(), 3);
});

test("Anthropic exposes masked network causes for request and stream failures", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  t.mock.method(Math, "random", () => 0);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    const cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    throw new TypeError("fetch failed", { cause: new AggregateError([cause]) });
  });
  await assert.rejects(adapter.complete(input), /while sending the Anthropic Messages request: ECONNREFUSED: connect refused/);
  fetch.mock.mockImplementation(async () => new Response(new ReadableStream({
    start(streamController) {
      const cause = Object.assign(new Error("Invalid header test-token"), { code: "HPE_INVALID_HEADER_TOKEN" });
      streamController.error(new TypeError("terminated", { cause }));
    },
  })));
  await assert.rejects(adapter.complete(input), /while reading the Anthropic Messages stream: HPE_INVALID_HEADER_TOKEN: Invalid header \[REDACTED\]/);
  assert.equal(fetch.mock.callCount(), 6);
});

test("Anthropic wraps profile network failures with their cause and masks the token", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token", Date.now() + 10 * 60_000, null);
  t.mock.method(globalThis, "fetch", async () => {
    const cause = Object.assign(new Error("DNS failed for test-token"), { code: "ENOTFOUND" });
    throw new TypeError("fetch failed", { cause });
  });
  await assert.rejects(adapter.complete(input), (error: unknown) => {
    assert.ok(error instanceof AskSetupError);
    assert.match(error.message, /profile: ENOTFOUND: DNS failed for \[REDACTED\]/);
    return true;
  });
});
