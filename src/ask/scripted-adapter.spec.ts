import { expect, test } from "bun:test";
import type { AskMessage, AskToolDefinition, ConverseInput } from "./adapter.ts";
import { scriptedAdapter } from "../../tests/scriptedAdapter.ts";

const tools: AskToolDefinition[] = [
  { name: "find", description: "find", inputSchema: { type: "object" } },
];
const first: AskMessage = { role: "user", content: [{ type: "text", text: "start" }] };
const input = (messages: AskMessage[], system = "sys"): ConverseInput => ({
  system,
  tools,
  messages,
  model: "m",
  maxTokens: 10,
  signal: new AbortController().signal,
  conversationId: "c",
});

test("scriptedAdapter returns each step's reply and records deep clones of the calls", async () => {
  const adapter = scriptedAdapter([
    () => ({
      content: [{ type: "tool_use", id: "a", name: "find", input: {} }],
      stopReason: "tool_use",
    }),
    () => ({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" }),
  ]);
  const messages: AskMessage[] = [first];
  const reply = await adapter.converse(input(messages));
  expect(reply.stopReason).toBe("tool_use");
  messages.push(
    { role: "assistant", content: reply.content },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "r" }] }],
    },
  );
  expect((await adapter.converse(input(messages))).stopReason).toBe("end_turn");
  expect(adapter.calls.length).toBe(2);
  expect(adapter.calls[0]?.messages.length).toBe(1);
  expect(adapter.problems).toStrictEqual([]);
});

test("scriptedAdapter steps can read the previous tool result", async () => {
  const adapter = scriptedAdapter([
    () => ({
      content: [{ type: "tool_use", id: "a", name: "find", input: {} }],
      stopReason: "tool_use",
    }),
    (call) => {
      const last = call.messages.at(-1);
      const result =
        last?.role === "user"
          ? last.content.find((block) => block.type === "tool_result")
          : undefined;
      const text =
        result?.type === "tool_result"
          ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("")
          : "";
      return { content: [{ type: "text", text: `saw ${text}` }], stopReason: "end_turn" };
    },
  ]);
  const reply = await adapter.converse(input([first]));
  const second = await adapter.converse(
    input([
      first,
      { role: "assistant", content: reply.content },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "ref=e7" }] },
        ],
      },
    ]),
  );
  expect(second.content).toStrictEqual([{ type: "text", text: "saw ref=e7" }]);
});

test("scriptedAdapter rejects a changed system prompt", async () => {
  const adapter = scriptedAdapter([
    () => ({ content: [{ type: "text", text: "x" }] }),
    () => ({ content: [] }),
  ]);
  const reply = await adapter.converse(input([first]));
  await expect(
    adapter.converse(input([first, { role: "assistant", content: reply.content }], "other")),
  ).rejects.toThrow(/system changed at call 2/);
  expect(adapter.problems.length).toBe(1);
});

test("scriptedAdapter rejects an edited earlier message or a dropped reply", async () => {
  const adapter = scriptedAdapter([
    () => ({
      content: [
        { type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig" } },
        { type: "text", text: "x" },
      ],
    }),
    () => ({ content: [] }),
  ]);
  await adapter.converse(input([first]));
  await expect(
    adapter.converse(input([first, { role: "assistant", content: [{ type: "text", text: "x" }] }])),
  ).rejects.toThrow(/history changed at call 2/);
});

test("scriptedAdapter throws a step's error and says when the script is exhausted", async () => {
  const adapter = scriptedAdapter([() => new Error("upstream down")]);
  await expect(adapter.converse(input([first]))).rejects.toThrow(/upstream down/);
  await expect(adapter.converse(input([first]))).rejects.toThrow(/script exhausted at step 2/);
});

test("scriptedAdapter answers complete through onComplete", async () => {
  const adapter = scriptedAdapter([], {
    onComplete: async ({ prompt }) => ({ text: `NOT FOUND ${prompt.length}` }),
  });
  expect(
    (
      await adapter.complete({
        system: "s",
        prompt: "abc",
        model: "m",
        maxTokens: 1,
        signal: new AbortController().signal,
      })
    ).text,
  ).toBe("NOT FOUND 3");
});
