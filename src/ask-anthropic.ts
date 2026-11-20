import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AskAdapter, AskImage, AskReply, AskUsage } from "./ask-adapter.ts";
import { AskSetupError } from "./ask.ts";
import { ToolError } from "./errors.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ALIASES = new Map([
  ["haiku", "claude-haiku-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["opus", "claude-opus-5-5"],
]);
const SIGN_IN = "Sign in to Claude Code with `claude auth login`, then try ask_pages again.";

async function readAccessToken(credentialsPath: string, signal: AbortSignal) {
  let oauth: { accessToken?: unknown; expiresAt?: unknown } | undefined;
  try {
    const credentials = JSON.parse(await readFile(credentialsPath, { encoding: "utf8", signal }));
    oauth = credentials?.claudeAiOauth;
  } catch {
    signal.throwIfAborted();
    throw new AskSetupError(`Could not read Claude Code credentials at ${credentialsPath}.`, SIGN_IN);
  }
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) {
    throw new AskSetupError(`Claude Code credentials at ${credentialsPath} lack a Claude account access token.`, SIGN_IN);
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
    throw new AskSetupError("The local Claude Code session has expired.", SIGN_IN);
  }
  return oauth.accessToken;
}

function messageContent(prompt: string, images?: AskImage[]) {
  if (!images?.length) return prompt;
  return [
    ...images.flatMap(({ mediaType, data, label }) => [
      ...(label ? [{ type: "text", text: `Screenshot: ${label}` }] : []),
      { type: "image", source: { type: "base64", media_type: mediaType, data } },
    ]),
    { type: "text", text: prompt },
  ];
}

type StreamEvent = {
  type?: string;
  message?: { usage?: Record<string, unknown> };
  delta?: { type?: string; text?: unknown; stop_reason?: unknown };
  content_block?: { type?: string; text?: unknown };
  usage?: Record<string, unknown>;
};

function parseEvent(frame: string): StreamEvent | undefined {
  const data = frame.split(/\r\n|[\r\n]/)
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return;
  try {
    return JSON.parse(data) as StreamEvent;
  } catch {
    throw new ToolError("Anthropic Messages returned an invalid stream event.");
  }
}

function updateUsage(usage: AskUsage, counts?: Record<string, unknown>) {
  for (const [name, value] of Object.entries(counts ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) usage[name] = value;
  }
}

async function readMessage(response: Response, signal: AbortSignal): Promise<AskReply> {
  if (!response.body) throw new ToolError("Anthropic Messages returned no stream.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parts: string[] = [];
  const usage: AskUsage = {};
  let stopReason: string | undefined;
  let pending = "";
  const separator = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) throw new ToolError("Anthropic Messages stream ended before message_stop.");
      pending += value;

      let boundary: RegExpExecArray | null;
      while ((boundary = separator.exec(pending))) {
        const event = parseEvent(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        switch (event?.type) {
          case "message_start":
            updateUsage(usage, event.message?.usage);
            break;
          case "content_block_start":
            if (event.content_block?.type === "text" && typeof event.content_block.text === "string") {
              parts.push(event.content_block.text);
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
              parts.push(event.delta.text);
            }
            break;
          case "message_delta":
            updateUsage(usage, event.usage);
            if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason;
            break;
          case "error":
            throw new ToolError("Anthropic Messages reported an error in the stream.");
          case "message_stop": {
            const text = parts.join("");
            if (!text.trim() && stopReason !== "refusal" && stopReason !== "max_tokens") {
              throw new ToolError("Anthropic Messages returned no text.");
            }
            return { text, usage, stopReason };
          }
        }
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function retryDelay(response: Response) {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function postMessage(body: string, token: string, signal: AbortSignal) {
  const maxRetries = 2;
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const response = await fetch(MESSAGES_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      body,
      signal,
    });
    if (response.ok) return response;

    await response.body?.cancel();
    if (response.status === 401) {
      throw new AskSetupError("Anthropic rejected the local Claude Code session (HTTP 401).", SIGN_IN);
    }
    const wait = retryDelay(response);
    if (response.status !== 429 || attempt >= maxRetries) {
      const retryAfter = wait !== undefined && Number.isFinite(wait) ? ` Retry after ${Math.ceil(wait / 1000)} seconds.` : "";
      throw new ToolError(`Anthropic Messages returned HTTP ${response.status}.${retryAfter}`);
    }
    try {
      await delay(Math.min(wait ?? 250 * 2 ** attempt, 2 ** 31 - 1), undefined, { signal });
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    }
  }
}

export function anthropicAskAdapter(configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude")): AskAdapter {
  const credentialsPath = path.join(configDir, ".credentials.json");
  return {
    name: "Anthropic (local Claude login)",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      const token = await readAccessToken(credentialsPath, signal);
      const body = JSON.stringify({
        model: MODEL_ALIASES.get(model) ?? model,
        max_tokens: maxTokens,
        stream: true,
        system,
        messages: [{ role: "user", content: messageContent(prompt, images) }],
      });
      return readMessage(await postMessage(body, token, signal), signal);
    },
  };
}
