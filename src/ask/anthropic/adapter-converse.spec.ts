import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { messagesUrl, tokenUrl } from "../../../tests/anthropicServer.ts";
import {
  authorization,
  encodeEvents,
  eventStream,
  refreshed,
  rejectionOf,
  textDelta,
  useAnthropicAdapter,
} from "../../../tests/anthropicAdapter.ts";
import type { AskToolDefinition, JsonObject } from "../adapter.ts";
import { AskSetupError } from "../errors.ts";

const { anthropic, credentialFixture, sentJson } = useAnthropicAdapter();

const converseInput = {
  system: "Browse the page.",
  tools: [
    {
      name: "click",
      description: "Click an element.",
      inputSchema: { type: "object", properties: { ref: { type: "string" } } },
    },
  ] satisfies AskToolDefinition[],
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Question about https://example.test/pricing" }],
    },
  ],
  model: "haiku",
  maxTokens: 4000,
  signal: new AbortController().signal,
  conversationId: "conversation-test",
};

function toolTurn(events: JsonObject[] = [], stopReason = "tool_use") {
  return eventStream([
    {
      type: "message_start",
      message: { content: [], usage: { input_tokens: 20, output_tokens: 1 } },
    },
    ...events,
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]);
}

function toolUseEvents(index: number, id: string, json: string[]): JsonObject[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name: "click", input: {} },
    },
    ...json.map((partial_json) => ({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index },
  ];
}

const thinkingThenToolEvents: JsonObject[] = [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig-abc" },
  },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  textDelta("Opening the toggle.", 1),
  { type: "content_block_stop", index: 1 },
  ...toolUseEvents(2, "toolu_1", ['{"re', 'f": "e1', '2"}']),
];

test("Anthropic converse returns an empty thinking block, text and a tool call with split JSON in order", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(thinkingThenToolEvents));
  const reply = await adapter.converse!(converseInput);
  expect(reply).toStrictEqual({
    content: [
      { type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig-abc" } },
      {
        type: "text",
        text: "Opening the toggle.",
        raw: { type: "text", text: "Opening the toggle." },
      },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "click",
        input: { ref: "e12" },
        raw: { type: "tool_use", id: "toolu_1", name: "click", input: { ref: "e12" } },
      },
    ],
    usage: { input_tokens: 20, output_tokens: 9 },
    stopReason: "tool_use",
  });
});

test("Anthropic converse sends the tools and no tool choice, thinking or eager streaming", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_1", ["{}"])));
  await adapter.converse!(converseInput);
  const body = sentJson();
  expect(body.tools).toStrictEqual([
    {
      name: "click",
      description: "Click an element.",
      input_schema: converseInput.tools[0]?.inputSchema,
    },
  ]);
  expect(Object.keys(body).toSorted()).toStrictEqual([
    "max_tokens",
    "messages",
    "metadata",
    "model",
    "stream",
    "system",
    "tools",
  ]);
  expect(body.model).toBe("claude-haiku-5-5");
  expect(body.stream).toBe(true);
});

test("Anthropic converse sends an earlier opaque block back byte for byte", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  const firstTurn = thinkingThenToolEvents.with(
    thinkingThenToolEvents.findIndex(
      (event) => event.type === "content_block_start" && event.index === 1,
    ),
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "", citations: null },
    },
  );
  anthropic.reply(() =>
    toolTurn(anthropic.calls.length === 1 ? firstTurn : toolUseEvents(0, "toolu_2", ["{}"])),
  );
  const first = await adapter.converse!(converseInput);
  const toolResult = {
    type: "tool_result" as const,
    toolUseId: "toolu_1",
    content: [{ type: "text" as const, text: "clicked" }],
  };
  await adapter.converse!({
    ...converseInput,
    messages: [
      ...converseInput.messages,
      { role: "assistant", content: first.content },
      { role: "user", content: [toolResult] },
    ],
  });
  const raw = anthropic.calls[1]?.body ?? "";
  const opaque = first.content[0];
  expect(opaque?.type).toBe("opaque");
  expect(raw.includes(`"content":[${JSON.stringify(opaque?.raw)},`)).toBe(true);
  expect(JSON.parse(raw).messages[1].content).toStrictEqual(
    first.content.map((block) => block.raw),
  );
  expect(JSON.parse(raw).messages[1].content[1]).toStrictEqual({
    type: "text",
    text: "Opening the toggle.",
    citations: null,
  });
});

