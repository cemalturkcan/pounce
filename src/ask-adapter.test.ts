import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { type AskAdapter, completeLogged } from "./ask-adapter.ts";
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
