import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import type {
  AskMessage,
  AskToolDefinition,
  ConverseInput,
  ConverseReply,
} from "../ask/adapter.ts";
import { scriptedAdapter } from "../../tests/scriptedAdapter.ts";
import { replayAdapter } from "../../tests/replayAdapter.ts";
import { recordingAdapter } from "./transcript.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-capture-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tools: AskToolDefinition[] = [
  { name: "screenshot", description: "shot", inputSchema: { type: "object" } },
];
const imageData = Buffer.from("fake jpeg bytes").toString("base64");
const imageSha = createHash("sha256").update(Buffer.from(imageData, "base64")).digest("hex");

const input = (messages: AskMessage[]): ConverseInput => ({
  system: "SYS",
  tools,
  messages,
  model: "m",
  maxTokens: 100,
  signal: new AbortController().signal,
  conversationId: "c",
});

const recordedTurn = z.object({
  turn: z.number(),
  systemSha: z.string(),
  appended: z.array(z.unknown()),
  reply: z.object({ content: z.array(z.unknown()) }).optional(),
});

async function conversation(
  adapter: { converse(input: ConverseInput): Promise<ConverseReply> },
  image = imageData,
) {
  const messages: AskMessage[] = [{ role: "user", content: [{ type: "text", text: "start" }] }];
  const first = await adapter.converse(input(messages));
  messages.push(
    { role: "assistant", content: first.content },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "a",
          content: [
            { type: "text", text: "shot saved" },
            { type: "image", image: { mediaType: "image/jpeg", data: image } },
          ],
        },
      ],
    },
  );
  return adapter.converse(input(messages));
}

const script = () =>
  scriptedAdapter([
    () => ({
      content: [
        { type: "opaque", raw: { type: "thinking", thinking: "", signature: "sig" } },
        { type: "tool_use", id: "a", name: "screenshot", input: {} },
      ],
      stopReason: "tool_use",
    }),
    () => ({
      content: [{ type: "tool_use", id: "b", name: "report", input: { status: "found" } }],
      stopReason: "tool_use",
    }),
  ]);

test("32: the recorder writes the system prompt, tools, only the appended messages per turn and images by sha", async () => {
  const folder = path.join(dir, "rec");
  await conversation(recordingAdapter(script(), folder));
  expect(await readFile(path.join(folder, "system.txt"), "utf8")).toBe("SYS");
  expect(JSON.parse(await readFile(path.join(folder, "tools.json"), "utf8"))).toStrictEqual(tools);
  const lines = (await readFile(path.join(folder, "turns.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => parseJsonOrThrow(line, recordedTurn));
  expect(lines.length).toBe(2);
  expect(lines[0]?.turn).toBe(1);
  expect(lines[0]?.systemSha).toBe(createHash("sha256").update("SYS").digest("hex"));
  expect(lines[0]?.appended.length).toBe(1);
  expect(lines[1]?.appended.length).toBe(1);
  const raw = await readFile(path.join(folder, "turns.jsonl"), "utf8");
  expect(raw).not.toContain(imageData);
  expect(raw).toContain(`"sha256":"${imageSha}"`);
  expect(await readdir(path.join(folder, "images"))).toStrictEqual([`${imageSha}.jpg`]);
  expect(lines[0]?.reply?.content[0]).toStrictEqual({
    type: "opaque",
    raw: { type: "thinking", thinking: "", signature: "sig" },
  });
});

test("33: replay returns the recorded replies and stops when the conversation diverges", async () => {
  const folder = path.join(dir, "replay");
  await conversation(recordingAdapter(script(), folder));
  const replayed = await conversation(await replayAdapter(folder));
  expect(replayed.content).toStrictEqual([
    { type: "tool_use", id: "b", name: "report", input: { status: "found" } },
  ]);
  const other = Buffer.from("another image").toString("base64");
  await expect(conversation(await replayAdapter(folder), other)).rejects.toThrow(
    /replay diverged at turn 2: /,
  );
});
