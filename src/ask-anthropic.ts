import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AskAdapter, AskImage, AskReply, AskUsage } from "./ask-adapter.ts";
import { AskSetupError } from "./ask.ts";
import { ToolError } from "./errors.ts";

const API_ORIGIN = "https://api.anthropic.com";
const MESSAGES_URL = `${API_ORIGIN}/v1/messages?beta=true`;
const PROFILE_URL = `${API_ORIGIN}/api/oauth/profile`;
const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_VERSION = "2.1.296";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, ${CLAUDE_CODE_ENTRYPOINT})`;
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const BILLING_FINGERPRINT_SALT = "59cf53e54c78";
const CLAUDE_CODE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "inline-tools-2026-09-15",
  "advisor-tool-2026-03-01",
  "effort-2025-11-24",
  "extended-cache-ttl-2025-04-11",
].join(",");
const MODEL_ALIASES = new Map([
  ["haiku", "claude-haiku-5-5"],
  ["sonnet", "claude-sonnet-5-5"],
  ["opus", "claude-opus-5-5"],
]);
const SIGN_IN = "Sign in to Claude Code with `claude auth login`, then try ask_pages again.";
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const RETRY_JITTER_MS = 250;
const RETRY_OUTPUT_TOKEN_LIMIT = 4_096;

type ApiError = { type?: unknown; message?: unknown };
type ClaudeCredentials = {
  claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
  accountUuid?: unknown;
};

class RetryableAnthropicError extends ToolError {
  readonly failure: ToolError;
  readonly retryAfterMs?: number;

  constructor(failure: string | ToolError, retryAfterMs?: number) {
    super(typeof failure === "string" ? failure : failure.message);
    this.failure = typeof failure === "string" ? new ToolError(failure) : failure;
    this.retryAfterMs = retryAfterMs;
  }
}

function errorDetail(error: ApiError | undefined, token: string) {
  const detail = [error?.type, error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.replaceAll(token, "[REDACTED]").replace(/\s+/g, " ").trim())
    .join(": ")
    .slice(0, 500);
  return detail ? `: ${detail}` : ".";
}

function networkErrorDetail(error: unknown, token: string) {
  const cause = error instanceof Error ? error.cause ?? error : error;
  const detail = cause instanceof AggregateError ? cause.errors[0] ?? cause : cause;
  if (detail && typeof detail === "object") {
    return errorDetail({
      type: "code" in detail ? detail.code : undefined,
      message: "message" in detail ? detail.message : undefined,
    }, token);
  }
  return errorDetail({ message: detail }, token);
}

async function readCredentials(credentialsPath: string, signal: AbortSignal) {
  let credentials: ClaudeCredentials;
  try {
    credentials = JSON.parse(await readFile(credentialsPath, { encoding: "utf8", signal })) as ClaudeCredentials;
  } catch {
    signal.throwIfAborted();
    throw new AskSetupError(`Could not read Claude Code credentials at ${credentialsPath}.`, SIGN_IN);
  }
  const oauth = credentials.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) {
    throw new AskSetupError(`Claude Code credentials at ${credentialsPath} lack a Claude account access token.`, SIGN_IN);
  }
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
    throw new AskSetupError("The local Claude Code session has expired.", SIGN_IN);
  }
  return {
    accessToken: oauth.accessToken,
    accountUuid: typeof credentials.accountUuid === "string" ? credentials.accountUuid : undefined,
  };
}

function billingHeader(messageText: string) {
  const sampled = [4, 7, 20].map((position) => messageText[position] ?? "0").join("");
  const suffix = createHash("sha256")
    .update(BILLING_FINGERPRINT_SALT + sampled + CLAUDE_CODE_VERSION)
    .digest("hex")
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`;
}

function deviceId() {
  let username = process.env.USER ?? "";
  try {
    username = userInfo().username;
  } catch {}
  return createHash("sha256").update(`${hostname()}:${username}`).digest("hex");
}

function claudeCodeHeaders(token: string, sessionId: string) {
  const architectures: Record<string, string> = { x64: "x64", arm64: "arm64", ia32: "ia32", arm: "arm" };
  const platforms: Record<string, string> = { linux: "Linux", darwin: "MacOS", win32: "Windows" };
  return {
    authorization: `Bearer ${token}`,
    accept: "text/event-stream",
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": CLAUDE_CODE_BETAS,
    "anthropic-dangerous-direct-browser-access": "true",
    "user-agent": CLAUDE_CODE_USER_AGENT,
    "x-app": "cli",
    "x-claude-code-session-id": sessionId,
    "x-stainless-arch": architectures[process.arch] ?? process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": platforms[process.platform] ?? `Other:${process.platform}`,
    "x-stainless-package-version": "0.128.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-timeout": "600",
  };
}

