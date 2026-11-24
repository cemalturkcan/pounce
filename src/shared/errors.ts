import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { shownUrl, type StructuredFields } from "./output.ts";

const CALL_LOG_LINES = 8;
const NAVIGATION_FAILURE =
  /^(?:\w+\.)?(?:goto|reload|goBack|goForward): ((?:net::ERR|NS_ERROR)_[A-Z_]+) at (\S+)/;

export function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause), { cause });
}

export function messageOf(cause: unknown) {
  return errorFrom(cause).message;
}

export class ToolError extends Error {
  readonly hint?: string;
  readonly data?: StructuredFields;

  constructor(message: string, hint?: string, data?: StructuredFields, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolError";
    this.hint = hint;
    this.data = data;
  }
}

export class CoveredByOwnLabel extends Error {
  readonly label: string;

  constructor(cause: Error, label: string) {
    super(cause.message, { cause });
    this.name = cause.name;
    this.label = label;
  }
}

export const cancelled = () => new ToolError("The call was cancelled by the client.");

type Rule = { pattern: RegExp; hint: (raw: string, ownLabel?: string) => string };

const RESOLVED = /locator resolved to (<.+?>)\s*$/gm;
const INTERCEPTED = /- (<.+?>)(?: from (<.+?>) subtree)? intercepts pointer events/g;

const labelHint = (named: string) =>
  `Its label covers the target: ${named}. Click that label instead (snapshot with query finds it by its text); clicking a label toggles the control it belongs to.`;

const lastIntercept = (raw: string) => [...raw.matchAll(INTERCEPTED)].at(-1);

export const interceptingElement = (raw: string) => lastIntercept(raw)?.[1];

function interceptHint(raw: string, ownLabel?: string) {
  const last = lastIntercept(raw);
  const covering = last?.[1];
  if (!covering)
    return "Another element covers the target (overlay, cookie banner, modal). Run dismiss_overlays, or click the covering element first.";
  const root = last[2];
  const named = root ? `${covering} inside ${root}` : covering;
  const label = [covering, root].find((element) => element?.startsWith("<label"));
  if (ownLabel && !label) return labelHint(`${covering} inside ${ownLabel}`);
  const labelFor = label ? /\bfor="([^"]*)"/.exec(label)?.[1] : undefined;
  const target = [...raw.matchAll(RESOLVED)].at(-1)?.[1] ?? "";
  const targetId = /\bid="([^"]*)"/.exec(target)?.[1];
  const otherLabel = labelFor !== undefined && targetId !== undefined && labelFor !== targetId;
  if (label && !otherLabel) return labelHint(named);
  const what = otherLabel ? "Another control's label" : "Another element";
  return `${what} covers the target: ${named}. Run dismiss_overlays when it is an overlay, cookie banner or modal, or click the covering element first.`;
}

const TARGET_CLOSED =
  /Target page, context or browser has been closed|Target closed|has been closed|Browser closed/i;
