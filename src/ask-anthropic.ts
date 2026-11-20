import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir, hostname, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AskAdapter, AskImage, AskReply, AskUsage } from "./ask-adapter.ts";
import { AskSetupError, modelId } from "./ask.ts";
import { untilAborted } from "./async.ts";
import { ToolError } from "./errors.ts";

const API_ORIGIN = "https://api.anthropic.com";
const MESSAGES_URL = `${API_ORIGIN}/v1/messages?beta=true`;
const PROFILE_URL = `${API_ORIGIN}/api/oauth/profile`;
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code", "user:mcp_servers", "user:file_upload", "user:plugins"];
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
const SIGN_IN = "Sign in to Claude Code with `claude auth login`, then try again.";
const MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 60_000;
const RETRY_JITTER_MS = 250;
const RETRY_OUTPUT_TOKEN_LIMIT = 4_096;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_BACKOFF_MS = 8_000;
const REFRESH_WINDOW_MS = 5 * 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_RACE_WAIT_MS = 2_000;
const REFRESH_RACE_POLL_MS = 100;
const REFRESH_LOCK_STALE_MS = 60_000;
const STORAGE_LOCK_STALE_MS = 15_000;

type ApiError = { type?: unknown; message?: unknown };
type ClaudeCredentials = {
  claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; [key: string]: unknown };
  accountUuid?: unknown;
  [key: string]: unknown;
};

class RejectedSessionError extends AskSetupError {}

class RetryableAnthropicError extends ToolError {
  readonly failure: ToolError;
  readonly retryAfterMs?: number;

  constructor(failure: string | ToolError, retryAfterMs?: number) {
    super(typeof failure === "string" ? failure : failure.message);
    this.failure = typeof failure === "string" ? new ToolError(failure) : failure;
    this.retryAfterMs = retryAfterMs;
  }
}

function redact(value: string, secrets: string | string[]) {
  return [secrets].flat().filter(Boolean).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
}

function errorDetail(error: ApiError | undefined, secrets: string | string[]) {
  const detail = [error?.type, error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => redact(value, secrets).replace(/\s+/g, " ").trim())
    .join(": ")
    .slice(0, 500);
  return detail ? `: ${detail}` : ".";
}

function networkErrorDetail(error: unknown, token: string | string[]) {
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

async function readCredentialsDocument(credentialsPath: string, signal?: AbortSignal) {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(credentialsPath, { encoding: "utf8", signal }));
  } catch {
    signal?.throwIfAborted();
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new AskSetupError(`Could not read Claude Code credentials at ${credentialsPath}.`, SIGN_IN);
  }
  return document as ClaudeCredentials;
}

async function readCredentials(credentialsPath: string, signal: AbortSignal) {
  const credentials = await readCredentialsDocument(credentialsPath, signal);
  const oauth = credentials.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken.trim()) {
    throw new AskSetupError(`Claude Code credentials at ${credentialsPath} lack a Claude account access token.`, SIGN_IN);
  }
  return {
    document: credentials,
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : undefined,
    clientId: typeof oauth.clientId === "string" && oauth.clientId ? oauth.clientId : OAUTH_CLIENT_ID,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0) : [],
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    accountUuid: typeof credentials.accountUuid === "string" ? credentials.accountUuid : undefined,
  };
}

function rejectsSession(status: number, error: ApiError | undefined) {
  return status === 401 || (status === 403 && typeof error?.message === "string" && error.message.includes("OAuth token has been revoked"));
}

function shouldRetry(response: Response) {
  const retry = response.headers.get("x-should-retry");
  const retryableStatus = [408, 409, 429].includes(response.status) || (response.status >= 500 && response.status < 600);
  return retry === "true" || (retry !== "false" && retryableStatus);
}

