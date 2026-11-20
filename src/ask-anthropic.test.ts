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

function eventStream(events: Array<Record<string, unknown>>) {
  const frames = events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(frames);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + 7));
      offset += 7;
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function textDelta(text: string) {
  return { type: "content_block_delta", delta: { type: "text_delta", text } };
}

function streamReply(text: string, stopReason = "end_turn") {
  return eventStream([
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1, nested: { ignored: 1 } } } },
    { type: "ping" },
    { type: "content_block_delta", delta: { type: "thinking_delta", text: "ignored" } },
    textDelta(text),
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
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.redirect, "error");
  assert.equal(request.signal, input.signal);
  assert.equal(new Headers(request.headers).get("authorization"), "Bearer test-token");
  assert.deepEqual(JSON.parse(String(request.body)), {
    model: "claude-haiku-5-5",
    max_tokens: 123,
    stream: true,
    system: input.system,
    messages: [{ role: "user", content: input.prompt }],
  });
  assert.equal(new Headers(retryRequest.headers).get("authorization"), "Bearer new-token");
  assert.equal(JSON.parse(String(retryRequest.body)).model, "claude-custom");
  assert.deepEqual(aliases.map((args) => JSON.parse(String(args[1]?.body)).model), ["claude-sonnet-5-5", "claude-opus-5-5"]);
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

test("missing or expired session is reported before sending the prompt", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response());
  await assert.rejects(adapter.complete(input), AskSetupError);
  await writeSession("expired-token", Date.now() - 1);
  await assert.rejects(adapter.complete(input), /local Claude Code session has expired/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("Anthropic joins fragmented UTF-8 text deltas and detects interrupted streams", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const responses = [
    eventStream([textDelta("Mavi "), textDelta("çizgili 📘"), { type: "message_stop" }]),
    eventStream([textDelta("Partial")]),
    eventStream([textDelta("Partial"), { type: "error", error: { message: "private detail" } }]),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  assert.equal((await adapter.complete(input)).text, "Mavi çizgili 📘");
  await assert.rejects(adapter.complete(input), /stream ended before message_stop/);
  await assert.rejects(adapter.complete(input), { message: "Anthropic Messages reported an error in the stream." });
});

test("Anthropic rejects credentials without retrying or dumping the response body", async (t) => {
  const { adapter, writeSession } = await credentialFixture(t);
  await writeSession("test-token");
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response("private error detail", { status: 401 }));
  await assert.rejects(adapter.complete(input), AskSetupError);
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
  await assert.rejects(adapter.complete(input), {
    message: "Anthropic Messages returned HTTP 429. Retry after 0 seconds.",
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
