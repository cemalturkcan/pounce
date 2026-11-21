import { z } from "zod";
import {
  type AskAssistantBlock,
  type AskReply,
  type AskUsage,
  type ConverseReply,
  isCutOff,
  type JsonObject,
  jsonObjectSchema,
} from "../adapter.ts";
import { parseJson } from "../../shared/decode.ts";
import { ToolError } from "../../shared/errors.ts";
import { errorDetail, networkErrorDetail, RetryableAnthropicError } from "./errors.ts";
import { apiErrorSchema, blockType, optionalString, textOrEmpty } from "./schemas.ts";

const RETRY_OUTPUT_TOKEN_LIMIT = 4_096;

const usageSchema = z
  .record(z.string(), z.number().optional().catch(undefined))
  .optional()
  .catch(undefined);
const streamEventSchema = z
  .object({
    type: optionalString,
    index: z.number().int().nonnegative().optional().catch(undefined),
    message: z.object({ usage: usageSchema }).optional().catch(undefined),
    delta: z
      .object({
        type: optionalString,
        text: optionalString,
        thinking: optionalString,
        signature: optionalString,
        partial_json: optionalString,
        stop_reason: optionalString,
      })
      .optional()
      .catch(undefined),
    content_block: jsonObjectSchema.optional().catch(undefined),
    usage: usageSchema,
    error: apiErrorSchema.optional().catch(undefined),
  })
  .optional()
  .catch(undefined);
type StreamEvent = NonNullable<z.infer<typeof streamEventSchema>>;

function replyBlock(raw: JsonObject): AskAssistantBlock {
  if (raw.type === "text") return { type: "text", text: textOrEmpty.parse(raw.text), raw };
  if (raw.type === "tool_use")
    return { type: "tool_use", id: String(raw.id), name: String(raw.name), input: raw.input, raw };
  return { type: "opaque", raw };
}

type StreamBlock = { raw: JsonObject; json?: string; done: boolean; invalidInput?: boolean };
type StreamState = { blocks: StreamBlock[]; usage: AskUsage; stopReason?: string };
export type StreamReader<T> = {
  finish(state: StreamState): T;
  cutShort(state: StreamState, cause: { timedOut: boolean; dropped: boolean }): T | undefined;
};

function parseEvent(frame: string): StreamEvent | undefined {
  const data = frame
    .split(/\r\n|[\r\n]/)
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return;
  const event = parseJson(data, streamEventSchema);
  if (!event.success) throw new ToolError("Anthropic Messages returned an invalid stream event.");
  return event.data;
}

function updateUsage(usage: AskUsage, counts: z.infer<typeof usageSchema>) {
  for (const [name, value] of Object.entries(counts ?? {})) {
    if (value !== undefined && Number.isFinite(value)) usage[name] = value;
  }
}

function blockIndex(event: StreamEvent, fallback: number) {
  return event.index ?? fallback;
}

function appendString(raw: JsonObject, key: "text" | "thinking", value: string | undefined) {
  if (value !== undefined) raw[key] = textOrEmpty.parse(raw[key]) + value;
}

function applyDelta(blocks: StreamBlock[], event: StreamEvent) {
  const delta = event.delta;
  const index = blockIndex(event, Math.max(blocks.length - 1, 0));
  if (!blocks[index] && delta?.type === "text_delta")
    blocks[index] = { raw: { type: "text", text: "" }, done: false };
  const block = blocks[index];
  if (!block || !delta) return;
  if (delta.type === "text_delta") appendString(block.raw, "text", delta.text);
  if (delta.type === "thinking_delta") appendString(block.raw, "thinking", delta.thinking);
  if (delta.type === "signature_delta" && delta.signature !== undefined)
    block.raw.signature = delta.signature;
  if (delta.type === "input_json_delta" && delta.partial_json !== undefined)
    block.json = (block.json ?? "") + delta.partial_json;
}

function closeBlock(block: StreamBlock | undefined) {
  if (!block) return;
  if (block.json !== undefined || block.raw.type === "tool_use") {
    const input = parseJson(block.json || "{}", z.json());
    if (input.success) block.raw.input = input.data;
    else block.invalidInput = true;
  }
  block.done = true;
}

function streamText(state: StreamState) {
  return state.blocks
    .filter((block) => block.raw.type === "text")
    .map((block) => String(block.raw.text ?? ""))
    .join("");
}

function emptyReplyError(stopReason: string | undefined, produced: string) {
  if (stopReason === "max_tokens")
    return new ToolError(
      `Anthropic Messages reached max_tokens before producing ${produced}. Raise max_output_tokens.`,
    );
  if (stopReason === "model_context_window_exceeded")
    return new ToolError(
      `Anthropic Messages stopped with model_context_window_exceeded before producing ${produced}.`,
    );
  if (stopReason !== "refusal") return new ToolError(`Anthropic Messages returned no ${produced}.`);
  return undefined;
}

