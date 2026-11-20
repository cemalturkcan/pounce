import assert from "node:assert/strict";
import { test } from "node:test";
import type { AskMessage, ConverseInput } from "./ask-adapter.ts";
import { scriptedAdapter } from "./ask-script.ts";

const tools = [{ name: "find", description: "find", inputSchema: { type: "object" } }];
const first: AskMessage = { role: "user", content: [{ type: "text", text: "start" }] };
const input = (messages: AskMessage[], system = "sys"): ConverseInput => ({ system, tools, messages, model: "m", maxTokens: 10, signal: new AbortController().signal, conversationId: "c" });

test("scriptedAdapter returns each step's reply and records deep clones of the calls", async () => {
  const adapter = scriptedAdapter([() => ({ content: [{ type: "tool_use", id: "a", name: "find", input: {} }], stopReason: "tool_use" }), () => ({ content: [{ type: "text", text: "done" }], stopReason: "end_turn" })]);
  const messages: AskMessage[] = [first];
  const reply = await adapter.converse(input(messages));
  assert.equal(reply.stopReason, "tool_use");
  messages.push({ role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "r" }] }] });
  assert.equal((await adapter.converse(input(messages))).stopReason, "end_turn");
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls[0]?.messages.length, 1);
  assert.deepEqual(adapter.problems, []);
});

test("scriptedAdapter steps can read the previous tool result", async () => {
  const adapter = scriptedAdapter([
    () => ({ content: [{ type: "tool_use", id: "a", name: "find", input: {} }], stopReason: "tool_use" }),
    (call) => {
      const last = call.messages.at(-1);
      const result = last?.role === "user" ? last.content.find((block) => block.type === "tool_result") : undefined;
      const text = result?.type === "tool_result" ? result.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";
      return { content: [{ type: "text", text: `saw ${text}` }], stopReason: "end_turn" };
    },
  ]);
  const reply = await adapter.converse(input([first]));
  const second = await adapter.converse(input([first, { role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "ref=e7" }] }] }]));
  assert.deepEqual(second.content, [{ type: "text", text: "saw ref=e7" }]);
});

test("scriptedAdapter rejects a changed system prompt", async () => {
  const adapter = scriptedAdapter([() => ({ content: [{ type: "text", text: "x" }] }), () => ({ content: [] })]);
  const reply = await adapter.converse(input([first]));
  await assert.rejects(adapter.converse(input([first, { role: "assistant", content: reply.content }], "other")), /system changed at call 2/);
  assert.equal(adapter.problems.length, 1);
});

test("scriptedAdapter rejects an edited earlier message or a dropped reply", async () => {
  const adapter = scriptedAdapter([() => ({ content: [{ type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig" } }, { type: "text", text: "x" }] }), () => ({ content: [] })]);
  await adapter.converse(input([first]));
  await assert.rejects(adapter.converse(input([first, { role: "assistant", content: [{ type: "text", text: "x" }] }])), /history changed at call 2/);
});

test("scriptedAdapter throws a step's error and says when the script is exhausted", async () => {
  const adapter = scriptedAdapter([() => new Error("upstream down")]);
  await assert.rejects(adapter.converse(input([first])), /upstream down/);
  await assert.rejects(adapter.converse(input([first])), /script exhausted at step 2/);
});

test("scriptedAdapter answers complete through onComplete", async () => {
  const adapter = scriptedAdapter([], { onComplete: async ({ prompt }) => ({ text: `NOT FOUND ${prompt.length}` }) });
  assert.equal((await adapter.complete({ system: "s", prompt: "abc", model: "m", maxTokens: 1, signal: new AbortController().signal })).text, "NOT FOUND 3");
});