const INPUT_SENT = /^\s*- +(?:performing \w+(?: \w+)* action|elementHandle\.(?:press|type)\()/m;

export const CLOSED_HINT =
  "The tab or the browser was closed. Call tabs to see what is open, or navigate without tab for a new tab; the browser relaunches on demand.";

export const closedTarget = (cause: unknown) =>
  TARGET_CLOSED.test(stripVTControlCharacters(messageOf(cause)));

export function closedAfterInput(cause: unknown) {
  const raw = stripVTControlCharacters(messageOf(cause));
  return TARGET_CLOSED.test(raw) && INPUT_SENT.test(raw);
}

const RULES: Rule[] = [
  {
    pattern: TARGET_CLOSED,
    hint: () => CLOSED_HINT,
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
      "The site asks for HTTP authentication (the browser's own login dialog). Use site with http_auth and a password-store entry for this origin, then navigate again.",
  },
  {
    pattern: /net::ERR_HTTP_RESPONSE_CODE_FAILURE/i,
    hint: () =>
      "The server answered with an HTTP error status and an empty body; this is not a network failure. network shows the status.",
  },
  {
    pattern: /net::ERR_NAME_NOT_RESOLVED/,
    hint: () =>
      "The host name does not resolve: check the URL for a typo, or whether the site exists.",
  },
  {
    pattern: /net::ERR_|NS_ERROR_/i,
    hint: () =>
      "The navigation failed at the network level. Check the URL, and network for the failing request.",
  },
  {
    pattern:
      /ProcessSingleton|SingletonLock|profile appears to be in use|user data directory is already in use/i,
    hint: () =>
      "Another Chrome process already uses the agent profile directory. Close that Chrome or stop the other pounce instance.",
  },
];

const TIMEOUT_MS = /Timeout (\d+(?:\.\d+)?)ms exceeded/;

export function timedOutWithin(cause: unknown, ms: number) {
  const error = errorFrom(cause);
  error.message = error.message.replace(TIMEOUT_MS, `Timeout ${ms}ms exceeded`);
  return error;
}
const WAITING_FOR_LOCATOR = /^- waiting for ((?:locator|getBy\w+|frameLocator)\(.*)$/;

const LOCATOR_CHAIN =
  /^locator\('(?:[^'\\]|\\.)*'\)(?:(?:\.contentFrame\(\))?\.locator\('(?:[^'\\]|\\.)*'\))*$/;
const CHAIN_PART = /\.contentFrame\(\)|locator\('((?:[^'\\]|\\.)*)'\)/g;

function readableSelector(locator: string) {
  if (!LOCATOR_CHAIN.test(locator)) return locator;
  return [...locator.matchAll(CHAIN_PART)]
    .map((part) => part[1]?.replace(/\\(.)/g, "$1") ?? "internal:control=enter-frame")
    .join(" >> ");
}

const STRICT_VIOLATION =
  /strict mode violation: (.+) resolved to (\d+) elements:\n((?:\s+\d+\) .*\n?)+)/;

function strictSentence(raw: string, selectors: ReadonlyMap<string, string> | undefined) {
  const violation = STRICT_VIOLATION.exec(raw);
  if (!violation) return undefined;
  const locator = violation[1] ?? "";
  const selector = selectors?.get(locator) ?? readableSelector(locator);
  const matched = (violation[3] ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/ aka .*$/, ""))
    .filter(Boolean);
  return `The target ${selector} matched ${violation[2]} elements, but the call acts on exactly one.\n${matched.join("\n")}`;
}

function unmatchedSentence(
  raw: string,
  lastLogLine: string | undefined,
  selectors: ReadonlyMap<string, string> | undefined,
) {
  const timeout = TIMEOUT_MS.exec(raw);
  const waiting = WAITING_FOR_LOCATOR.exec(lastLogLine ?? "");
  if (!timeout || !waiting) return undefined;
  const locator = waiting[1] ?? "";
  const selector = selectors?.get(locator) ?? readableSelector(locator);
  return {
    text: `Nothing matched ${selector} within ${Math.round(Number(timeout[1])) / 1000} s.`,
    hint: "Take a snapshot to see the current page, then retry with a ref or selector from it.",
  };
}

type Described = { text: string; hint?: string };

export function describeError(cause: unknown, selectors?: ReadonlyMap<string, string>) {
  const { text, hint } = describedParts(cause, selectors);
  return [text, hint ?? ""].filter(Boolean).join("\n");
}

