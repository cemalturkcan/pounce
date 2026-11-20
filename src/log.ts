import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { TIMED_OUT, withDeadline } from "./async.ts";
import type { Redactor } from "./output.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogFields = Record<string, unknown>;
export type LogEntry = { time: string; level: LogLevel; event: string; requestId?: string; session?: string; tab?: string; [field: string]: unknown };

export const LOG_RETENTION_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const WRITE_TIMEOUT_MS = 5000;
const READ_TIMEOUT_MS = 10_000;
const PENDING_LIMIT = 5000;
const RECENT_LIMIT = 2000;
const STRING_LIMIT = 200;
const SUMMARY_DEPTH = 2;
const SANITIZE_DEPTH = 6;
const STACK_LINES = 12;
const LINE_LIMIT = 800;
const FILE_PATTERN = /^daemon-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SENSITIVE_KEY = /secret|password|passwd|value|text|code|script|expression|body|token|otp|cookie|header|authorization/i;
const RESERVED = new Set(["time", "level", "event"]);
const HEAD_FIELDS = ["requestId", "session", "tab"] as const;

type Append = (file: string, text: string) => Promise<void>;

export type LoggerOptions = {
  dir: string;
  level?: LogLevel;
  redactor?: Redactor;
  now?: () => number;
  stderr?: (line: string) => void;
  append?: Append;
  writeTimeoutMs?: number;
};

function rank(level: LogLevel) {
  return LOG_LEVELS.indexOf(level);
}

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === normalized) ?? "info";
}

function dayOf(time: number) {
  return new Date(time).toISOString().slice(0, 10);
}

export function logFileName(time: number) {
  return `daemon-${dayOf(time)}.jsonl`;
}

export function newRequestId() {
  return randomBytes(3).toString("hex");
}

function writeStderr(line: string) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    return;
  }
}

function errorText(value: unknown) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object" && "message" in value) return String((value as { message: unknown }).message);
  return value === undefined ? "" : String(value);
}

function stderrLine(event: string, fields: LogFields) {
  const request = typeof fields.requestId === "string" ? ` [req ${fields.requestId}]` : "";
  const message = [fields.message, errorText(fields.error)].filter((part) => typeof part === "string" && part).join(": ");
  const nested = fields.error && typeof fields.error === "object" ? (fields.error as { stack?: unknown }).stack : undefined;
  const stack = typeof fields.stack === "string" ? fields.stack : typeof nested === "string" ? nested : "";
  const rest = Object.fromEntries(Object.entries(fields).filter(([key]) => !["message", "error", "stack", "requestId"].includes(key)));
  const detail = message || JSON.stringify(rest);
  return `web-agent-mcp ${event}${request}: ${detail}${stack ? `\n${stack}` : ""}`;
}

function clipStack(stack: string | undefined) {
  return stack?.split("\n").slice(0, STACK_LINES).join("\n");
}

function sanitize(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (typeof value === "string") return redact(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { message: redact(value.message), stack: redact(clipStack(value.stack) ?? "") };
  if (typeof value !== "object") return undefined;
  if (depth >= SANITIZE_DEPTH) return "[deep]";
  if (Array.isArray(value)) return value.map((item) => sanitize(item, redact, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item, redact, depth + 1)]));
}