test("Anthropic converse serializes tool results with text and images and marks errors only when set", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_3", ["{}"])));
  const image = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };
  await adapter.converse!({
    ...converseInput,
    messages: [
      ...converseInput.messages,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "click", input: {} },
          { type: "tool_use", id: "toolu_2", name: "click", input: { ref: "e1" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_1",
            content: [
              { type: "text", text: "page text" },
              { type: "image", image },
            ],
          },
          {
            type: "tool_result",
            toolUseId: "toolu_2",
            content: [{ type: "text", text: "Refused" }],
            isError: true,
          },
        ],
      },
    ],
  });
  const [, assistant, user] = sentJson().messages;
  expect(assistant.content).toStrictEqual([
    { type: "tool_use", id: "toolu_1", name: "click", input: {} },
    { type: "tool_use", id: "toolu_2", name: "click", input: { ref: "e1" } },
  ]);
  expect(user.content).toStrictEqual([
    {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [
        { type: "text", text: "page text" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: image.data } },
      ],
    },
    {
      type: "tool_result",
      tool_use_id: "toolu_2",
      content: [{ type: "text", text: "Refused" }],
      is_error: true,
      cache_control: { type: "ephemeral" },
    },
  ]);
});

function toolRoundTrip(id: string, text: string) {
  return [
    {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id, name: "click", input: {} }],
    },
    {
      role: "user" as const,
      content: [
        { type: "tool_result" as const, toolUseId: id, content: [{ type: "text" as const, text }] },
      ],
    },
  ];
}

test("Anthropic converse keeps the billing header of the first user message across turns", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_1", ["{}"])));
  await adapter.converse!(converseInput);
  await adapter.converse!({
    ...converseInput,
    messages: [
      ...converseInput.messages,
      ...toolRoundTrip("toolu_1", "A completely different later message"),
      ...toolRoundTrip("toolu_2", "zzzzzzzzzzzzzzzzzzzzzzzzzzzz"),
    ],
  });
  const [first, third] = [sentJson(0), sentJson(1)];
  expect(third.messages.length).toBe(5);
  const expected = createHash("sha256")
    .update(
      `59cf53e54c78${["4", "7", "20"].map((position) => converseInput.messages[0]!.content[0]!.text[Number(position)]).join("")}2.1.329`,
    )
    .digest("hex")
    .slice(0, 3);
  expect(first.system[0].text).toBe(
    `x-anthropic-billing-header: cc_version=2.1.329.${expected}; cc_entrypoint=sdk-cli;`,
  );
  expect(third.system[0].text).toBe(first.system[0].text);
  expect(third.system[2]).toStrictEqual({
    type: "text",
    text: converseInput.system,
    cache_control: { type: "ephemeral" },
  });
});

test("Anthropic converse retries a tool call with malformed JSON and then reports it", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_1", ['{"ref": '])));
  await expect(adapter.converse!(converseInput)).rejects.toThrow(/invalid JSON input for click/);
  expect(anthropic.calls).toHaveLength(3);
});

test("Anthropic converse recovers when a retry returns valid tool JSON", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    toolTurn(
      toolUseEvents(0, "toolu_1", [anthropic.calls.length === 1 ? "{oops" : '{"ref":"e3"}']),
    ),
  );
  const reply = await adapter.converse!(converseInput);
  expect(reply.content.map((block) => block.type === "tool_use" && block.input)).toStrictEqual([
    { ref: "e3" },
  ]);
  expect(anthropic.calls).toHaveLength(2);
});

