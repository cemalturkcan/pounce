import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type AskAdapter, completeLogged, converseLogged, supportsTools } from "./ask-adapter.ts";
import { logFileName, Logger, useLogger } from "./log.ts";
import { Redactor } from "./output.ts";

let dir: string;
let logger: Logger;
const redactor = new Redactor();

async function entries() {
  await logger.flush();
  const raw = await readFile(path.join(dir, logFileName(Date.now())), "utf8");
  return { raw, list: raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-adapter-log-"));
  logger = new Logger({ dir, redactor, stderr: () => undefined });
  useLogger(logger);
});

after(async () => {
  useLogger(undefined);
  await rm(dir, { recursive: true, force: true });
});

const input = (signal = new AbortController().signal) => ({
  system: "sys",
  prompt: "page text that must not be logged",
  model: "claude-haiku-5-5",
  maxTokens: 100,
  images: [
    { mediaType: "image/png" as const, data: "AAAA" },
    { mediaType: "image/jpeg" as const, data: "BBBBBBBB" },
  ],
  signal,
});

test("a successful model call is logged with its numbers and no content", async () => {
  const adapter: AskAdapter = { name: "fake", complete: async () => ({ text: "answer text", stopReason: "end_turn", usage: { input_tokens: 1200, output_tokens: 30 } }) };
  const reply = await completeLogged(adapter, input(), { tool: "ask_pages", call: 2, pages: 5 });
  assert.equal(reply.text, "answer text");
  const { raw, list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.call === 2);
  assert.ok(entry);
  assert.equal(entry.level, "info");
  assert.equal(entry.tool, "ask_pages");
  assert.equal(entry.adapter, "fake");
  assert.equal(entry.model, "claude-haiku-5-5");
  assert.equal(entry.pages, 5);
  assert.equal(entry.images, 2);
  assert.equal(entry.imageBytes, 12);
  assert.equal(entry.stopReason, "end_turn");
  assert.deepEqual(entry.usage, { input_tokens: 1200, output_tokens: 30 });
  assert.equal(entry.ok, true);
  assert.equal(typeof entry.ms, "number");
  assert.doesNotMatch(raw, /must not be logged|answer text|AAAA/);
});

test("a failed model call is logged at warn with the redacted first error line and rethrown", async () => {
  redactor.register("api", "sk-ant-secret-key-1234");
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => {
      throw new Error("401 invalid key sk-ant-secret-key-1234\nsecond line detail");
    },
  };
  await assert.rejects(completeLogged(adapter, input(), { tool: "compare_design", call: "r3" }), /401 invalid key/);
  const { raw, list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.call === "r3");
  assert.ok(entry);
  assert.equal(entry.level, "warn");
  assert.equal(entry.ok, false);
  assert.equal(entry.tool, "compare_design");
  assert.equal(entry.error, "401 invalid key <secret:api>");
  assert.doesNotMatch(raw, /sk-ant-secret-key-1234|second line detail/);
});

test("an interrupted stream is logged at warn with its stop reason", async () => {
  const adapter: AskAdapter = { name: "fake", complete: async () => ({ text: "partial", stopReason: "interrupted", usage: { output_tokens: 7 } }) };
  const reply = await completeLogged(adapter, input(), { tool: "ask_pages", call: 9, pages: 1 });
  assert.equal(reply.stopReason, "interrupted");
  const { list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.call === 9);
  assert.ok(entry);
  assert.equal(entry.level, "warn");
  assert.equal(entry.ok, true);
  assert.equal(entry.stopReason, "interrupted");
});

const converseInput = (signal = new AbortController().signal) => ({
  system: "browse system",
  tools: [{ name: "find", description: "find things", inputSchema: { type: "object" } }],
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "page text that must not be logged" }] },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "tu1", name: "screenshot", input: {} }] },
    {
      role: "user" as const,
      content: [{ type: "tool_result" as const, toolUseId: "tu1", content: [{ type: "text" as const, text: "result text" }, { type: "image" as const, image: { mediaType: "image/jpeg" as const, data: "CCCCCC" } }] }],
    },
  ],
  model: "claude-haiku-5-5",
  maxTokens: 1000,
  signal,
  conversationId: "c1",
});

test("a converse call is logged with its request, page, step, tool uses and stop reason and no content", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({ text: "" }),
    converse: async () => ({ content: [{ type: "text", text: "secret reasoning text" }, { type: "tool_use", id: "tu2", name: "click", input: { target: "e5" } }], stopReason: "tool_use", usage: { input_tokens: 50 } }),
  };
  const reply = await converseLogged(adapter, converseInput(), { tool: "ask_pages.browse", call: 4, requestId: "abc123", page: "02-acme.md", step: 4 });
  assert.equal(reply.stopReason, "tool_use");
  const { raw, list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.requestId === "abc123");
  assert.ok(entry);
  assert.equal(entry.level, "info");
  assert.equal(entry.tool, "ask_pages.browse");
  assert.equal(entry.page, "02-acme.md");
  assert.equal(entry.step, 4);
  assert.equal(entry.messages, 3);
  assert.equal(entry.toolResults, 1);
  assert.equal(entry.images, 1);
  assert.equal(entry.imageBytes, 6);
  assert.deepEqual(entry.toolUses, ["click"]);
  assert.equal(entry.stopReason, "tool_use");
  assert.deepEqual(entry.usage, { input_tokens: 50 });
  assert.doesNotMatch(raw, /must not be logged|result text|secret reasoning|CCCCCC|e5/);
});

test("a refused converse call is logged at warn", async () => {
  const adapter: AskAdapter = { name: "fake", complete: async () => ({ text: "" }), converse: async () => ({ content: [], stopReason: "refusal" }) };
  await converseLogged(adapter, converseInput(), { tool: "ask_pages.browse", call: 1, requestId: "ref001", page: "p", step: 1 });
  const { list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.requestId === "ref001");
  assert.equal(entry?.level, "warn");
});

test("a failing converse call is logged at warn with its first error line and rethrown", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({ text: "" }),
    converse: async () => {
      throw new Error("overloaded\nsecond line detail");
    },
  };
  await assert.rejects(converseLogged(adapter, converseInput(), { tool: "ask_pages.browse", call: 2, requestId: "err001", page: "p", step: 2 }), /overloaded/);
  const { raw, list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.requestId === "err001");
  assert.equal(entry?.level, "warn");
  assert.equal(entry?.ok, false);
  assert.equal(entry?.error, "overloaded");
  assert.doesNotMatch(raw, /second line detail/);
});

test("supportsTools is false without converse and true with it", () => {
  assert.equal(supportsTools({ name: "plain", complete: async () => ({ text: "" }) }), false);
  assert.equal(supportsTools({ name: "tools", complete: async () => ({ text: "" }), converse: async () => ({ content: [] }) }), true);
});
