import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type {
  AskAdapter,
  AskImage,
  AskMessage,
  ConverseInput,
  ConverseReply,
} from "../ask/adapter.ts";
import { jsonObjectSchema } from "../ask/adapter.ts";
import { inSequence } from "../shared/async.ts";
import type { BrowseResult } from "../ask/run.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { messageOf } from "../shared/errors.ts";

const EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} satisfies Record<AskImage["mediaType"], string>;

type StoredImage = {
  type: "image";
  mediaType: AskImage["mediaType"];
  sha256: string;
  file: string;
};

type TranscriptLine = {
  turn: number;
  model: string;
  maxTokens: number;
  systemSha: string;
  toolsSha: string;
  appended: unknown[];
  reply?: ConverseReply;
  ms: number;
  error?: string;
};

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

type ImageFiles = Map<string, { file: string; bytes: Buffer }>;

function storeImage(image: AskImage, images: ImageFiles): StoredImage {
  const bytes = Buffer.from(image.data, "base64");
  const hash = sha256(bytes);
  const file = `images/${hash}.${EXTENSIONS[image.mediaType] ?? "bin"}`;
  images.set(hash, { file, bytes });
  return { type: "image", mediaType: image.mediaType, sha256: hash, file };
}

function storeMessage(message: AskMessage, images: ImageFiles) {
  if (message.role === "assistant") return message;
  return {
    role: message.role,
    content: message.content.map((block) =>
      block.type === "image"
        ? storeImage(block.image, images)
        : block.type === "tool_result"
          ? {
              ...block,
              content: block.content.map((part) =>
                part.type === "image" ? storeImage(part.image, images) : part,
              ),
            }
          : block,
    ),
  };
}

class AppendTracker {
  private seen = 0;
  private reply?: ConverseReply;

  next(messages: AskMessage[]) {
    const pending = messages[this.seen];
    const replyEchoed =
      this.reply?.content.length &&
      pending?.role === "assistant" &&
      isDeepStrictEqual(pending.content, this.reply.content);
    const appended = messages.slice(this.seen + (replyEchoed ? 1 : 0));
    this.seen = messages.length;
    return appended;
  }

  replied(reply: ConverseReply | undefined) {
    this.reply = reply;
  }
}

const storedPart = z.object({ type: z.string(), sha256: z.string().optional() });
const storedBlock = z.object({
  type: z.string(),
  id: z.string().optional(),
  toolUseId: z.string().optional(),
  sha256: z.string().optional(),
  content: z.array(storedPart).optional().catch(undefined),
});
const storedMessages = z.array(z.object({ role: z.string(), content: z.array(storedBlock) }));

const recordedBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), raw: jsonObjectSchema.optional() }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    raw: jsonObjectSchema.optional(),
  }),
  z.object({ type: z.literal("opaque"), raw: jsonObjectSchema }),
]);
const recordedReply = z.object({
  content: z.array(recordedBlock),
  stopReason: z.string().optional(),
  usage: z.record(z.string(), z.number()).optional(),
});
const recordedLine = z.object({
  appended: storedMessages,
  reply: recordedReply.optional(),
  error: z.string().optional(),
});
const recordedTools = z.array(z.object({ name: z.string() }));

function signature(stored: z.infer<typeof storedMessages>) {
  return JSON.stringify(
    stored.map(({ role, content }) => ({
      role,
      blocks: content.map((block) => ({
        type: block.type,
        id: block.id ?? block.toolUseId,
        sha256: block.sha256,
        parts: block.content?.map((part) => part.sha256 ?? part.type),
      })),
    })),
  );
}

export class TranscriptWriter {
  readonly dir: string;
  private turns = 0;
  private readonly tracker = new AppendTracker();
  private readonly written = new Set<string>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async turn(entry: { input: ConverseInput; reply?: ConverseReply; error?: string; ms: number }) {
    this.turns += 1;
    const toolsJson = JSON.stringify(entry.input.tools, null, 2);
    if (this.turns === 1) {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path.join(this.dir, "system.txt"), entry.input.system);
      await writeFile(path.join(this.dir, "tools.json"), toolsJson);
    }
    const images: ImageFiles = new Map();
    const appended = this.tracker
      .next(entry.input.messages)
      .map((message) => storeMessage(message, images));
    this.tracker.replied(entry.reply);
    await inSequence([...images], async ([hash, { file, bytes }]) => {
      if (this.written.has(hash)) return;
      await mkdir(path.join(this.dir, "images"), { recursive: true });
      await writeFile(path.join(this.dir, file), bytes);
      this.written.add(hash);
    });
    const line: TranscriptLine = {
      turn: this.turns,
      model: entry.input.model,
      maxTokens: entry.input.maxTokens,
      systemSha: sha256(entry.input.system),
      toolsSha: sha256(toolsJson),
      appended,
      ms: entry.ms,
    };
    if (entry.reply) line.reply = entry.reply;
    if (entry.error) line.error = entry.error;
    await appendFile(path.join(this.dir, "turns.jsonl"), `${JSON.stringify(line)}\n`);
  }

  async finish(result: BrowseResult) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, "result.json"), JSON.stringify(result, null, 2));
  }
}

export function recordingAdapter(
  inner: AskAdapter,
  dir: string,
): AskAdapter & Required<Pick<AskAdapter, "converse">> {
  const writer = new TranscriptWriter(dir);
  return {
    name: inner.name,
    complete: (input) => inner.complete(input),
    converse: async (input) => {
      if (!inner.converse)
        throw new Error(`${inner.name} does not support tool use (no converse()).`);
      const startedAt = Date.now();
      try {
        const reply = await inner.converse(input);
        await writer.turn({ input, reply, ms: Date.now() - startedAt });
        return reply;
      } catch (cause) {
        await writer.turn({
          input,
          error: messageOf(cause).split("\n")[0],
          ms: Date.now() - startedAt,
        });
        throw cause;
      }
    },
  };
}

export class AppendSignatures {
  private readonly tracker = new AppendTracker();

  next(messages: AskMessage[]) {
    const appended = this.tracker.next(messages).map((message) => storeMessage(message, new Map()));
    return signature(storedMessages.parse(appended));
  }

  replied(reply: ConverseReply | undefined) {
    this.tracker.replied(reply);
  }
}

export async function readRecording(dir: string) {
  const tools = parseJsonOrThrow(
    await readFile(path.join(dir, "tools.json"), "utf8"),
    recordedTools,
  );
  const turns = (await readFile(path.join(dir, "turns.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJsonOrThrow(line, recordedLine))
    .map((line) => ({ appended: signature(line.appended), reply: line.reply, error: line.error }));
  return { tools: tools.map((tool) => tool.name), turns };
}