function measure(value: unknown) {
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function summarizeValue(key: string, value: unknown, depth: number): unknown {
  if (SENSITIVE_KEY.test(key)) return `[${measure(value)} chars]`;
  if (typeof value === "string") return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}… [${value.length} chars]` : value;
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (value && typeof value === "object") return depth >= SUMMARY_DEPTH ? "[object]" : summarizeObject(value as Record<string, unknown>, depth + 1);
  return value;
}

function summarizeObject(input: Record<string, unknown>, depth: number) {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, summarizeValue(key, value, depth)]));
}

export function summarizeInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return summarizeObject(input as Record<string, unknown>, 1);
}

export class Logger {
  readonly dir: string;
  readonly level: LogLevel;
  failures = 0;
  private readonly redactor?: Redactor;
  private readonly now: () => number;
  private readonly stderr: (line: string) => void;
  private readonly append: Append;
  private readonly writeTimeoutMs: number;
  private readonly pending: { file: string; line: string }[] = [];
  private readonly recent: Record<"warn" | "error", number[]> = { warn: [], error: [] };
  private flushing?: Promise<void>;
  private reportedFailure = false;
  private dirReady = false;

  constructor(options: LoggerOptions) {
    this.dir = options.dir;
    this.level = options.level ?? "info";
    this.redactor = options.redactor;
    this.now = options.now ?? Date.now;
    this.stderr = options.stderr ?? writeStderr;
    this.append = options.append ?? ((file, text) => this.appendToFile(file, text));
    this.writeTimeoutMs = options.writeTimeoutMs ?? WRITE_TIMEOUT_MS;
  }

  enabled(level: LogLevel) {
    return rank(level) >= rank(this.level);
  }

  log(level: LogLevel, event: string, fields: LogFields = {}) {
    if (!this.enabled(level)) return;
    try {
      const time = this.now();
      const redact = (text: string) => (this.redactor ? this.redactor.redact(text) : text);
      const own = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !RESERVED.has(key) && value !== undefined));
      const clean = sanitize(own, redact) as LogFields;
      const entry = { time: new Date(time).toISOString(), level, event, ...clean };
      if (level === "warn" || level === "error") this.remember(level, time);
      if (level === "error") this.stderr(stderrLine(event, clean));
      if (this.pending.length >= PENDING_LIMIT) {
        this.fail(new Error(`more than ${PENDING_LIMIT} entries waiting to be written`), 1);
        return;
      }
      this.pending.push({ file: path.join(this.dir, logFileName(time)), line: `${JSON.stringify(entry)}\n` });
      this.schedule();
    } catch (error) {
      this.fail(error, 1);
    }
  }

  recentCount(level: "warn" | "error", windowMs: number) {
    const since = this.now() - windowMs;
    return this.recent[level].filter((time) => time >= since).length;
  }

  async flush() {
    while (this.flushing) await this.flushing;
  }

  async prune() {
    const cutoff = dayOf(this.now() - LOG_RETENTION_DAYS * DAY_MS);
    const names = await readdir(this.dir).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      const day = FILE_PATTERN.exec(name)?.[1];
      if (!day || day >= cutoff) continue;
      const done = await withDeadline(rm(path.join(this.dir, name), { force: true }), this.writeTimeoutMs).catch(() => TIMED_OUT);
      if (done !== TIMED_OUT) removed += 1;
    }
    return removed;
  }

  private remember(level: "warn" | "error", time: number) {
    const list = this.recent[level];
    list.push(time);
    if (list.length > RECENT_LIMIT) list.splice(0, list.length - RECENT_LIMIT);
  }

  private schedule() {
    this.flushing ??= this.drain()
      .catch((error: unknown) => this.fail(error, 0))
      .finally(() => {
        this.flushing = undefined;
        if (this.pending.length) this.schedule();
      });
  }

  private async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      let start = 0;
      while (start < batch.length) {
        const file = batch[start]?.file ?? "";
        let end = start;
        while (end < batch.length && batch[end]?.file === file) end += 1;
        await this.write(
          file,
          batch
            .slice(start, end)
            .map((item) => item.line)
            .join(""),
          end - start,
        );
        start = end;
      }
    }
  }

  private async write(file: string, text: string, count: number) {
    try {
      const result = await withDeadline(this.append(file, text), this.writeTimeoutMs);
      if (result === TIMED_OUT) this.fail(new Error(`timed out after ${this.writeTimeoutMs} ms`), count);
    } catch (error) {
      this.dirReady = false;
      this.fail(error, count);
    }
  }

  private async appendToFile(file: string, text: string) {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await appendFile(file, text);
  }

  private fail(error: unknown, count: number) {
    this.failures += count;
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    this.stderr(`web-agent-mcp log write failed in ${this.dir}: ${errorText(error)}; later failures are only counted`);
  }
}

let active: Logger | undefined;

export function useLogger(logger: Logger | undefined) {
  active = logger;
}

export function activeLogger() {
  return active;
}

export function logEvent(event: string, fields: LogFields = {}, level: LogLevel = "info") {
  if (active) {
    active.log(level, event, fields);
    return;
  }
  if (level === "error") writeStderr(stderrLine(event, fields));
}

export type LogQuery = {
  level?: LogLevel;
  tool?: string;
  requestId?: string;
  sinceMinutes?: number;
  contains?: string;
  limit: number;
};

function matches(entry: LogEntry, raw: string, query: LogQuery, since: number | undefined) {
  if (rank(entry.level) < rank(query.level ?? "info")) return false;
  if (query.tool && entry.tool !== query.tool) return false;
  if (query.requestId && entry.requestId !== query.requestId) return false;
  if (since !== undefined && Date.parse(entry.time) < since) return false;
  if (query.contains && !raw.toLowerCase().includes(query.contains.toLowerCase())) return false;
  return true;
}

function parseLine(line: string) {
  try {
    const entry = JSON.parse(line) as LogEntry;
    if (entry && typeof entry.time === "string" && typeof entry.event === "string" && LOG_LEVELS.includes(entry.level)) return entry;
  } catch {
    return undefined;
  }
  return undefined;
}

export async function readLog(dir: string, query: LogQuery, now = Date.now()) {
  const since = query.sinceMinutes === undefined ? undefined : now - query.sinceMinutes * 60_000;
  const oldestDay = dayOf(since ?? now - LOG_RETENTION_DAYS * DAY_MS);
  const names = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => {
      const day = FILE_PATTERN.exec(name)?.[1];
      return day !== undefined && day >= oldestDay;
    })
    .sort()
    .reverse();
  const found: LogEntry[] = [];
  const unreadable: string[] = [];
  for (const name of names) {
    if (found.length >= query.limit) break;
    const text = await withDeadline(readFile(path.join(dir, name), "utf8"), READ_TIMEOUT_MS).catch(() => undefined);
    if (typeof text !== "string") {
      unreadable.push(name);
      continue;
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0 && found.length < query.limit; index -= 1) {
      const raw = lines[index] ?? "";
      const entry = raw ? parseLine(raw) : undefined;
      if (entry && matches(entry, raw, query, since)) found.push(entry);
    }
  }
  return { entries: found.reverse(), unreadable };
}

function formatValue(value: unknown) {
  if (typeof value === "string") return /^[\w.:/@#+-]+$/.test(value) ? value : JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function formatEntry(entry: LogEntry) {
  const head = [`${entry.time.slice(0, 10)} ${entry.time.slice(11, 19)}`, entry.level, entry.event];
  if (entry.requestId) head.push(`req=${entry.requestId}`);
  if (entry.session) head.push(`session=${String(entry.session).slice(0, 8)}`);
  if (entry.tab) head.push(`tab=${entry.tab}`);
  const skip = new Set<string>([...RESERVED, ...HEAD_FIELDS]);
  const rest = Object.entries(entry)
    .filter(([key, value]) => !skip.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  const line = [...head, ...rest].join(" ");
  return line.length > LINE_LIMIT ? `${line.slice(0, LINE_LIMIT)}…` : line;
}
