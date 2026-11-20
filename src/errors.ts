const CALL_LOG_LINES = 8;
const FAULT_LIMIT = 20;

export type Fault = { time: string; source: string; message: string };

const faults: Fault[] = [];

export function recordFault(source: string, error: unknown) {
  const message = (error instanceof Error ? (error.stack ?? error.message) : String(error)).split("\n").slice(0, 3).join(" | ");
  faults.push({ time: new Date().toISOString(), source, message: message.slice(0, 500) });
  if (faults.length > FAULT_LIMIT) faults.splice(0, faults.length - FAULT_LIMIT);
}

export function recentFaults(limit = 5) {
  return faults.slice(-limit);
}

let guardsInstalled = false;

export function installProcessGuards(label: string) {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    recordFault("unhandled rejection", reason);
    console.error(`${label}: unhandled rejection kept the server running:`, reason instanceof Error ? (reason.stack ?? reason.message) : reason);
  });
}

export class ToolError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

type Rule = { pattern: RegExp; hint: string };

const RULES: Rule[] = [
  {
    pattern: /Target page, context or browser has been closed|Target closed|has been closed|Browser closed/i,
    hint: "The tab or the browser was closed. Call tabs_list to see what is open, or tab_open for a new tab; the browser relaunches on demand.",
  },
  {
    pattern: /strict mode violation/i,
    hint: "The selector matched several elements. Use a ref from snapshot, or a more specific selector.",
  },
  {
    pattern: /intercepts pointer events/i,
    hint: "Another element covers the target (overlay, cookie banner, modal). Run dismiss_overlays, or click the covering element first.",
  },
  {
    pattern: /element is not (visible|enabled|editable|stable)|not attached/i,
    hint: "The element exists but is not actionable yet. Check the page with snapshot; it may be hidden, disabled, or still animating.",
  },
  {
    pattern: /Timeout \d+ms exceeded/i,
    hint: "Nothing matched or the page did not react in time. Take a snapshot to see the current page before retrying.",
  },
  {
    pattern: /net::ERR_INVALID_AUTH_CREDENTIALS/i,
    hint: "The site asks for HTTP authentication (the browser's own login dialog). Use http_auth with a password-store entry for this origin, then navigate again.",
  },
  {
    pattern: /net::ERR_|NS_ERROR_/i,
    hint: "The navigation failed at the network level. Check the URL and network_requests for the failing request.",
  },
  {
    pattern: /ProcessSingleton|SingletonLock|profile appears to be in use|user data directory is already in use/i,
    hint: "Another Chrome process already uses the agent profile directory. Close that Chrome or stop the other web-agent instance.",
  },
];

function stripAnsi(value: string) {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export function describeError(error: unknown) {
  if (error instanceof ToolError) {
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  }

  const raw = stripAnsi(error instanceof Error ? error.message : String(error));
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
  const hint = RULES.find((rule) => rule.pattern.test(raw))?.hint;

  return [head, callLog.length ? `Call log (last ${callLog.length}):\n${callLog.join("\n")}` : "", hint ?? ""]
    .filter(Boolean)
    .join("\n");
}
