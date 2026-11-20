import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { AskAdapter, AskImage } from "./ask-adapter.ts";
import { AskSetupError } from "./ask.ts";
import { ToolError } from "./errors.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODEL_ALIASES = new Map([
  ["haiku", "claude-haiku-5-5"],
  ["sonnet", "claude-sonnet-4-6"],
  ["opus", "claude-opus-4-8"],
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

type MessagesResponse = {
  content?: Array<{ type?: string; text?: string }>;
  usage?: Record<string, unknown>;
  stop_reason?: unknown;
};

function messageContent(prompt: string, images?: AskImage[]) {
  if (!images?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map(({ mediaType, data }) => ({
      type: "image",
      source: { type: "base64", media_type: mediaType, data },
    })),
  ];
}

export function anthropicAskAdapter(configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude")): AskAdapter {
  const credentialsPath = path.join(configDir, ".credentials.json");
  return {
    name: "Anthropic (local Claude login)",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      const token = await readAccessToken(credentialsPath, signal);
      const response = await fetch(MESSAGES_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        },
        body: JSON.stringify({
          model: MODEL_ALIASES.get(model) ?? model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: messageContent(prompt, images) }],
        }),
        signal,
      });
      if (response.status === 401) {
        await response.body?.cancel();
        throw new AskSetupError("Anthropic rejected the local Claude Code session (HTTP 401).", SIGN_IN);
      }
      if (!response.ok) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const retry = retryAfter && /^\d+$/.test(retryAfter) ? ` Retry after ${retryAfter} seconds.` : "";
        throw new ToolError(`Anthropic Messages returned HTTP ${response.status}.${retry}`);
      }
      const payload = await response.json().catch(() => {
        signal.throwIfAborted();
        throw new ToolError("Anthropic Messages returned invalid JSON.");
      }) as MessagesResponse;
      if (!Array.isArray(payload?.content)) throw new ToolError("Anthropic Messages returned invalid content.");
      const text = payload.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");
      const stopReason = typeof payload.stop_reason === "string" ? payload.stop_reason : undefined;
      if (!text.trim() && stopReason !== "refusal" && stopReason !== "max_tokens") {
        throw new ToolError("Anthropic Messages returned no text.");
      }
      const usage = Object.fromEntries(
        Object.entries(payload.usage ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])),
      );
      return { text, usage, stopReason };
    },
  };
}
