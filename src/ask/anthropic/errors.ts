import { z } from "zod";
import { AskSetupError } from "../errors.ts";
import { ToolError } from "../../shared/errors.ts";
import { type ApiError, optionalString } from "./schemas.ts";

export const SIGN_IN = "Sign in to Claude Code with `claude auth login`, then try again.";

const errorCodeField = z.object({ code: z.string() });
const networkCause = z.object({ code: optionalString, message: optionalString });

export class RejectedSessionError extends AskSetupError {}

export class RetryableAnthropicError extends ToolError {
  readonly failure: ToolError;
  readonly retryAfterMs?: number;

  constructor(failure: string | ToolError, retryAfterMs?: number) {
    super(failure instanceof ToolError ? failure.message : failure);
    this.failure = failure instanceof ToolError ? failure : new ToolError(failure);
    this.retryAfterMs = retryAfterMs;
  }

  waitedTooLong(waitMs: number): ToolError {
    const message = `${this.failure.message} Retry-After (${waitMs / 1000} s) exceeds the 60-second wait limit.`;
    return this.failure instanceof RejectedSessionError
      ? new RejectedSessionError(message, this.failure.hint)
      : new ToolError(message, this.failure.hint);
  }
}

function redact(value: string, secrets: string | string[]) {
  return [secrets]
    .flat()
    .filter(Boolean)
    .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
}

export function errorDetail(error: ApiError | undefined, secrets: string | string[]) {
  const detail = [error?.type, error?.message]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .map((value) => redact(value, secrets).replace(/\s+/g, " ").trim())
    .join(": ")
    .slice(0, 500);
  return detail ? `: ${detail}` : ".";
}

export function networkErrorDetail(cause: unknown, token: string | string[]) {
  const reason = cause instanceof Error ? (cause.cause ?? cause) : cause;
  const detail = reason instanceof AggregateError ? (reason.errors[0] ?? reason) : reason;
  const coded = networkCause.safeParse(detail);
  if (coded.success)
    return errorDetail({ type: coded.data.code, message: coded.data.message }, token);
  return errorDetail({ message: optionalString.parse(detail) }, token);
}

export function errorCode(cause: unknown) {
  return cause instanceof Error ? errorCodeField.safeParse(cause).data?.code : undefined;
}

export function rejectsSession(status: number, error: ApiError | undefined) {
  return (
    status === 401 ||
    (status === 403 && error?.message?.includes("OAuth token has been revoked") === true)
  );
}
