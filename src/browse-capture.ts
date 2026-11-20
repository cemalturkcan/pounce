import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AskAdapter, AskImage, AskMessage, ConverseInput, ConverseReply } from "./ask-adapter.ts";

const EXTENSIONS: Record<AskImage["mediaType"], string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

type StoredImage = { type: "image"; mediaType: AskImage["mediaType"]; sha256: string; file: string };

export type TranscriptLine = {
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
          ? { ...block, content: block.content.map((part) => (part.type === "image" ? storeImage(part.image, images) : part)) }
          : block,
    ),
  };
}

class AppendTracker {
  private seen = 0;
  private reply?: ConverseReply;

  next(messages: AskMessage[]) {
    const pending = messages[this.seen];
    const replyEchoed = this.reply?.content.length && pending?.role === "assistant" && isDeepStrictEqual(pending.content, this.reply.content);
    const appended = messages.slice(this.seen + (replyEchoed ? 1 : 0));
    this.seen = messages.length;
    return appended;
  }

  replied(reply: ConverseReply | undefined) {
    this.reply = reply;
  }
}

function signature(stored: unknown[]) {
  return JSON.stringify(
    stored.map((message) => {
      const { role, content } = message as { role: string; content: Record<string, unknown>[] };
      return {
        role,
        blocks: content.map((block) => ({
          type: block.type,
          id: block.id ?? block.toolUseId,
          sha256: block.sha256,
          parts: Array.isArray(block.content) ? (block.content as Record<string, unknown>[]).map((part) => part.sha256 ?? part.type) : undefined,
        })),
      };
    }),
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
    const appended = this.tracker.next(entry.input.messages).map((message) => storeMessage(message, images));
    this.tracker.replied(entry.reply);
    for (const [hash, { file, bytes }] of images) {
      if (this.written.has(hash)) continue;
      await mkdir(path.join(this.dir, "images"), { recursive: true });
      await writeFile(path.join(this.dir, file), bytes);
      this.written.add(hash);
    }
    const line: TranscriptLine = {
      turn: this.turns,
      model: entry.input.model,
      maxTokens: entry.input.maxTokens,
      systemSha: sha256(entry.input.system),
      toolsSha: sha256(toolsJson),
      appended,
      ...(entry.reply ? { reply: entry.reply } : {}),
      ms: entry.ms,
      ...(entry.error ? { error: entry.error } : {}),
    };
    await appendFile(path.join(this.dir, "turns.jsonl"), `${JSON.stringify(line)}\n`);
  }

  async finish(result: unknown) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, "result.json"), JSON.stringify(result, null, 2));
  }
}

export function recordingAdapter(inner: AskAdapter, dir: string): AskAdapter & Required<Pick<AskAdapter, "converse">> {
  const writer = new TranscriptWriter(dir);
  return {
    name: inner.name,
    complete: (input) => inner.complete(input),
    converse: async (input) => {
      if (!inner.converse) throw new Error(`${inner.name} does not support tool use (no converse()).`);
      const startedAt = Date.now();
      try {
        const reply = await inner.converse(input);
        await writer.turn({ input, reply, ms: Date.now() - startedAt });
        return reply;
      } catch (error) {
        await writer.turn({ input, error: (error instanceof Error ? error.message : String(error)).split("\n")[0], ms: Date.now() - startedAt });
        throw error;
      }
    },
  };
}

export async function replayAdapter(dir: string): Promise<AskAdapter & Required<Pick<AskAdapter, "converse">>> {
  const tools = JSON.parse(await readFile(path.join(dir, "tools.json"), "utf8")) as { name: string }[];
  const lines = (await readFile(path.join(dir, "turns.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranscriptLine);
  const tracker = new AppendTracker();
  let turn = 0;
  return {
    name: `replay of ${dir}`,
    complete: async () => {
      throw new Error("a replay adapter only answers converse()");
    },
    converse: async (input) => {
      turn += 1;
      const line = lines[turn - 1];
      const diverged = (why: string) => new Error(`replay diverged at turn ${turn}: ${why}`);
      if (!line) throw diverged(`the recording has only ${lines.length} turns`);
      const names = input.tools.map((tool) => tool.name).join(", ");
      const recordedNames = tools.map((tool) => tool.name).join(", ");
      if (names !== recordedNames) throw diverged(`tools are ${names}, the recording has ${recordedNames}`);
      const appended = tracker.next(input.messages).map((message) => storeMessage(message, new Map()));
      const live = signature(appended);
      const recorded = signature(line.appended);
      if (live !== recorded) throw diverged(`the appended messages are ${live}, the recording has ${recorded}`);
      tracker.replied(line.reply);
      if (line.error || !line.reply) throw new Error(line.error ?? "the recorded turn has no reply");
      return structuredClone(line.reply);
    },
  };
}
