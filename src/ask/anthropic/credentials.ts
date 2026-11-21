import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AskSetupError } from "../errors.ts";
import { logEvent } from "../../log/logger.ts";
import { repeatUntil } from "../../shared/async.ts";
import { parseJson } from "../../shared/decode.ts";
import { messageOf, ToolError } from "../../shared/errors.ts";
import {
  errorCode,
  errorDetail,
  networkErrorDetail,
  RetryableAnthropicError,
  SIGN_IN,
} from "./errors.ts";
import { CLAUDE_CODE_USER_AGENT } from "./identity.ts";
import {
  acquireLock,
  proceedWithoutLock,
  REFRESH_RACE_POLL_MS,
  withRefreshLocks,
} from "./locks.ts";
import { retryDelay, shouldRetry, withRetries } from "./retry.ts";
import { blockType, filledString, optionalNumber, optionalString } from "./schemas.ts";

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
];

const REFRESH_WINDOW_MS = 5 * 60_000;
export const REFRESH_TIMEOUT_MS = 30_000;
const REFRESH_RACE_WAIT_MS = 2_000;
const STORAGE_LOCK_STALE_MS = 15_000;
const SAVE_ATTEMPTS = 3;
const IN_PLACE_SAVE_CODES = new Set(["EACCES", "EPERM", "EROFS", "EBUSY", "EXDEV"]);

const credentialsDocumentSchema = z.looseObject({});
const storedOauthSchema = z.looseObject({});
const oauthTokensSchema = z.object({
  accessToken: optionalString,
  refreshToken: optionalString,
  clientId: filledString,
  scopes: z
    .array(filledString)
    .transform((scopes) => scopes.filter((scope): scope is string => scope !== undefined))
    .catch([]),
  expiresAt: optionalNumber,
});
const credentialsSchema = z.object({
  claudeAiOauth: oauthTokensSchema.optional().catch(undefined),
  accountUuid: optionalString,
});

const tokenResponseSchema = z.object({
  access_token: optionalString,
  refresh_token: optionalString,
  expires_in: optionalNumber,
  scope: optionalString,
  error: z
    .union([z.string(), blockType.transform((error) => error.type)])
    .optional()
    .catch(undefined),
  error_description: optionalString,
});
type TokenResponse = z.infer<typeof tokenResponseSchema>;

async function readCredentialsDocument(credentialsPath: string, signal?: AbortSignal) {
  const text = await readFile(credentialsPath, { encoding: "utf8", signal }).catch(
    (cause: unknown) => {
      signal?.throwIfAborted();
      const code = errorCode(cause);
      if (code !== "ENOENT")
        throw new ToolError(
          `Could not read Claude Code credentials at ${credentialsPath} (${code ?? "unknown error"}).`,
        );
      return "";
    },
  );
  const document = parseJson(text, credentialsDocumentSchema);
  if (!document.success) {
    throw new AskSetupError(
      `Could not read Claude Code credentials at ${credentialsPath}.`,
      SIGN_IN,
    );
  }
  return document.data;
}

export async function readCredentials(credentialsPath: string, signal: AbortSignal) {
  const document = await readCredentialsDocument(credentialsPath, signal);
  const credentials = credentialsSchema.parse(document);
  const oauth = credentials.claudeAiOauth;
  if (!oauth?.accessToken?.trim()) {
    throw new AskSetupError(
      `Claude Code credentials at ${credentialsPath} lack a Claude account access token.`,
      SIGN_IN,
    );
  }
  return {
    document,
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    clientId: oauth.clientId ?? OAUTH_CLIENT_ID,
    scopes: oauth.scopes,
    expiresAt: oauth.expiresAt,
    accountUuid: credentials.accountUuid,
  };
}

async function requestTokenRefresh(
  tokens: { accessToken: string; refreshToken: string; clientId: string },
  scope: string | undefined,
  signal: AbortSignal,
) {
  const secrets = [tokens.accessToken, tokens.refreshToken];
  const grant = {
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: tokens.clientId,
  };
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", "user-agent": CLAUDE_CODE_USER_AGENT },
    body: JSON.stringify(scope ? { ...grant, scope } : grant),
    signal,
  }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(
      `Could not refresh the local Claude session${networkErrorDetail(cause, secrets)}`,
    );
  });
  const payload = tokenResponseSchema.safeParse(await response.json().catch(() => undefined)).data;
  if (!response.ok) {
    if (shouldRetry(response)) {
      throw new RetryableAnthropicError(
        new ToolError(refreshFailure(response.status, payload, secrets)),
        retryDelay(response),
      );
    }
    return { response, payload };
  }
  if (!payload?.access_token) {
    throw new AskSetupError("Claude session refresh returned no access token.", SIGN_IN);
  }
  return { response, payload };
}

function refreshFailure(status: number, payload: TokenResponse | undefined, secrets: string[]) {
  const detail = errorDetail(
    { type: payload?.error, message: payload?.error_description },
    secrets,
  );
  return `Claude session refresh failed (HTTP ${status})${detail}`;
}

export function isExpiring(credentials: { expiresAt?: number }) {
  return (
    credentials.expiresAt !== undefined && credentials.expiresAt <= Date.now() + REFRESH_WINDOW_MS
  );
}

export function isUsable(credentials: { expiresAt?: number }) {
  return credentials.expiresAt === undefined || credentials.expiresAt > Date.now();
}

