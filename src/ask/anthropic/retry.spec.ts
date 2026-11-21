import { expect, test } from "bun:test";
import { HttpResponse } from "msw";
import {
  eventStream,
  input,
  rejectionOf,
  streamReply,
  textDelta,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import { simulateNetworkFailure } from "../../../tests/unitFetchServer.ts";
import { AskSetupError } from "../errors.ts";
import { inSequence } from "../../shared/async.ts";

const { anthropic, credentialFixture, productRandom } = useAnthropicAdapter();

function throttled() {
  return new Response("private error detail", { status: 429, headers: { "retry-after": "0" } });
}

test("Anthropic retries 429 twice and obeys the abort signal during backoff", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.replyOnce(throttled);
  anthropic.replyOnce(() => new Response(null, { status: 429 }));
  anthropic.replyOnce(() => streamReply("OK"));
  anthropic.reply(throttled);
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.calls).toHaveLength(3);
  expect(
    anthropic.calls.slice(0, 3).map((call) => call.headers.get("x-stainless-retry-count")),
  ).toStrictEqual(["0", "1", "2"]);
  await expect(adapter.complete(input)).rejects.toHaveProperty(
    "message",
    "Anthropic Messages returned HTTP 429.",
  );
  expect(anthropic.calls).toHaveLength(6);

  const controller = new AbortController();
  const abortReason = new Error("canceled during retry");
  anthropic.replyOnce(async () => {
    setImmediate(() => controller.abort(abortReason));
    return new Response(null, { status: 429, headers: { "retry-after": "60" } });
  });
  await expect(adapter.complete({ ...input, signal: controller.signal })).rejects.toBe(abortReason);
  expect(anthropic.calls).toHaveLength(7);
});

test("Anthropic retries HTTP 408, 409, 5xx, network failures and SSE overloads", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  const random = productRandom(0.5);
  const failures = [
    () => new Response(null, { status: 408, headers: { "retry-after-ms": "0" } }),
    () => new Response(null, { status: 409, headers: { "retry-after-ms": "0" } }),
    () =>
      Response.json(
        { error: { type: "overloaded_error", message: "Busy" } },
        { status: 529, headers: { "retry-after-ms": "0" } },
      ),
    () =>
      Response.json(
        { error: { type: "api_error", message: "Unavailable" } },
        { status: 503, headers: { "retry-after": "0" } },
      ),
    () => HttpResponse.error(),
    () => eventStream([{ type: "error", error: { type: "overloaded_error", message: "Busy" } }]),
    () => eventStream([{ type: "error", error: { type: "api_error", message: "Unavailable" } }]),
  ];
  await inSequence(failures, async (fail) => {
    anthropic.forget();
    anthropic.reply(() => streamReply("OK"));
    anthropic.replyOnce(async () => fail());
    expect((await adapter.complete(input)).text).toBe("OK");
    expect(anthropic.calls).toHaveLength(2);
  });
  expect(random.calls()).toBe(failures.length);
});

test("Anthropic honors explicit x-should-retry overrides on HTTP failures", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  productRandom(0);
  anthropic.reply(() => streamReply("OK"));
  anthropic.replyOnce(
    () => new Response(null, { status: 529, headers: { "x-should-retry": "false" } }),
  );
  await expect(adapter.complete(input)).rejects.toThrow(/HTTP 529/);
  expect(anthropic.calls).toHaveLength(1);
  anthropic.replyOnce(
    () =>
      new Response(null, {
        status: 400,
        headers: { "x-should-retry": "true", "retry-after-ms": "0" },
      }),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.calls).toHaveLength(3);
  anthropic.replyOnce(
    () =>
      new Response(null, {
        status: 503,
        headers: { "x-should-retry": "unknown", "retry-after-ms": "0" },
      }),
  );
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.calls).toHaveLength(5);
});

test("Anthropic parses retry delays and rejects server waits above 60 seconds", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  productRandom(0);
  anthropic.reply(() => streamReply("OK"));
  anthropic.replyOnce(
    () => new Response(null, { status: 529, headers: { "retry-after": "0.04" } }),
  );
  const started = performance.now();
  await adapter.complete(input);
  expect(performance.now() - started).toBeGreaterThanOrEqual(30);

  anthropic.replyOnce(
    () =>
      new Response(null, {
        status: 429,
        headers: { "retry-after": "120", "retry-after-ms": "0" },
      }),
  );
  await adapter.complete(input);
  expect(anthropic.calls).toHaveLength(4);
  await inSequence(
    [new Headers({ "retry-after": "3600" }), new Headers({ "retry-after-ms": "3600000" })],
    async (headers) => {
      anthropic.replyOnce(() =>
        Response.json(
          {
            error: { type: "overloaded_error", message: "Try later" },
          },
          { status: 529, headers },
        ),
      );
      await expect(adapter.complete(input)).rejects.toHaveProperty(
        "message",
        "Anthropic Messages returned HTTP 529: overloaded_error: Try later Retry-After (3600 s) exceeds the 60-second wait limit.",
      );
    },
  );
  expect(anthropic.calls).toHaveLength(6);
});

test("Anthropic preserves the login error when an explicitly retryable 401 exceeds the wait limit", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    Response.json(
      {
        error: { type: "authentication_error", message: "Session expired" },
      },
      { status: 401, headers: { "x-should-retry": "true", "retry-after": "61" } },
    ),
  );
  const completion = adapter.complete(input);
  await expect(completion).rejects.toThrow();
  const error = await rejectionOf(completion);
  expect(error).toBeInstanceOf(AskSetupError);
  expect(error.message).toMatch(/authentication_error: Session expired.*60-second wait limit/);
  expect(error).toHaveProperty("hint", expect.stringMatching(/claude auth login/));
  expect(anthropic.calls).toHaveLength(1);
});

function interruptedAfter(outputTokens: number) {
  return eventStream([
    textDelta("   "),
    { type: "message_delta", usage: { output_tokens: outputTokens } },
    { type: "error", error: { type: "overloaded_error", message: "Busy" } },
  ]);
}

test("Anthropic retries a whitespace-only interruption only below the output token limit", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => streamReply("OK"));
  anthropic.replyOnce(() => interruptedAfter(4095));
  expect((await adapter.complete(input)).text).toBe("OK");
  expect(anthropic.calls).toHaveLength(2);
  anthropic.replyOnce(() => interruptedAfter(4096));
  await expect(adapter.complete(input)).rejects.toThrow(
    /overloaded_error: Busy.*Retry skipped after 4096 output tokens/,
  );
  expect(anthropic.calls).toHaveLength(3);
});

test("Anthropic exposes masked network causes for request and stream failures", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  productRandom(0);
  anthropic.reply(() =>
    simulateNetworkFailure(
      new AggregateError([Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })]),
    ),
  );
  await expect(adapter.complete(input)).rejects.toThrow(
    /while sending the Anthropic Messages request: ECONNREFUSED: connect refused/,
  );
  anthropic.reply(
    () =>
      new Response(
        new ReadableStream({
          start(streamController) {
            const cause = Object.assign(new Error("Invalid header test-token"), {
              code: "HPE_INVALID_HEADER_TOKEN",
            });
            streamController.error(new TypeError("terminated", { cause }));
          },
        }),
      ),
  );
  await expect(adapter.complete(input)).rejects.toThrow(
    /while reading the Anthropic Messages stream: HPE_INVALID_HEADER_TOKEN: Invalid header \[REDACTED\]/,
  );
  expect(anthropic.calls).toHaveLength(6);
});
