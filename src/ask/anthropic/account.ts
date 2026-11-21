import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AskSetupError } from "../errors.ts";
import { parseJson } from "../../shared/decode.ts";
import { ToolError } from "../../shared/errors.ts";
import {
  errorDetail,
  networkErrorDetail,
  RejectedSessionError,
  rejectsSession,
  RetryableAnthropicError,
  SIGN_IN,
} from "./errors.ts";
import { API_ORIGIN, CLAUDE_CODE_USER_AGENT } from "./identity.ts";
import { retryDelay, shouldRetry } from "./retry.ts";
import { apiErrorSchema, optionalString } from "./schemas.ts";

const PROFILE_URL = `${API_ORIGIN}/api/oauth/profile`;

const profileSchema = z.object({
  account: z.object({ uuid: optionalString }).optional().catch(undefined),
  error: apiErrorSchema.optional().catch(undefined),
});

const globalConfigSchema = z.object({
  oauthAccount: z.object({ accountUuid: z.string().min(1) }),
});

export async function readAccountUuid(token: string, signal: AbortSignal) {
  const response = await fetch(PROFILE_URL, {
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": CLAUDE_CODE_USER_AGENT,
    },
    signal,
  }).catch((cause: unknown) => {
    signal.throwIfAborted();
    throw new RetryableAnthropicError(
      `Could not read the local Claude account profile${networkErrorDetail(cause, token)}`,
    );
  });
  const payload = profileSchema.safeParse(await response.json().catch(() => undefined)).data;
  signal.throwIfAborted();
  const uuid = payload?.account?.uuid;
  if (response.ok && uuid) return uuid;
  const message = `Could not read the local Claude account profile (HTTP ${response.status})${errorDetail(payload?.error, token)}`;
  if (rejectsSession(response.status, payload?.error))
    throw new RejectedSessionError(message, SIGN_IN);
  if (shouldRetry(response))
    throw new RetryableAnthropicError(new ToolError(message), retryDelay(response));
  throw new AskSetupError(message, SIGN_IN);
}

export async function readGlobalAccountUuid(
  configPaths: string[],
  index = 0,
): Promise<string | undefined> {
  const configPath = configPaths[index];
  if (configPath === undefined) return undefined;
  const uuid = await readFile(configPath, "utf8").then(
    (text) => parseJson(text, globalConfigSchema).data?.oauthAccount.accountUuid,
    () => undefined,
  );
  return uuid ?? readGlobalAccountUuid(configPaths, index + 1);
}
