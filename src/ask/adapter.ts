import { z } from "zod";
import { describeError } from "../shared/errors.ts";
import { logEvent } from "../log/logger.ts";

const MODEL_IDS = new Map([
  ["haiku", "claude-haiku-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["opus", "claude-opus-5-5"],
]);

export function modelId(model: string) {
  return MODEL_IDS.get(model.trim().toLowerCase()) ?? model;
}

export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;

export type AskImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type AskImage = {
  mediaType: AskImageMediaType;
  data: string;
  label?: string;
};

export type AskInput = {
  system: string;
  prompt: string;
  model: string;
  maxTokens: number;
  images?: AskImage[];
  signal: AbortSignal;
};

export type AskUsage = Record<string, number>;

export type AskReply = {
  text: string;
  usage?: AskUsage;
  stopReason?: string;
};

export type AskTextBlock = { type: "text"; text: string };
export type AskImageBlock = { type: "image"; image: AskImage };
export type AskToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  raw?: JsonObject;
};
type AskAssistantTextBlock = AskTextBlock & { raw?: JsonObject };
type AskOpaqueBlock = { type: "opaque"; raw: JsonObject };
export type AskToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: (AskTextBlock | AskImageBlock)[];
  isError?: boolean;
};
export type AskAssistantBlock = AskAssistantTextBlock | AskToolUseBlock | AskOpaqueBlock;
export type AskUserBlock = AskTextBlock | AskImageBlock | AskToolResultBlock;
export type AskMessage =
  | { role: "user"; content: AskUserBlock[] }
  | { role: "assistant"; content: AskAssistantBlock[] };
export type AskToolInputSchema = z.core.JSONSchema.JSONSchema;
export type AskToolDefinition = {
  name: string;
  description: string;
  inputSchema: AskToolInputSchema;
};
type AskStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "model_context_window_exceeded"
  | "stop_sequence"
  | "interrupted"
  | (string & {});

export type ConverseInput = {
  system: string;
  tools: AskToolDefinition[];
  messages: AskMessage[];
  model: string;
  maxTokens: number;
  signal: AbortSignal;
  conversationId: string;
};

export type ConverseReply = {
  content: AskAssistantBlock[];
  stopReason?: AskStopReason;
  usage?: AskUsage;
};

export type AskAdapter = {
  name: string;
  complete(input: AskInput): Promise<AskReply>;
  converse?(input: ConverseInput): Promise<ConverseReply>;
};

export function supportsTools(
  adapter: AskAdapter,
): adapter is AskAdapter & Required<Pick<AskAdapter, "converse">> {
  return typeof adapter.converse === "function";
}

export function isCutOff(stopReason: string | undefined) {
  return stopReason === "max_tokens" || stopReason === "model_context_window_exceeded";
}

type ModelCallContext = {
  tool: string;
  call: number | string;
  pages?: number;
  requestId?: string;
  page?: string;
  step?: number;
};

function isPartial(stopReason: string | undefined) {
  return stopReason === "interrupted" || stopReason === "refusal" || isCutOff(stopReason);
}

export function firstErrorLine(cause: unknown) {
  return describeError(cause).split("\n")[0] ?? "";
}

export async function completeLogged(
  adapter: AskAdapter,
  input: AskInput,
  context: ModelCallContext,
): Promise<AskReply> {
  const startedAt = Date.now();
  const images = input.images ?? [];
  const fields = {
    tool: context.tool,
    adapter: adapter.name,
    model: input.model,
    call: context.call,
    pages: context.pages,
    images: images.length,
    imageBytes: images.reduce((total, image) => total + image.data.length, 0),
    promptChars: input.prompt.length,
  };
  try {
    const reply = await adapter.complete(input);
    logEvent(
      "model_call",
      {
        ...fields,
        ms: Date.now() - startedAt,
        ok: true,
        stopReason: reply?.stopReason,
        usage: reply?.usage,
      },
      isPartial(reply?.stopReason) ? "warn" : "info",
    );
    return reply;
  } catch (error) {
    logEvent(
      "model_call",
      { ...fields, ms: Date.now() - startedAt, ok: false, error: firstErrorLine(error) },
      "warn",
    );
    throw error;
  }
}

function messageImages(messages: AskMessage[]) {
  return messages.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((block) =>
          block.type === "image"
            ? [block.image]
            : block.type === "tool_result"
              ? block.content.flatMap((part) => (part.type === "image" ? [part.image] : []))
              : [],
        )
      : [],
  );
}

export async function converseLogged(
  adapter: AskAdapter,
  input: ConverseInput,
  context: ModelCallContext,
): Promise<ConverseReply> {
  const startedAt = Date.now();
  const images = messageImages(input.messages);
  const fields = {
    tool: context.tool,
    adapter: adapter.name,
    model: input.model,
    call: context.call,
    requestId: context.requestId,
    page: context.page,
    step: context.step,
    messages: input.messages.length,
    toolResults: input.messages.reduce(
      (total, message) =>
        total +
        (message.role === "user"
          ? message.content.filter((block) => block.type === "tool_result").length
          : 0),
      0,
    ),
    images: images.length,
    imageBytes: images.reduce((total, image) => total + image.data.length, 0),
  };
  try {
    if (!supportsTools(adapter))
      throw new Error(`${adapter.name} does not support tool use (no converse()).`);
    const reply = await adapter.converse(input);
    const toolUses = (reply?.content ?? []).flatMap((block) =>
      block.type === "tool_use" ? [block.name] : [],
    );
    logEvent(
      "model_call",
      {
        ...fields,
        ms: Date.now() - startedAt,
        ok: true,
        toolUses,
        stopReason: reply?.stopReason,
        usage: reply?.usage,
      },
      isPartial(reply?.stopReason) ? "warn" : "info",
    );
    return reply;
  } catch (error) {
    logEvent(
      "model_call",
      { ...fields, ms: Date.now() - startedAt, ok: false, error: firstErrorLine(error) },
      "warn",
    );
    throw error;
  }
}

export function failureReason(cause: unknown, timeoutMs: number | undefined) {
  if (cause instanceof Error && cause.name === "TimeoutError")
    return `no answer within ${timeoutMs} ms`;
  const line = firstErrorLine(cause);
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

export function addUsage(total: AskUsage, usage: AskUsage | undefined) {
  for (const [key, value] of Object.entries(usage ?? {})) {
    if (Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
  }
}