async function withRetries<T>(signal: AbortSignal, run: (attempt: number) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RetryableAnthropicError)) throw error;
      const wait = error.retryAfterMs ?? Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_BACKOFF_MS);
      if (wait > MAX_RETRY_DELAY_MS) {
        const failure = error.failure;
        const Failure = failure.constructor as typeof ToolError;
        throw new Failure(`${failure.message} Retry-After (${wait / 1000} s) exceeds the 60-second wait limit.`, failure.hint);
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

async function requestTokenRefresh(tokens: { accessToken: string; refreshToken: string; clientId: string }, scope: string | undefined, signal: AbortSignal) {
  const secrets = [tokens.accessToken, tokens.refreshToken];
  const refreshToken = tokens.refreshToken;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", "user-agent": CLAUDE_CODE_USER_AGENT },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: tokens.clientId,
      ...(scope ? { scope } : {}),
    }),
    signal,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(`Could not refresh the local Claude session${networkErrorDetail(error, secrets)}`);
  });
  const payload = await response.json().catch(() => undefined) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | undefined;
  if (!response.ok) {
    if (shouldRetry(response)) {
      const failure = new ToolError(`Claude session refresh failed (HTTP ${response.status})${refreshErrorDetail(payload, secrets)}`);
      throw new RetryableAnthropicError(failure, retryDelay(response));
    }
    return { response, payload };
  }
  if (typeof payload?.access_token !== "string" || !payload.access_token) {
    throw new AskSetupError("Claude session refresh returned no access token.", SIGN_IN);
  }
  return { response, payload };
}

function refreshErrorDetail(payload: { error?: unknown; error_description?: unknown } | undefined, secrets: string[]) {
  const type = typeof payload?.error === "string" ? payload.error : undefined;
  const message = typeof payload?.error_description === "string" ? payload.error_description : undefined;
  return errorDetail({ type, message }, secrets);
}

function isExpiring(credentials: { expiresAt?: number }) {
  return credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() + REFRESH_WINDOW_MS;
}

function isUsable(credentials: { expiresAt?: number }) {
  return credentials.expiresAt === undefined || credentials.expiresAt > Date.now();
}

async function waitForNewerCredentials(credentialsPath: string, staleToken: string, signal: AbortSignal) {
  const deadline = Date.now() + REFRESH_RACE_WAIT_MS;
  while (true) {
    const latest = await readCredentials(credentialsPath, signal);
    if (latest.accessToken !== staleToken && !isExpiring(latest)) return true;
    if (Date.now() >= deadline) return false;
    await delay(REFRESH_RACE_POLL_MS, undefined, { signal });
  }
}

async function acquireLock(lockPath: string, signal: AbortSignal, staleMs = REFRESH_LOCK_STALE_MS) {
  while (true) {
    try {
      await mkdir(lockPath);
      const { birthtimeMs } = await lstat(lockPath);
      return async () => {
        const lock = await lstat(lockPath).catch(() => undefined);
        if (lock?.birthtimeMs === birthtimeMs) await rmdir(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const lock = await lstat(lockPath).catch(() => undefined);
    const stale = lock !== undefined && Date.now() - lock.mtimeMs > staleMs;
    if (stale && await rmdir(lockPath).then(() => true, () => false)) continue;
    await delay(REFRESH_RACE_POLL_MS, undefined, { signal });
  }
}

async function withRefreshLocks<T>(credentialsPath: string, signal: AbortSignal, run: () => Promise<T>) {
  const configDir = path.dirname(credentialsPath);
  const releaseLock = await acquireLock(path.join(configDir, ".oauth_refresh.lock"), signal);
  try {
    const releaseLegacyLock = await acquireLock(`${await realpath(configDir).catch(() => configDir)}.lock`, signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if (error instanceof Error && "code" in error && typeof error.code === "string") return async () => undefined;
      throw error;
    });
    try {
      return await run();
    } finally {
      await releaseLegacyLock();
    }
  } finally {
    await releaseLock();
  }
}

async function saveRefreshedTokens(credentialsPath: string, stale: { accessToken: string; refreshToken: string }, tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] }) {
  const releaseLock = await acquireLock(path.join(path.dirname(credentialsPath), ".storage-write.lock"), AbortSignal.timeout(REFRESH_TIMEOUT_MS), STORAGE_LOCK_STALE_MS);
  try {
    await writeRefreshedTokens(credentialsPath, stale, tokens);
  } finally {
    await releaseLock();
  }
}