async function waitForNewerCredentials(
  credentialsPath: string,
  staleToken: string,
  signal: AbortSignal,
) {
  const deadline = Date.now() + REFRESH_RACE_WAIT_MS;
  return repeatUntil(
    async () => {
      const latest = await readCredentials(credentialsPath, signal);
      if (latest.accessToken !== staleToken && !isExpiring(latest)) return true;
      if (Date.now() >= deadline) return false;
      return undefined;
    },
    { delayMs: () => REFRESH_RACE_POLL_MS, signal },
  );
}

async function saveRefreshedTokens(
  credentialsPath: string,
  stale: { accessToken: string; refreshToken: string },
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] },
) {
  const releaseLock = await acquireLock(
    path.join(path.dirname(credentialsPath), ".storage-write.lock"),
    AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    STORAGE_LOCK_STALE_MS,
  ).catch(proceedWithoutLock);
  try {
    await writeRefreshedTokens(credentialsPath, stale, tokens);
  } finally {
    await releaseLock();
  }
}

async function writeRefreshedTokens(
  credentialsPath: string,
  stale: { accessToken: string; refreshToken: string },
  tokens: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] },
) {
  const document = await readCredentialsDocument(credentialsPath);
  const oauth = storedOauthSchema.safeParse(document.claudeAiOauth);
  if (!oauth.success) return;
  const stored = oauthTokensSchema.parse(oauth.data);
  const blank = !stored.accessToken?.trim();
  if (
    !blank &&
    (stored.accessToken !== stale.accessToken || stored.refreshToken !== stale.refreshToken)
  )
    return;
  const target = await realpath(credentialsPath).catch(() => credentialsPath);
  const content = JSON.stringify(
    { ...document, claudeAiOauth: { ...oauth.data, ...tokens } },
    null,
    2,
  );
  const saved = await repeatUntil(
    () =>
      replaceFile(target, content).then(
        () => true,
        () => undefined,
      ),
    { delayMs: () => REFRESH_RACE_POLL_MS, giveUp: (made) => made >= SAVE_ATTEMPTS - 1 },
  );
  if (saved) return;
  try {
    await replaceFile(target, content).catch((cause: unknown) => {
      if (!IN_PLACE_SAVE_CODES.has(errorCode(cause) ?? "")) throw cause;
      return overwriteFile(target, content);
    });
  } catch (cause) {
    const reason = errorCode(cause) ?? messageOf(cause);
    logEvent("claude_session_save_failed", { path: target, error: reason }, "warn");
    throw new ToolError(
      `Could not save the refreshed Claude session to ${target} (${reason}).`,
      SIGN_IN,
    );
  }
}

async function overwriteFile(target: string, content: string) {
  const previous = await readFile(target, "utf8");
  try {
    await writeFile(target, content);
  } catch (cause) {
    await writeFile(target, previous).catch(() => undefined);
    throw cause;
  }
}

async function replaceFile(target: string, content: string) {
  const temporaryPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await rename(temporaryPath, target);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function refreshCredentialsFile(
  credentialsPath: string,
  signal: AbortSignal,
  deadRefreshTokens: Set<string>,
  rejectedToken?: string,
) {
  return withRefreshLocks(credentialsPath, signal, async () => {
    const credentials = await readCredentials(credentialsPath, signal);
    if (
      rejectedToken === undefined
        ? !isExpiring(credentials)
        : credentials.accessToken !== rejectedToken
    )
      return;
    if (!credentials.refreshToken)
      throw new AskSetupError(
        "The local Claude Code session expired without a refresh token.",
        SIGN_IN,
      );
    if (deadRefreshTokens.has(credentials.refreshToken))
      throw new AskSetupError("The local Claude Code session can no longer be refreshed.", SIGN_IN);

    const tokens = {
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
    };
    const refresh = (scope: string | undefined) =>
      withRetries(signal, () => requestTokenRefresh(tokens, scope, signal));
    const storedScopes = credentials.scopes.length ? credentials.scopes.join(" ") : undefined;
    let answer = await refresh([...new Set([...OAUTH_SCOPES, ...credentials.scopes])].join(" "));
    if (!answer.response.ok && answer.payload?.error === "invalid_scope")
      answer = await refresh(storedScopes);
    if (!answer.response.ok) {
      const failure = refreshFailure(answer.response.status, answer.payload, [
        tokens.accessToken,
        tokens.refreshToken,
      ]);
      if (answer.payload?.error !== "invalid_grant") throw new ToolError(failure);
      if (await waitForNewerCredentials(credentialsPath, credentials.accessToken, signal)) return;
      deadRefreshTokens.add(tokens.refreshToken);
      throw new AskSetupError(failure, SIGN_IN);
    }

    const expiresIn = answer.payload?.expires_in ?? 3_600;
    const refreshed = {
      accessToken: String(answer.payload?.access_token),
      refreshToken: answer.payload?.refresh_token || tokens.refreshToken,
      expiresAt: Date.now() + Math.min(Math.max(expiresIn, 60), 86_400) * 1_000,
    };
    const scope = answer.payload?.scope?.trim();
    await saveRefreshedTokens(
      credentialsPath,
      tokens,
      scope ? { ...refreshed, scopes: scope.split(/\s+/) } : refreshed,
    );
  });
}
