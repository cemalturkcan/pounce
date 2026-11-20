import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const writeSession = (accessToken: string, expiresAt = Date.now() + 60_000) =>
    writeFile(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } }));
  return { adapter: anthropicAskAdapter(dir), writeSession };
}

test("Anthropic adapter forwards the prompt, Haiku model, token limit and abort signal", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, _options: RequestInit) => Response.json({
    content: [{ type: "thinking" }, { type: "text", text: "First " }, { type: "text", text: "second" }],
    usage: { input_tokens: 10, output_tokens: 5, nested: { ignored: 1 } },
    stop_reason: "end_turn",
  }));
  assert.deepEqual(await adapter.complete(input), {
    text: "First second",
    usage: { input_tokens: 10, output_tokens: 5 },
    stopReason: "end_turn",
  });
  await writeSession("new-token");
  await adapter.complete({ ...input, model: "claude-custom" });
  const [first, second] = fetch.mock.calls.map((call) => call.arguments);
  const [url, request] = first ?? [];
  const retryRequest = second?.[1];
  assert.ok(request);
  assert.ok(retryRequest);
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.redirect, "error");
  assert.equal(request.signal, input.signal);
  assert.equal(new Headers(request.headers).get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(String(request.body)), {
    model: "claude-haiku-5-5",
    max_tokens: 123,
    system: input.system,
    messages: [{ role: "user", content: input.prompt }],
  });
  assert.equal(new Headers(retryRequest.headers).get("authorization"), "Bearer new-token");
  assert.equal(JSON.parse(String(retryRequest.body)).model, "claude-custom");
});

test("Anthropic adapter sends ordered base64 image blocks and preserves stop reasons", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const responses = [
    { content: [], stop_reason: "refusal" },
    { content: [{ type: "text", text: "Partial" }], stop_reason: "max_tokens" },
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (_url: string, _request: RequestInit) => Response.json(responses.shift()));
  const visualInput = {
    ...input,
    model: "claude-haiku-5-5",
    images: [
      { mediaType: "image/webp", data: "AAAA", label: "page 1, slice 1" },
      { mediaType: "image/jpeg", data: "BBBB", label: "page 1, slice 2" },
      { mediaType: "image/png", data: "CCCC", label: "page 2, slice 1" },
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
      { type: "text", text: input.prompt },
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
    ],
  }]);
});

test("missing or expired session is reported before sending the prompt", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response());
  await assert.rejects(adapter.complete(input), AskSetupError);
  await writeSession("expired-token", Date.now() - 1);
  await assert.rejects(adapter.complete(input), /local Claude Code session has expired/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Anthropic rejects credentials and rate limits without dumping response bodies", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const responses = [
    new Response("private error detail", { status: 401 }),
    new Response("private error detail", { status: 429, headers: { "retry-after": "15" } }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  await assert.rejects(adapter.complete(input), AskSetupError);
  await assert.rejects(adapter.complete(input), {
    message: "Anthropic Messages returned HTTP 429. Retry after 15 seconds.",
  });
});