async function writeRefreshedTokens(credentialsPath: string, stale: { accessToken: string; refreshToken: string }, tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] }) {
  const document = await readCredentialsDocument(credentialsPath);
  const oauth = document.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return;
  const blank = typeof oauth.accessToken !== "string" || !oauth.accessToken.trim();
  if (!blank && (oauth.accessToken !== stale.accessToken || oauth.refreshToken !== stale.refreshToken)) return;
  document.claudeAiOauth = { ...oauth, ...tokens };
  const target = await realpath(credentialsPath).catch(() => credentialsPath);
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, JSON.stringify(document, null, 2), { mode: 0o600 });
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function refreshCredentialsFile(credentialsPath: string, signal: AbortSignal, deadRefreshTokens: Set<string>, rejectedToken?: string) {
  return withRefreshLocks(credentialsPath, signal, async () => {
    const credentials = await readCredentials(credentialsPath, signal);
    if (rejectedToken === undefined ? !isExpiring(credentials) : credentials.accessToken !== rejectedToken) return;
    if (!credentials.refreshToken) throw new AskSetupError("The local Claude Code session expired without a refresh token.", SIGN_IN);
    if (deadRefreshTokens.has(credentials.refreshToken)) throw new AskSetupError("The local Claude Code session can no longer be refreshed.", SIGN_IN);

    const tokens = { accessToken: credentials.accessToken, refreshToken: credentials.refreshToken, clientId: credentials.clientId };
    const refresh = (scope: string | undefined) => withRetries(signal, () => requestTokenRefresh(tokens, scope, signal));
    const storedScopes = credentials.scopes.length ? credentials.scopes.join(" ") : undefined;
    let answer = await refresh([...new Set([...OAUTH_SCOPES, ...credentials.scopes])].join(" "));
    if (!answer.response.ok && answer.payload?.error === "invalid_scope") answer = await refresh(storedScopes);
    if (!answer.response.ok) {
      if (await waitForNewerCredentials(credentialsPath, credentials.accessToken, signal)) return;
      deadRefreshTokens.add(tokens.refreshToken);
      throw new AskSetupError(`Claude session refresh failed (HTTP ${answer.response.status})${refreshErrorDetail(answer.payload, [tokens.accessToken, tokens.refreshToken])}`, SIGN_IN);
    }

    const expiresIn = typeof answer.payload?.expires_in === "number" ? answer.payload.expires_in : 3_600;
    await saveRefreshedTokens(credentialsPath, tokens, {
      accessToken: String(answer.payload?.access_token),
      refreshToken: typeof answer.payload?.refresh_token === "string" && answer.payload.refresh_token
        ? answer.payload.refresh_token
        : tokens.refreshToken,
      expiresAt: Date.now() + Math.min(Math.max(expiresIn, 60), 86_400) * 1_000,
      ...(typeof answer.payload?.scope === "string" && answer.payload.scope.trim() ? { scopes: answer.payload.scope.trim().split(/\s+/) } : {}),
    });
  });
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

function claudeCodeHeaders(token: string, sessionId: string, retryCount: number) {
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
    "x-stainless-retry-count": String(retryCount),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-timeout": "600",
  };
}

async function readAccountUuid(token: string, signal: AbortSignal) {
  const response = await fetch(PROFILE_URL, {
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    signal,
  }).catch((error: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(`Could not read the local Claude account profile${networkErrorDetail(error, token)}`);
  });
  const payload = await response.json().catch(() => undefined) as { account?: { uuid?: unknown }; error?: ApiError } | undefined;
  signal.throwIfAborted();
  const uuid = payload?.account?.uuid;
  if (response.ok && typeof uuid === "string" && uuid) return uuid;
  const message = `Could not read the local Claude account profile (HTTP ${response.status})${errorDetail(payload?.error, token)}`;
  if (rejectsSession(response.status, payload?.error)) throw new RejectedSessionError(message, SIGN_IN);
  if (shouldRetry(response)) throw new RetryableAnthropicError(new ToolError(message), retryDelay(response));
  throw new AskSetupError(message, SIGN_IN);
}

