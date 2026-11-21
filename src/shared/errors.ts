import { stripVTControlCharacters } from "node:util";
import { z } from "zod";

const CALL_LOG_LINES = 8;

export function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

export function messageOf(cause: unknown) {
  return errorFrom(cause).message;
}

export class ToolError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

export const cancelled = () => new ToolError("The call was cancelled by the client.");

type Rule = { pattern: RegExp; hint: (raw: string) => string };

const RESOLVED = /locator resolved to (<.+?>)\s*$/gm;
const INTERCEPTED = /- (<.+?>)(?: from (<.+?>) subtree)? intercepts pointer events/g;

function interceptHint(raw: string) {
  const last = [...raw.matchAll(INTERCEPTED)].at(-1);
  const covering = last?.[1];
  if (!covering)
    return "Another element covers the target (overlay, cookie banner, modal). Run dismiss_overlays, or click the covering element first.";
  const root = last[2];
  const named = root ? `${covering} inside ${root}` : covering;
  const label = [covering, root].find((element) => element?.startsWith("<label"));
  const labelFor = label ? /\bfor="([^"]*)"/.exec(label)?.[1] : undefined;
  const target = [...raw.matchAll(RESOLVED)].at(-1)?.[1] ?? "";
  const targetId = /\bid="([^"]*)"/.exec(target)?.[1];
  const otherLabel = labelFor !== undefined && targetId !== undefined && labelFor !== targetId;
  if (label && !otherLabel)
    return `Its label covers the target: ${named}. Click that label instead (find it by its text); clicking a label toggles the control it belongs to.`;
  const what = otherLabel ? "Another control's label" : "Another element";
  return `${what} covers the target: ${named}. Run dismiss_overlays when it is an overlay, cookie banner or modal, or click the covering element first.`;
}

const RULES: Rule[] = [
  {
    pattern:
      /Target page, context or browser has been closed|Target closed|has been closed|Browser closed/i,
    hint: () =>
      "The tab or the browser was closed. Call tabs_list to see what is open, or tab_open for a new tab; the browser relaunches on demand.",
  },
  {
    pattern: /strict mode violation/i,
    hint: () =>
      "The selector matched several elements. Use a ref from snapshot, or a more specific selector.",
  },
  {
    pattern: /intercepts pointer events/i,
    hint: interceptHint,
  },
  {
    pattern: /element is not (visible|enabled|editable|stable)|not attached/i,
    hint: () =>
      "The element exists but is not actionable yet. Check the page with snapshot; it may be hidden, disabled, or still animating.",
  },
  {
    pattern: /Timeout \d+ms exceeded/i,
    hint: () =>
      "Nothing matched or the page did not react in time. Take a snapshot to see the current page before retrying.",
  },
  {
    pattern: /net::ERR_INVALID_AUTH_CREDENTIALS/i,
    hint: () =>
      "The site asks for HTTP authentication (the browser's own login dialog). Use http_auth with a password-store entry for this origin, then navigate again.",
  },
  {
    pattern: /net::ERR_|NS_ERROR_/i,
    hint: () =>
      "The navigation failed at the network level. Check the URL and network_requests for the failing request.",
  },
  {
    pattern:
      /ProcessSingleton|SingletonLock|profile appears to be in use|user data directory is already in use/i,
    hint: () =>
      "Another Chrome process already uses the agent profile directory. Close that Chrome or stop the other web-agent instance.",
  },
];

export function describeError(cause: unknown) {
  if (cause instanceof ToolError) {
    return cause.hint ? `${cause.message}\n${cause.hint}` : cause.message;
  }
  if (cause instanceof z.ZodError) {
    const [first] = cause.issues;
    const summary = first
      ? `${first.message}${first.path.length ? ` at ${z.core.toDotPath(first.path)}` : ""}`
      : "";
    return `The data does not have the expected form: ${summary}\n${z.prettifyError(cause)}`;
  }

  const raw = stripVTControlCharacters(messageOf(cause));
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const logStart = lines.findIndex((line) => /^Call log:/i.test(line.trim()));
  const head = (logStart === -1 ? lines : lines.slice(0, logStart)).filter(Boolean).join("\n");
  const callLog =
    logStart === -1
      ? []
      : lines
          .slice(logStart + 1)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-CALL_LOG_LINES);
  const rule = RULES.find((candidate) => candidate.pattern.test(raw));
  const hint = rule?.hint(raw);

  return [
    head,
    callLog.length ? `Call log (last ${callLog.length}):\n${callLog.join("\n")}` : "",
    hint ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}
