import { afterEach, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JsonObject } from "../src/ask/adapter.ts";
import { anthropicAskAdapter, settleClaudeRefreshes } from "../src/ask/anthropic/adapter.ts";
import { useAnthropicServer } from "./anthropicServer.ts";

export const input = {
  system: "Answer from the page.",
  prompt: "Example page",
  model: "haiku",
  maxTokens: 123,
  signal: new AbortController().signal,
};

export function useAnthropicAdapter() {
  const anthropic = useAnthropicServer();
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    await settleClaudeRefreshes();
  });

  async function credentialFixture() {
    const dir = await mkdtemp(path.join(tmpdir(), "web-agent-ask-test-"));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
      await rm(`${dir}.lock`, { recursive: true, force: true });
    });
    const credentialsPath = path.join(dir, ".credentials.json");
    const writeSession = (
      accessToken: string,
      expiresAt = Date.now() + 10 * 60_000,
      accountUuid: string | null = "account-test",
      refreshToken?: string,
    ) => {
      const tokens = { accessToken, expiresAt };
      const claudeAiOauth = refreshToken ? { ...tokens, refreshToken } : tokens;
      return writeFile(
        credentialsPath,
        JSON.stringify(accountUuid ? { claudeAiOauth, accountUuid } : { claudeAiOauth }),
      );
    };
    return { adapter: anthropicAskAdapter(dir), credentialsPath, writeSession };
  }

  function sentJson(call = 0) {
    return JSON.parse(anthropic.calls[call]?.body ?? "null");
  }

  function productRandom(value: number) {
    const realRandom = Math.random;
    let productCalls = 0;
    const random = spyOn(Math, "random").mockImplementation(() => {
      const stack = new Error().stack ?? "";
      if (stack.includes("/node_modules/") || !stack.includes("/src/ask/anthropic/"))
        return realRandom();
      productCalls += 1;
      return value;
    });
    cleanups.push(async () => {
      random.mockRestore();
    });
    return { calls: () => productCalls };
  }

  return { anthropic, cleanups, credentialFixture, sentJson, productRandom };
}

export async function rejectionOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected the call to reject with an Error");
}

export function authorization(call: { headers: Headers } | undefined) {
  return call?.headers.get("authorization");
}

export function encodeEvents(events: JsonObject[]) {
  const frames = events
    .map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`)
    .join("");
  return new TextEncoder().encode(frames);
}

export function eventStream(events: JsonObject[]) {
  const bytes = encodeEvents(events);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 7));
        offset += 7;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export function textDelta(text: string, index = 0) {
  return { type: "content_block_delta", index, delta: { type: "text_delta", text } };
}

export function streamReply(text: string, stopReason = "end_turn") {
  return eventStream([
    {
      type: "message_start",
      message: {
        content: [],
        usage: { input_tokens: 10, output_tokens: 1, nested: { ignored: 1 } },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "ping" },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "ignored" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "test-signature" },
    },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    textDelta(text, 1),
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", usage: { output_tokens: 3 } },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

export function whenAbortListenerAdded(signal: AbortSignal, then: () => void) {
  const add = signal.addEventListener.bind(signal);
  spyOn(signal, "addEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      add(type, listener, options);
      if (type === "abort") then();
    },
  );
}

export function refreshed(accessToken = "new-access", refreshToken = "new-refresh") {
  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
  });
}
