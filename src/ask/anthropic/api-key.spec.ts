import { expect, test } from "bun:test";
import { useAnthropicServer } from "../../../tests/anthropicServer.ts";
import { input, rejectionOf, streamReply } from "../../../tests/anthropicAdapter.ts";
import { apiKeyAskAdapter } from "./api-key.ts";

const KEY = "sk-ant-test-key-000000000000";

const anthropic = useAnthropicServer();

const adapter = () => apiKeyAskAdapter(KEY);

function sent(call = 0) {
  return anthropic.calls[call];
}

function sentJson(call = 0) {
  return JSON.parse(sent(call)?.body ?? "null");
}

test("the API key adapter answers with the streamed text", async () => {
  anthropic.reply(() => streamReply("Answer"));

  expect((await adapter().complete(input)).text).toBe("Answer");
});

test("the API key adapter sends the key in x-api-key", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sent()?.headers.get("x-api-key")).toBe(KEY);
});

test("the API key adapter sends no bearer token", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sent()?.headers.get("authorization")).toBe(null);
});

test("the API key adapter sends no Claude Code beta flags", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sent()?.headers.get("anthropic-beta")).toBe(null);
});

test("the API key adapter posts to the plain Messages endpoint", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sent()?.url).toBe("https://api.anthropic.com/v1/messages");
});

test("the API key adapter sends only the caller's system prompt", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sentJson().system).toStrictEqual([{ type: "text", text: input.system }]);
});

test("the API key adapter sends no account metadata", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sentJson().metadata).toBe(undefined);
});

test("the API key adapter resolves the model alias", async () => {
  anthropic.reply(() => streamReply("Answer"));
  await adapter().complete(input);

  expect(sentJson().model).toBe("claude-haiku-5-5");
});

test("the API key adapter supports tool use", async () => {
  anthropic.reply(() => streamReply("Done"));
  const reply = await adapter().converse?.({
    system: "Browse.",
    tools: [{ name: "click", description: "Click.", inputSchema: { type: "object" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "Go" }] }],
    model: "haiku",
    maxTokens: 50,
    signal: new AbortController().signal,
    conversationId: "c1",
  });

  expect(
    reply?.content.filter((block) => block.type === "text").map((block) => block.text),
  ).toStrictEqual(["Done"]);
});

test("a rejected API key names pounce install", async () => {
  anthropic.reply(() =>
    Response.json(
      {
        type: "error",
        error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` },
      },
      { status: 401 },
    ),
  );
  const error = await rejectionOf(adapter().complete(input));

  expect(error.message).toContain("pounce install");
});

test("a rejected API key is not repeated in the error", async () => {
  anthropic.reply(() =>
    Response.json(
      {
        type: "error",
        error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` },
      },
      { status: 401 },
    ),
  );
  const error = await rejectionOf(adapter().complete(input));

  expect(error.message).not.toContain(KEY);
});
