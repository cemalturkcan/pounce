import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";

export const API_ORIGIN = "https://api.anthropic.com";

const ANTHROPIC_VERSION = "2023-06-01";
const CLAUDE_CODE_VERSION = "2.1.329";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";
export const CLAUDE_CODE_USER_AGENT = `claude-cli/${CLAUDE_CODE_VERSION} (external, ${CLAUDE_CODE_ENTRYPOINT})`;
export const CLAUDE_CODE_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
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

const ARCHITECTURES = new Map([
  ["x64", "x64"],
  ["arm64", "arm64"],
  ["ia32", "ia32"],
  ["arm", "arm"],
]);
const PLATFORMS = new Map([
  ["linux", "Linux"],
  ["darwin", "MacOS"],
  ["win32", "Windows"],
]);

export function billingHeader(messageText: string) {
  const sampled = [4, 7, 20].map((position) => messageText[position] ?? "0").join("");
  const suffix = createHash("sha256")
    .update(BILLING_FINGERPRINT_SALT + sampled + CLAUDE_CODE_VERSION)
    .digest("hex")
    .slice(0, 3);
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=${CLAUDE_CODE_ENTRYPOINT};`;
}

export function deviceId() {
  let username = process.env.USER ?? "";
  try {
    username = userInfo().username;
  } catch {}
  return createHash("sha256").update(`${hostname()}:${username}`).digest("hex");
}

export function claudeCodeHeaders(token: string, sessionId: string, retryCount: number) {
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
    "x-stainless-arch": ARCHITECTURES.get(process.arch) ?? process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os": PLATFORMS.get(process.platform) ?? `Other:${process.platform}`,
    "x-stainless-package-version": "0.128.0",
    "x-stainless-retry-count": String(retryCount),
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v26.3.0",
    "x-stainless-timeout": "600",
  };
}