function firstText(prompt: string, images?: AskImage[]) {
  const label = images?.find((image) => image.label)?.label;
  return label ? `Screenshot: ${label}` : prompt;
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
  const finish = (): AskReply => {
    const text = parts.join("");
    if (!text.trim() && stopReason === "max_tokens") {
      throw new ToolError("Anthropic Messages reached max_tokens before producing text. Raise max_output_tokens.");
    }
    if (!text.trim() && stopReason !== "refusal") {
      throw new ToolError("Anthropic Messages returned no text.");
    }
    return { text, usage, stopReason };
  };
  const separator = /(?:\r\n|\r(?!\n)|(?<!\r)\n){2}/;

  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read().catch((error: unknown) => {
        throw new RetryableAnthropicError(`Network error while reading the Anthropic Messages stream${networkErrorDetail(error, token)}`);
      });
      signal.throwIfAborted();
      if (done) {
        if (stopReason !== undefined) return finish();
        throw new RetryableAnthropicError("Anthropic Messages stream ended before message_stop.");
      }
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
          case "message_stop":
            return finish();
        }
      }
    }
  } catch (error) {
    const text = parts.join("");
    const partial = text.trim().length > 0;
    const timedOut = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    if (stopReason !== undefined && (error instanceof RetryableAnthropicError || timedOut)) return finish();
    if (partial && timedOut) {
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

async function postMessage(body: string, token: string, sessionId: string, retryCount: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    redirect: "error",
    headers: claudeCodeHeaders(token, sessionId, retryCount),
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
  const failure = rejectsSession(response.status, payload?.error)
    ? new RejectedSessionError(`Anthropic rejected the local Claude Code session (HTTP ${response.status})${detail}`, SIGN_IN)
    : new ToolError(`Anthropic Messages returned HTTP ${response.status}${detail}`);
  if (shouldRetry(response)) throw new RetryableAnthropicError(failure, retryDelay(response));
  throw failure;
}

function completeMessage(body: string, token: string, sessionId: string, signal: AbortSignal) {
  return withRetries(signal, async (attempt) => readMessage(await postMessage(body, token, sessionId, attempt, signal), token, signal));
}

export function anthropicAskAdapter(configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude")): AskAdapter {
  const credentialsPath = path.join(configDir, ".credentials.json");
  const sessionId = randomUUID();
  const localDeviceId = deviceId();
  let profile: { token: string; uuid: Promise<string> } | undefined;
  let refreshPromise: Promise<void> | undefined;
  const deadRefreshTokens = new Set<string>();
  const accountUuidFor = (token: string, signal: AbortSignal) => {
    if (profile?.token !== token) {
      const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
      const uuid = withRetries(timeout, () => readAccountUuid(token, timeout)).catch((error: unknown) => {
        if (timeout.aborted) throw new ToolError(`The Claude account profile did not answer within ${REFRESH_TIMEOUT_MS / 1000} s.`);
        throw error;
      });
      const entry = { token, uuid };
      profile = entry;
      uuid.catch(() => {
        if (profile === entry) profile = undefined;
      });
    }
    return untilAborted(profile.uuid, signal, () => signal.reason as Error);
  };
  const refreshSession = async (signal: AbortSignal, rejectedToken?: string) => {
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    refreshPromise ??= refreshCredentialsFile(credentialsPath, timeout, deadRefreshTokens, rejectedToken)
      .catch((error: unknown) => {
        if (timeout.aborted) throw new ToolError(`Claude session refresh did not answer within ${REFRESH_TIMEOUT_MS / 1000} s.`);
        throw error;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    await untilAborted(refreshPromise, signal, () => signal.reason as Error);
    return readCredentials(credentialsPath, signal);
  };
  return {
    name: "Anthropic Claude account",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      const send = async (credentials: Awaited<ReturnType<typeof readCredentials>>) => {
        const accountUuid = credentials.accountUuid ?? await accountUuidFor(credentials.accessToken, signal);
        const body = JSON.stringify({
          model: modelId(model),
          max_tokens: maxTokens,
          stream: true,
          system: [
            { type: "text", text: billingHeader(firstText(prompt, images)) },
            { type: "text", text: CLAUDE_CODE_IDENTITY },
            { type: "text", text: system },
          ],
          messages: [{ role: "user", content: messageContent(prompt, images) }],
          metadata: {
            user_id: JSON.stringify({ device_id: localDeviceId, account_uuid: accountUuid, session_id: sessionId }),
          },
        });
        return completeMessage(body, credentials.accessToken, sessionId, signal);
      };

      let credentials = await readCredentials(credentialsPath, signal);
      if (isExpiring(credentials)) {
        const current = credentials;
        credentials = await refreshSession(signal).catch((error: unknown) => {
          if (signal.aborted || !isUsable(current)) throw error;
          return current;
        });
      }
      try {
        return await send(credentials);
      } catch (error) {
        if (!(error instanceof RejectedSessionError) || !credentials.refreshToken) throw error;
        const refreshed = await refreshSession(signal, credentials.accessToken);
        if (refreshed.accessToken === credentials.accessToken) throw error;
        return send(refreshed);
      }
    },
  };
}