async function readAccountUuid(token: string, signal: AbortSignal) {
  const response = await fetch(PROFILE_URL, {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    signal,
  });
  const payload = await response.json().catch(() => undefined) as { account?: { uuid?: unknown }; error?: ApiError } | undefined;
  const uuid = payload?.account?.uuid;
  if (!response.ok || typeof uuid !== "string" || !uuid) {
    throw new AskSetupError(`Could not read the local Claude account profile (HTTP ${response.status})${errorDetail(payload?.error, token)}`, SIGN_IN);
  }
  return uuid;
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
  error?: ApiError;
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

async function readMessage(response: Response, token: string, signal: AbortSignal): Promise<AskReply> {
  if (!response.body) throw new RetryableAnthropicError("Anthropic Messages returned no stream.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const parts: string[] = [];
  const usage: AskUsage = {};
  let stopReason: string | undefined;
  let pending = "";
  const separator = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read().catch((error: unknown) => {
        throw new RetryableAnthropicError(`Network error while reading the Anthropic Messages stream${networkErrorDetail(error, token)}`);
      });
      signal.throwIfAborted();
      if (done) throw new RetryableAnthropicError("Anthropic Messages stream ended before message_stop.");
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
          case "error": {
            const message = `Anthropic Messages stream error${errorDetail(event.error, token)}`;
            if (event.error?.type === "overloaded_error" || event.error?.type === "api_error") {
              throw new RetryableAnthropicError(message);
            }
            throw new ToolError(message);
          }
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
    const text = parts.join("");
    const partial = text.trim().length > 0;
    if (partial && signal.reason instanceof Error && signal.reason.name === "TimeoutError") {
      return { text, usage, stopReason: stopReason === "refusal" ? stopReason : "interrupted" };
    }
    signal.throwIfAborted();
    if (!(error instanceof RetryableAnthropicError)) throw error;
    if (stopReason === "refusal") return { text, usage, stopReason };
    if (partial) return { text, usage, stopReason: "interrupted" };
    const outputTokens = usage.output_tokens ?? 0;
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

function retryDelay(response: Response) {
  const numberPattern = /^\d+(\.\d+)?$/;
  const milliseconds = response.headers.get("retry-after-ms");
  if (milliseconds && numberPattern.test(milliseconds)) return Number(milliseconds);
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  if (numberPattern.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function postMessage(body: string, token: string, sessionId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    redirect: "error",
    headers: claudeCodeHeaders(token, sessionId),
    body,
    signal,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(`Network error while sending the Anthropic Messages request${networkErrorDetail(error, token)}`);
  });
  if (response.ok) return response;

  const payload = await response.json().catch(() => undefined) as { error?: ApiError } | undefined;
  signal.throwIfAborted();
  const detail = errorDetail(payload?.error, token);
  const failure = response.status === 401
    ? new AskSetupError(`Anthropic rejected the local Claude Code session (HTTP 401)${detail}`, SIGN_IN)
    : new ToolError(`Anthropic Messages returned HTTP ${response.status}${detail}`);
  const retry = response.headers.get("x-should-retry");
  const retryableStatus = [408, 409, 429].includes(response.status) || (response.status >= 500 && response.status < 600);
  if (retry === "true" || (retry !== "false" && retryableStatus)) {
    throw new RetryableAnthropicError(failure, retryDelay(response));
  }
  throw failure;
}

async function completeMessage(body: string, token: string, sessionId: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readMessage(await postMessage(body, token, sessionId, signal), token, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RetryableAnthropicError)) throw error;
      const wait = error.retryAfterMs ?? 250 * 2 ** attempt;
      if (wait > MAX_RETRY_DELAY_MS) {
        const failure = error.failure;
        const message = `${failure.message} Retry-After (${wait / 1000} s) exceeds the 60-second wait limit.`;
        if (failure instanceof AskSetupError) throw new AskSetupError(message, failure.hint);
        throw new ToolError(message, failure.hint);
      }
      if (attempt >= MAX_RETRIES) throw error.failure;
      const withJitter = Math.min(wait + Math.random() * RETRY_JITTER_MS, MAX_RETRY_DELAY_MS);
      await delay(withJitter, undefined, { signal }).catch((abort: unknown) => {
        signal.throwIfAborted();
        throw abort;
      });
    }
  }
}

export function anthropicAskAdapter(configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude")): AskAdapter {
  const credentialsPath = path.join(configDir, ".credentials.json");
  const sessionId = randomUUID();
  const localDeviceId = deviceId();
  let profiledToken: string | undefined;
  let profiledAccountUuid: string | undefined;
  return {
    name: "Anthropic Claude account",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      const credentials = await readCredentials(credentialsPath, signal);
      const token = credentials.accessToken;
      let accountUuid = credentials.accountUuid;
      if (!accountUuid && profiledToken === token) accountUuid = profiledAccountUuid;
      if (!accountUuid) {
        accountUuid = await readAccountUuid(token, signal);
        profiledToken = token;
        profiledAccountUuid = accountUuid;
      }
      const body = JSON.stringify({
        model: MODEL_ALIASES.get(model) ?? model,
        max_tokens: maxTokens,
        stream: true,
        system: [
          { type: "text", text: billingHeader(prompt) },
          { type: "text", text: CLAUDE_CODE_IDENTITY },
          { type: "text", text: system },
        ],
        messages: [{ role: "user", content: messageContent(prompt, images) }],
        metadata: {
          user_id: JSON.stringify({ device_id: localDeviceId, account_uuid: accountUuid, session_id: sessionId }),
        },
      });
      return completeMessage(body, token, sessionId, signal);
    },
  };
}