export const textReader: StreamReader<AskReply> = {
  finish(state) {
    const text = streamText(state);
    const empty = text.trim() ? undefined : emptyReplyError(state.stopReason, "text");
    if (empty) throw empty;
    return { text, usage: state.usage, stopReason: state.stopReason };
  },
  cutShort(state, { timedOut, dropped }) {
    const text = streamText(state);
    return text.trim() && (timedOut || dropped)
      ? { text, usage: state.usage, stopReason: "interrupted" }
      : undefined;
  },
};

function completedContent(state: StreamState) {
  return state.blocks
    .filter((block) => block.done && !block.invalidInput)
    .map((block) => replyBlock(block.raw));
}

export const conversationReader: StreamReader<ConverseReply> = {
  finish(state) {
    const invalid = state.blocks.find((block) => block?.invalidInput);
    if (invalid && !isCutOff(state.stopReason)) {
      throw new RetryableAnthropicError(
        `Anthropic Messages returned invalid JSON input for ${String(invalid.raw.name ?? invalid.raw.type)}.`,
      );
    }
    const content = completedContent(state);
    const empty =
      content.length || isCutOff(state.stopReason)
        ? undefined
        : emptyReplyError(state.stopReason, "content");
    if (empty) throw empty;
    return { content, usage: state.usage, stopReason: state.stopReason };
  },
  cutShort(state, { timedOut }) {
    return timedOut
      ? { content: completedContent(state), usage: state.usage, stopReason: "interrupted" }
      : undefined;
  },
};

function applyEvent(state: StreamState, event: StreamEvent | undefined, token: string) {
  switch (event?.type) {
    case "message_start":
      updateUsage(state.usage, event.message?.usage);
      return false;
    case "content_block_start":
      if (event.content_block && blockType.safeParse(event.content_block).success) {
        state.blocks[blockIndex(event, state.blocks.length)] = {
          raw: { ...event.content_block },
          done: false,
        };
      }
      return false;
    case "content_block_delta":
      applyDelta(state.blocks, event);
      return false;
    case "content_block_stop":
      closeBlock(state.blocks[blockIndex(event, state.blocks.length - 1)]);
      return false;
    case "message_delta":
      updateUsage(state.usage, event.usage);
      if (event.delta?.stop_reason !== undefined) state.stopReason = event.delta.stop_reason;
      return false;
    case "error": {
      const message = `Anthropic Messages stream error${errorDetail(event.error, token)}`;
      if (event.error?.type === "overloaded_error" || event.error?.type === "api_error") {
        throw new RetryableAnthropicError(message);
      }
      throw new ToolError(message);
    }
    case "message_stop":
      return true;
    default:
      return false;
  }
}

export async function readStream<T>(
  response: Response,
  token: string,
  signal: AbortSignal,
  reply: StreamReader<T>,
): Promise<T> {
  if (!response.body) throw new RetryableAnthropicError("Anthropic Messages returned no stream.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const state: StreamState = { blocks: [], usage: {} };
  const separator = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/;

  const pump = async (pending: string): Promise<T> => {
    signal.throwIfAborted();
    const { done, value } = await reader.read().catch((cause: unknown) => {
      throw new RetryableAnthropicError(
        `Network error while reading the Anthropic Messages stream${networkErrorDetail(cause, token)}`,
      );
    });
    signal.throwIfAborted();
    if (done) {
      if (state.stopReason !== undefined) return reply.finish(state);
      throw new RetryableAnthropicError("Anthropic Messages stream ended before message_stop.");
    }
    let rest = pending + value;
    let boundary: RegExpExecArray | null;
    while ((boundary = separator.exec(rest))) {
      const event = parseEvent(rest.slice(0, boundary.index));
      rest = rest.slice(boundary.index + boundary[0].length);
      if (applyEvent(state, event, token)) return reply.finish(state);
    }
    return pump(rest);
  };

  try {
    return await pump("");
  } catch (cause) {
    let error = cause;
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    if (state.stopReason !== undefined && (error instanceof RetryableAnthropicError || timedOut)) {
      try {
        return reply.finish(state);
      } catch (finishCause) {
        error = finishCause;
      }
    }
    const cut = reply.cutShort(state, {
      timedOut,
      dropped: error instanceof RetryableAnthropicError && !signal.aborted,
    });
    if (cut) return cut;
    signal.throwIfAborted();
    if (!(error instanceof RetryableAnthropicError)) throw error;
    const outputTokens = state.usage.output_tokens ?? 0;
    if (outputTokens >= RETRY_OUTPUT_TOKEN_LIMIT) {
      throw new ToolError(`${error.message} Retry skipped after ${outputTokens} output tokens.`);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