test("Anthropic converse accepts a reply that holds only a tool call", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_1", ['{"ref":"e1"}'])));
  const reply = await adapter.converse!(converseInput);
  expect(reply.content.map((block) => block.type)).toStrictEqual(["tool_use"]);
});

test("Anthropic converse rejects a reply without any block", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn([], "end_turn"));
  await expect(adapter.converse!(converseInput)).rejects.toThrow(/returned no content/);
});

test("Anthropic converse accepts a refusal without any block", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn([], "refusal"));
  expect(await adapter.converse!(converseInput)).toStrictEqual({
    content: [],
    usage: { input_tokens: 20, output_tokens: 9 },
    stopReason: "refusal",
  });
});

test("Anthropic converse returns the finished blocks as interrupted when its time runs out", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  const controller = new AbortController();
  anthropic.reply(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              encodeEvents([
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                textDelta("Done part.", 0),
                { type: "content_block_stop", index: 0 },
                {
                  type: "content_block_start",
                  index: 1,
                  content_block: { type: "tool_use", id: "toolu_1", name: "click", input: {} },
                },
                {
                  type: "content_block_delta",
                  index: 1,
                  delta: { type: "input_json_delta", partial_json: '{"re' },
                },
              ]),
            );
          },
          pull() {
            setTimeout(
              () => controller.abort(new DOMException("deadline reached", "TimeoutError")),
              50,
            );
            return new Promise(() => undefined);
          },
        }),
      ),
  );
  const reply = await adapter.converse!({ ...converseInput, signal: controller.signal });
  expect(reply).toStrictEqual({
    content: [{ type: "text", text: "Done part.", raw: { type: "text", text: "Done part." } }],
    usage: {},
    stopReason: "interrupted",
  });
  expect(anthropic.calls).toHaveLength(1);
});

test("Anthropic converse retries a stream that drops before its stop reason", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    anthropic.calls.length === 1
      ? eventStream([
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          textDelta("Half", 0),
          { type: "content_block_stop", index: 0 },
        ])
      : toolTurn(toolUseEvents(0, "toolu_1", ["{}"])),
  );
  const reply = await adapter.converse!(converseInput);
  expect(reply.content.map((block) => block.type)).toStrictEqual(["tool_use"]);
  expect(anthropic.calls).toHaveLength(2);
});

test("Anthropic converse refreshes a rejected session once and retries the turn", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("old-token", Date.now() + 10 * 60_000, "account-test", "refresh-token");
  anthropic.reply((call) => {
    if (call.url === tokenUrl) return refreshed("new-token", "new-refresh");
    if (authorization(call) === "Bearer old-token")
      return Response.json(
        { error: { type: "authentication_error", message: "expired" } },
        { status: 401 },
      );
    return toolTurn(toolUseEvents(0, "toolu_1", ["{}"]));
  });
  const reply = await adapter.converse!(converseInput);
  expect(reply.stopReason).toBe("tool_use");
  expect(anthropic.callsTo(messagesUrl)).toHaveLength(2);
});

test("Anthropic converse reports a missing session as a setup error", async () => {
  const { adapter } = await credentialFixture();
  anthropic.reply(() => toolTurn());
  await expect(adapter.converse!(converseInput)).rejects.toBeInstanceOf(AskSetupError);
});

test("Anthropic converse returns max_tokens without the tool call it cut off", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    toolTurn(
      [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        textDelta("Reporting.", 0),
        { type: "content_block_stop", index: 0 },
        ...toolUseEvents(1, "toolu_1", ['{"status":"found","lines":["a']),
      ],
      "max_tokens",
    ),
  );
  const reply = await adapter.converse!(converseInput);
  expect({
    stopReason: reply.stopReason,
    blocks: reply.content.map((block) => block.type),
  }).toStrictEqual({ stopReason: "max_tokens", blocks: ["text"] });
  expect(anthropic.calls).toHaveLength(1);
});

