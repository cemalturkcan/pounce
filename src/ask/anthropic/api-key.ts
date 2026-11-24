import { z } from "zod";
import { type AskAdapter, modelId } from "../adapter.ts";
import { AskSetupError } from "../errors.ts";
import { ToolError } from "../../shared/errors.ts";
import { errorDetail, networkErrorDetail, RetryableAnthropicError } from "./errors.ts";
import { API_ORIGIN } from "./identity.ts";
import {
  conversationMessages,
  EPHEMERAL,
  type MessagesRequest,
  messageContent,
} from "./messages.ts";
import { retryDelay, shouldRetry, withRetries } from "./retry.ts";
import { apiErrorSchema } from "./schemas.ts";
import { conversationReader, readStream, type StreamReader, textReader } from "./stream.ts";

const MESSAGES_URL = `${API_ORIGIN}/v1/messages`;
const ANTHROPIC_VERSION = "2023-06-01";
const REJECTED_KEY = "Run `pounce install` to set another Anthropic API key.";

const errorPayloadSchema = z.object({ error: apiErrorSchema.optional().catch(undefined) });

async function postMessage(body: string, apiKey: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    redirect: "error",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body,
    signal,
  }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(
      `Network error while sending the Anthropic Messages request${networkErrorDetail(cause, apiKey)}`,
    );
  });
  if (response.ok) return response;

  const payload = errorPayloadSchema.safeParse(await response.json().catch(() => undefined)).data;
  signal.throwIfAborted();
  const detail = errorDetail(payload?.error, apiKey);
  const failure =
    response.status === 401 || response.status === 403
      ? new AskSetupError(
          `Anthropic rejected the API key (HTTP ${response.status})${detail.endsWith(".") ? detail : `${detail}.`} ${REJECTED_KEY}`,
        )
      : new ToolError(`Anthropic Messages returned HTTP ${response.status}${detail}`);
  if (shouldRetry(response)) throw new RetryableAnthropicError(failure, retryDelay(response));
  throw failure;
}

export function apiKeyAskAdapter(apiKey: string): AskAdapter {
  const call = <T>(signal: AbortSignal, request: MessagesRequest, reply: StreamReader<T>) => {
    const body = JSON.stringify(request);
    return withRetries(signal, async () =>
      readStream(await postMessage(body, apiKey, signal), apiKey, signal, reply),
    );
  };
  return {
    name: "Anthropic API key",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      return call(
        signal,
        {
          model: modelId(model),
          max_tokens: maxTokens,
          stream: true,
          system: [{ type: "text", text: system }],
          messages: [{ role: "user", content: messageContent(prompt, images) }],
        },
        textReader,
      );
    },
    async converse({ system, tools, messages, model, maxTokens, signal }) {
      return call(
        signal,
        {
          model: modelId(model),
          max_tokens: maxTokens,
          stream: true,
          system: [{ type: "text", text: system, cache_control: EPHEMERAL }],
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          messages: conversationMessages(messages),
        },
        conversationReader,
      );
    },
  };
}
