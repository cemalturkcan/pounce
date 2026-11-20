import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { AskMessage, ConverseInput } from "./ask-adapter.ts";
import { scriptedAdapter } from "./ask-script.ts";
import { recordingAdapter, replayAdapter } from "./browse-capture.ts";

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-capture-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tools = [{ name: "screenshot", description: "shot", inputSchema: { type: "object" } }];
const imageData = Buffer.from("fake jpeg bytes").toString("base64");
const imageSha = createHash("sha256").update(Buffer.from(imageData, "base64")).digest("hex");

const input = (messages: AskMessage[]): ConverseInput => ({ system: "SYS", tools, messages, model: "m", maxTokens: 100, signal: new AbortController().signal, conversationId: "c" });

async function conversation(adapter: { converse(input: ConverseInput): Promise<{ content: AskMessage["content"] }> }, image = imageData) {
  const messages: AskMessage[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const first = await adapter.converse(input(messages));
  messages.push({ role: "assistant", content: first.content as never }, {
    role: "user",
    content: [{ type: "tool_result", toolUseId: "a", content: [{ type: "text", text: "shot saved" }, { type: "image", image: { mediaType: "image/jpeg", data: image } }] }],
  });
  return adapter.converse(input(messages));
}

const script = () =>
  scriptedAdapter([
    () => ({ content: [{ type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig" } }, { type: "tool_use", id: "a", name: "screenshot", input: {} }], stopReason: "tool_use" }),
    () => ({ content: [{ type: "tool_use", id: "b", name: "report", input: { status: "found" } }], stopReason: "tool_use" }),
  ]);

test("32: the recorder writes the system prompt, tools, only the appended messages per turn and images by sha", async () => {
  const folder = path.join(dir, "rec");
  await conversation(recordingAdapter(script(), folder));
  assert.equal(await readFile(path.join(folder, "system.txt"), "utf8"), "SYS");
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, "tools.json"), "utf8")), tools);
  const lines = (await readFile(path.join(folder, "turns.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.turn, 1);
  assert.equal(lines[0]?.systemSha, createHash("sha256").update("SYS").digest("hex"));
  assert.equal((lines[0]?.appended as unknown[]).length, 1);
  assert.equal((lines[1]?.appended as unknown[]).length, 1);
  const raw = await readFile(path.join(folder, "turns.jsonl"), "utf8");
  assert.ok(!raw.includes(imageData), "no base64 in the jsonl");
  assert.ok(raw.includes(`"sha256":"${imageSha}"`));
  assert.deepEqual(await readdir(path.join(folder, "images")), [`${imageSha}.jpg`]);
  assert.deepEqual((lines[0]?.reply as { content: unknown[] }).content[0], { type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig" } });
});

test("33: replay returns the recorded replies and stops when the conversation diverges", async () => {
  const folder = path.join(dir, "replay");
  await conversation(recordingAdapter(script(), folder));
  const replayed = await conversation(await replayAdapter(folder));
  assert.deepEqual(replayed.content, [{ type: "tool_use", id: "b", name: "report", input: { status: "found" } }]);
  const other = Buffer.from("another image").toString("base64");
  await assert.rejects(conversation(await replayAdapter(folder), other), /replay diverged at turn 2: /);
});