for (const stopReason of ["max_tokens", "model_context_window_exceeded"])
  test(`Anthropic converse returns an empty ${stopReason} reply when its only block was a cut-off tool call`, async () => {
    const { adapter, writeSession } = await credentialFixture();
    await writeSession("test-token");
    anthropic.reply(() =>
      toolTurn(toolUseEvents(0, "toolu_1", ['{"status":"found","lines":["a']), stopReason),
    );
    const reply = await adapter.converse!(converseInput);
    expect({ stopReason: reply.stopReason, content: reply.content }).toStrictEqual({
      stopReason,
      content: [],
    });
  });

test("Anthropic converse returns a redacted thinking block as opaque", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    toolTurn([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: "encrypted" },
      },
      { type: "content_block_stop", index: 0 },
      ...toolUseEvents(1, "toolu_1", ["{}"]),
    ]),
  );
  const reply = await adapter.converse!(converseInput);
  expect(reply.content[0]).toStrictEqual({
    type: "opaque",
    raw: { type: "redacted_thinking", data: "encrypted" },
  });
});

test("Anthropic converse passes a rejected session without a refresh token up as a setup error", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    Response.json({ error: { type: "authentication_error", message: "invalid" } }, { status: 401 }),
  );
  const error = await rejectionOf(adapter.converse!(converseInput));
  expect(
    error instanceof AskSetupError && /rejected the local Claude Code session/.test(error.message),
  ).toBe(true);
});

test("Anthropic converse leaves out blank text blocks when it sends an assistant turn back", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_2", ["{}"])));
  await adapter.converse!({
    ...converseInput,
    messages: [
      ...converseInput.messages,
      {
        role: "assistant",
        content: [
          { type: "text", text: "", raw: { type: "text", text: "" } },
          { type: "text", text: "\n\n", raw: { type: "text", text: "\n\n" } },
          { type: "tool_use", id: "toolu_1", name: "click", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "toolu_1", content: [{ type: "text", text: "ok" }] },
        ],
      },
    ],
  });
  expect(sentJson().messages[1].content).toStrictEqual([
    { type: "tool_use", id: "toolu_1", name: "click", input: {} },
  ]);
});

test("Anthropic converse leaves out an assistant turn that held only blank text", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() => toolTurn(toolUseEvents(0, "toolu_1", ["{}"])));
  const nudge = {
    role: "user" as const,
    content: [{ type: "text" as const, text: "Call a tool or report." }],
  };
  await adapter.converse!({
    ...converseInput,
    messages: [
      ...converseInput.messages,
      {
        role: "assistant",
        content: [{ type: "text", text: " ", raw: { type: "text", text: " " } }],
      },
      nudge,
    ],
  });
  expect(sentJson().messages.map((message: { role: string }) => message.role)).toStrictEqual([
    "user",
    "user",
  ]);
});

test("Anthropic converse returns no blocks as interrupted when its time runs out before a block finished", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  const controller = new AbortController();
  anthropic.reply(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(
              encodeEvents([
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                textDelta("Half", 0),
              ]),
            );
          },
          pull() {
            setTimeout(
              () => controller.abort(new DOMException("deadline reached", "TimeoutError")),
              50,
            );
            return new Promise(() => undefined);
          },
        }),
      ),
  );
  expect(await adapter.converse!({ ...converseInput, signal: controller.signal })).toStrictEqual({
    content: [],
    usage: {},
    stopReason: "interrupted",
  });
});

test("Anthropic converse does not retry malformed tool JSON after the output token limit", async () => {
  const { adapter, writeSession } = await credentialFixture();
  await writeSession("test-token");
  anthropic.reply(() =>
    eventStream([
      ...toolUseEvents(0, "toolu_1", ['{"ref": ']),
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5000 } },
      { type: "message_stop" },
    ]),
  );
  await expect(adapter.converse!(converseInput)).rejects.toThrow(
    /Retry skipped after 5000 output tokens/,
  );
  expect(anthropic.calls).toHaveLength(1);
});
