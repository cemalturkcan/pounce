import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type AskAdapter, modelId } from "../adapter.ts";
import { untilAborted } from "../../shared/async.ts";
import { errorFrom, ToolError } from "../../shared/errors.ts";
import { readAccountUuid, readGlobalAccountUuid } from "./account.ts";
import {
  isExpiring,
  isUsable,
  readCredentials,
  refreshCredentialsFile,
  REFRESH_TIMEOUT_MS,
} from "./credentials.ts";
import {
  errorDetail,
  networkErrorDetail,
  RejectedSessionError,
  rejectsSession,
  RetryableAnthropicError,
  SIGN_IN,
} from "./errors.ts";
import { API_ORIGIN, claudeCodeHeaders, deviceId } from "./identity.ts";
import {
  conversationMessages,
  EPHEMERAL,
  firstText,
  type MessagesRequest,
  messageContent,
  systemBlocks,
} from "./messages.ts";
import { retryDelay, shouldRetry, withRetries } from "./retry.ts";
import { apiErrorSchema } from "./schemas.ts";
import { conversationReader, readStream, type StreamReader, textReader } from "./stream.ts";

const MESSAGES_URL = `${API_ORIGIN}/v1/messages?beta=true`;

const errorPayloadSchema = z.object({ error: apiErrorSchema.optional().catch(undefined) });

async function postMessage(
  body: string,
  token: string,
  sessionId: string,
  retryCount: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const response = await fetch(MESSAGES_URL, {
    method: "POST",
    redirect: "error",
    headers: claudeCodeHeaders(token, sessionId, retryCount),
    body,
    signal,
  }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(
      `Network error while sending the Anthropic Messages request${networkErrorDetail(cause, token)}`,
    );
  });
  if (response.ok) return response;

  const payload = errorPayloadSchema.safeParse(await response.json().catch(() => undefined)).data;
  signal.throwIfAborted();
  const detail = errorDetail(payload?.error, token);
  const failure = rejectsSession(response.status, payload?.error)
    ? new RejectedSessionError(
        `Anthropic rejected the local Claude Code session (HTTP ${response.status})${detail}`,
        SIGN_IN,
      )
    : new ToolError(`Anthropic Messages returned HTTP ${response.status}${detail}`);
  if (shouldRetry(response)) throw new RetryableAnthropicError(failure, retryDelay(response));
  throw failure;
}

const inFlightRefreshes = new Set<Promise<unknown>>();

export async function settleClaudeRefreshes(): Promise<void> {
  if (!inFlightRefreshes.size) return;
  await Promise.allSettled(inFlightRefreshes);
  return settleClaudeRefreshes();
}

export function anthropicAskAdapter(
  configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"),
): AskAdapter {
  const credentialsPath = path.join(configDir, ".credentials.json");
  const globalConfigDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || configDir !== path.join(homedir(), ".claude")
      ? configDir
      : homedir();
  const globalConfigPaths = [
    path.join(configDir, ".config.json"),
    path.join(globalConfigDir, ".claude.json"),
  ];
  const sessionId = randomUUID();
  const localDeviceId = deviceId();
  let profile: { token: string; uuid: Promise<string> } | undefined;
  let refreshPromise: Promise<void> | undefined;
  let refreshRejectedToken: string | undefined;
  const deadRefreshTokens = new Set<string>();
  const accountUuidFor = (token: string, signal: AbortSignal) => {
    if (profile?.token !== token) {
      const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
      const uuid = withRetries(timeout, () => readAccountUuid(token, timeout)).catch(
        (cause: unknown) => {
          if (timeout.aborted)
            throw new ToolError(
              `The Claude account profile did not answer within ${REFRESH_TIMEOUT_MS / 1000} s.`,
            );
          throw cause;
        },
      );
      const entry = { token, uuid };
      profile = entry;
      uuid.catch(() => {
        if (profile === entry) profile = undefined;
      });
    }
    return untilAborted(profile.uuid, signal, () => errorFrom(signal.reason));
  };
  const refreshSession = async (
    signal: AbortSignal,
    rejectedToken?: string,
  ): Promise<Awaited<ReturnType<typeof readCredentials>>> => {
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    const joinedOther = refreshPromise !== undefined && refreshRejectedToken !== rejectedToken;
    if (!refreshPromise) refreshRejectedToken = rejectedToken;
    refreshPromise ??= refreshCredentialsFile(
      credentialsPath,
      timeout,
      deadRefreshTokens,
      rejectedToken,
    )
      .catch((cause: unknown) => {
        if (timeout.aborted)
          throw new ToolError(
            `Claude session refresh did not answer within ${REFRESH_TIMEOUT_MS / 1000} s.`,
          );
        throw cause;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    const tracked = refreshPromise
      .catch(() => undefined)
      .finally(() => inFlightRefreshes.delete(tracked));
    inFlightRefreshes.add(tracked);
    await untilAborted(refreshPromise, signal, () => errorFrom(signal.reason));
    const credentials = await readCredentials(credentialsPath, signal);
    if (joinedOther && rejectedToken !== undefined && credentials.accessToken === rejectedToken)
      return refreshSession(signal, rejectedToken);
    return credentials;
  };
  const call = async <T>(signal: AbortSignal, request: MessagesRequest, reply: StreamReader<T>) => {
    const send = async (credentials: Awaited<ReturnType<typeof readCredentials>>) => {
      const accountUuid =
        credentials.accountUuid ??
        (await readGlobalAccountUuid(globalConfigPaths)) ??
        (await accountUuidFor(credentials.accessToken, signal));
      const body = JSON.stringify({
        ...request,
        metadata: {
          user_id: JSON.stringify({
            device_id: localDeviceId,
            account_uuid: accountUuid,
            session_id: sessionId,
          }),
        },
      });
      const token = credentials.accessToken;
      return withRetries(signal, async (attempt) =>
        readStream(
          await postMessage(body, token, sessionId, attempt, signal),
          token,
          signal,
          reply,
        ),
      );
    };

    let credentials = await readCredentials(credentialsPath, signal);
    if (isExpiring(credentials)) {
      const current = credentials;
      credentials = await refreshSession(signal).catch((cause: unknown) => {
        if (signal.aborted || !isUsable(current)) throw cause;
        return current;
      });
    }
    try {
      return await send(credentials);
    } catch (cause) {
      if (!(cause instanceof RejectedSessionError) || !credentials.refreshToken) throw cause;
      const refreshed = await refreshSession(signal, credentials.accessToken);
      if (refreshed.accessToken === credentials.accessToken) throw cause;
      return send(refreshed);
    }
  };
  return {
    name: "Anthropic Claude account",
    async complete({ system, prompt, model, maxTokens, images, signal }) {
      const content = messageContent(prompt, images);
      return call(
        signal,
        {
          model: modelId(model),
          max_tokens: maxTokens,
          stream: true,
          system: systemBlocks(firstText(content), system),
          messages: [{ role: "user", content }],
        },
        textReader,
      );
    },
    async converse({ system, tools, messages, model, maxTokens, signal }) {
      const serialized = conversationMessages(messages);
      return call(
        signal,
        {
          model: modelId(model),
          max_tokens: maxTokens,
          stream: true,
          system: systemBlocks(firstText(serialized[0]?.content), system, EPHEMERAL),
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
          messages: serialized,
        },
        conversationReader,
      );
    },
  };
}
