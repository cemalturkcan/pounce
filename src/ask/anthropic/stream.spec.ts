import { expect, test } from "bun:test";
import {
  encodeEvents,
  eventStream,
  input,
  rejectionOf,
  streamReply,
  textDelta,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import { exceedsContextWindow } from "../run.ts";
import { inSequence } from "../../shared/async.ts";

const { anthropic, credentialFixture } = useAnthropicAdapter();

test("Anthropic treats a stream that drops after its stop reason as complete", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    eventStream([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      textDelta("Complete answer"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ]),
  );
  const reply = await adapter.complete(input);
  expect(reply.text).toBe("Complete answer");
  expect(reply.stopReason).toBe("end_turn");
  expect(anthropic.calls).toHaveLength(1);
});

test("Anthropic parses LF-framed streams", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  const frames = [
    { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    textDelta("Hello"),
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  anthropic.reply(() => new Response(frames, { headers: { "content-type": "text/event-stream" } }));
  expect((await adapter.complete(input)).text).toBe("Hello");
});

test("Anthropic treats a read error after the stop reason as a complete answer", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent)
        return new Promise<void>((resolve) =>
          setImmediate(() => {
            controller.error(new Error("socket reset"));
            resolve();
          }),
        );
      sent = true;
      controller.enqueue(
        encodeEvents([
          { type: "message_start", message: { usage: { input_tokens: 10 } } },
          textDelta("Complete answer"),
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 5 },
          },
        ]),
      );
    },
  });
  anthropic.reply(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const reply = await adapter.complete(input);
  expect(reply.text).toBe("Complete answer");
  expect(reply.stopReason).toBe("end_turn");
  expect(anthropic.calls).toHaveLength(1);
});

test("Anthropic reports an empty reply stopped at the context window as a context overflow", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    eventStream([
      { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
      {
        type: "message_delta",
        delta: { stop_reason: "model_context_window_exceeded" },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]),
  );
  const error = await rejectionOf(adapter.complete(input));
  expect(error).toBeDefined();
  expect(exceedsContextWindow(error)).toBe(true);
});

test("Anthropic adapter rejects an output limit reached before any text", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => streamReply("", "max_tokens"));
  await expect(adapter.complete(input)).rejects.toThrow(/reached max_tokens before producing text/);
});

test("Anthropic joins fragmented UTF-8 text deltas and detects interrupted streams", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.replyOnce(() =>
    eventStream([
      { type: "message_start", message: { content: [] } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      textDelta("Mavi "),
      textDelta("çizgili 📘"),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]),
  );
  anthropic.replyOnce(() =>
    eventStream([
      textDelta("Partial"),
      { type: "error", error: { type: "invalid_request_error", message: "invalid media" } },
    ]),
  );
  anthropic.reply(() => eventStream([{ type: "ping" }]));
  expect((await adapter.complete(input)).text).toBe("Mavi çizgili 📘");
  await expect(adapter.complete(input)).rejects.toHaveProperty(
    "message",
    "Anthropic Messages stream error: invalid_request_error: invalid media",
  );
  expect(anthropic.calls).toHaveLength(2);
  await expect(adapter.complete(input)).rejects.toThrow(/stream ended before message_stop/);
  expect(anthropic.calls).toHaveLength(5);
});

test("Anthropic preserves partial text and usage after an interrupted stream without retrying", async () => {
  const { adapter, writeSession } = await credentialFixture();
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
      return new Promise<void>((resolve) =>
        setImmediate(() => {
          controller.error(new TypeError("connection terminated"));
          resolve();
        }),
      );
    },
  });
  anthropic.replyOnce(() => eventStream(partial));
  anthropic.replyOnce(() =>
    eventStream([
      ...partial,
      { type: "error", error: { type: "overloaded_error", message: "Busy" } },
    ]),
  );
  anthropic.replyOnce(() =>
    eventStream([
      ...partial,
      { type: "error", error: { type: "api_error", message: "Unavailable" } },
    ]),
  );
  anthropic.replyOnce(() => new Response(disconnected));
  await inSequence([1, 2, 3, 4], async (calls) => {
    expect(await adapter.complete(input)).toStrictEqual({
      text: "Partial answer",
      usage: { input_tokens: 10 },
      stopReason: "interrupted",
    });
    expect(anthropic.calls).toHaveLength(calls);
  });
});

test("Anthropic cancels a stalled stream on abort without retrying", async () => {
  const { adapter, writeSession } = await credentialFixture();
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
    cancel() {
      canceled = true;
    },
  });
  anthropic.reply(() => new Response(stream));
  await expect(adapter.complete({ ...input, signal: controller.signal })).rejects.toBe(abortReason);
  expect(canceled).toBe(true);
  expect(anthropic.calls).toHaveLength(1);
});

test("Anthropic preserves meaningful partial text on timeout and reports a timeout without text", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  await inSequence(["Partial", "   "], async (text) => {
    anthropic.forget();
    const controller = new AbortController();
    const reason = new DOMException("deadline reached", "TimeoutError");
    anthropic.reply(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(encodeEvents([textDelta(text)]));
              setImmediate(() => controller.abort(reason));
            },
          }),
        ),
    );
    const completion = adapter.complete({ ...input, signal: controller.signal });
    if (text.trim()) {
      expect(await completion).toStrictEqual({ text, usage: {}, stopReason: "interrupted" });
    } else {
      await expect(completion).rejects.toBe(reason);
    }
    expect(anthropic.calls).toHaveLength(1);
  });
});

test("Anthropic joins text blocks whose events carry no index", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    eventStream([
      { type: "content_block_start", content_block: { type: "text", text: "A" } },
      { type: "content_block_start", content_block: { type: "text", text: "B" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      { type: "message_stop" },
    ]),
  );
  expect((await adapter.complete(input)).text).toBe("AB");
});