function describedParts(cause: unknown, selectors?: ReadonlyMap<string, string>): Described {
  if (cause instanceof ToolError) return { text: cause.message, hint: cause.hint };
  if (cause instanceof z.ZodError) {
    const [first] = cause.issues;
    const summary = first
      ? `${first.message}${first.path.length ? ` at ${z.core.toDotPath(first.path)}` : ""}`
      : "";
    return {
      text: `The data does not have the expected form: ${summary}\n${z.prettifyError(cause)}`,
    };
  }

  const raw = stripVTControlCharacters(messageOf(cause));
  const rule = RULES.find((candidate) => candidate.pattern.test(raw));
  const hint = rule?.hint(raw, cause instanceof CoveredByOwnLabel ? cause.label : undefined);
  const navigation = NAVIGATION_FAILURE.exec(raw);
  if (navigation)
    return { text: `Could not load ${shownUrl(navigation[2] ?? "")} (${navigation[1]}).`, hint };
  const { head, fullLog } = callLogParts(raw);
  const unmatched = unmatchedSentence(raw, fullLog.at(-1), selectors);
  if (unmatched) return unmatched;
  const strict = strictSentence(raw, selectors);
  if (strict) return { text: strict, hint };
  return { text: [head, callLogText(fullLog)].filter(Boolean).join("\n"), hint };
}

function callLogParts(raw: string) {
  const lines = raw.split("\n").map((line) => line.trimEnd());
  const logStart = lines.findIndex((line) => /^Call log:/i.test(line.trim()));
  const head = (logStart === -1 ? lines : lines.slice(0, logStart)).filter(Boolean).join("\n");
  const fullLog =
    logStart === -1
      ? []
      : lines
          .slice(logStart + 1)
          .map((line) => line.trim())
          .filter(Boolean);
  return { head, fullLog };
}

function callLogText(fullLog: string[]) {
  const callLog = fullLog.slice(-CALL_LOG_LINES);
  return callLog.length ? `Call log (last ${callLog.length}):\n${callLog.join("\n")}` : "";
}

export type QuotedError = { text: string; cause: unknown };

const BROWSER_CALL_LEAD =
  /(?<![\w$.])(?:[a-z][\w$]*(?:\.[a-z][\w$]*)*: )?(?:Error: )?(?=Timeout \d+(?:\.\d+)?ms exceeded|strict mode violation:|(?:net::ERR|NS_ERROR)_[A-Z_]+ at )/;

function describeQuotedCalls(
  text: string,
  hints: Set<string>,
  selectors?: ReadonlyMap<string, string>,
): string {
  const lines = text.split("\n");
  const logStart = lines.findIndex((line) => /^Call log:/i.test(line.trim()));
  if (logStart === -1) return text;
  let logEnd = logStart + 1;
  while (logEnd < lines.length && /^\s+\S/.test(lines[logEnd] ?? "")) logEnd += 1;
  const head = lines.slice(0, logStart).join("\n");
  const start = BROWSER_CALL_LEAD.exec(head)?.index ?? 0;
  const call = [head.slice(start), ...lines.slice(logStart, logEnd)].join("\n");
  const rest = lines.slice(logEnd);
  const after = rest[0] === "" ? rest.slice(1) : rest;
  const { text: sentence, hint } = describedParts(call, selectors);
  if (hint) hints.add(hint);
  const described = `${head.slice(0, start)}${sentence}`;
  return after.length
    ? `${described}\n${describeQuotedCalls(after.join("\n"), hints, selectors)}`
    : described;
}

export function describeScriptMessage(
  message: string,
  quoted: QuotedError[],
  selectors?: ReadonlyMap<string, string>,
) {
  const shown = new Map<string, Described>();
  for (const { text, cause } of quoted) {
    const entry = describedParts(cause, selectors);
    shown.set(text, entry);
    shown.set(text.trimEnd(), entry);
  }
  const hints = new Set<string>();
  const keys = [...shown.keys()].toSorted((first, second) => second.length - first.length);
  const replaced = keys.length
    ? message.replace(new RegExp(keys.map((key) => RegExp.escape(key)).join("|"), "g"), (match) => {
        const entry = shown.get(match);
        if (entry?.hint) hints.add(entry.hint);
        return entry?.text ?? match;
      })
    : message;
  const described = describeQuotedCalls(
    stripVTControlCharacters(replaced).trimEnd(),
    hints,
    selectors,
  );
  return [described, ...hints].join("\n");
}
