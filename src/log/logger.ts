import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { inSequence, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { listDir } from "../shared/files.ts";
import { parseJson } from "../shared/decode.ts";
import { messageOf } from "../shared/errors.ts";
import type { Redactor } from "../shared/output.ts";
import { writeStderr } from "./stderr.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
type LogRecord = { readonly [key: string]: LogValue };
type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | Error
  | readonly LogValue[]
  | LogRecord;
export type LogFields = LogRecord;

const logValue: z.ZodType<LogValue> = z.lazy(() =>
  z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.bigint(),
      z.null(),
      z.undefined(),
      z.instanceof(Error),
      z.array(logValue),
      z.record(z.string(), logValue),
    ])
    .catch("[not logged]"),
);
const toolInput = z.record(z.string(), logValue);

const logEntry = z
  .object({ time: z.string(), level: z.enum(LOG_LEVELS), event: z.string() })
  .catchall(z.json());
type LogEntry = z.infer<typeof logEntry>;

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
const SENSITIVE_KEY =
  /secret|password|passwd|value|text|code|script|expression|body|token|otp|cookie|header|authorization|post/i;
const URL_KEY = /url$/i;
const RESERVED = new Set(["time", "level", "event"]);
const HEAD_FIELDS = ["requestId", "session", "tab"] as const;

type Append = (file: string, text: string) => Promise<void>;

type LoggerOptions = {
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

function isText(value: LogValue): value is string {
  return typeof value === "string";
}

function isList(value: LogValue): value is readonly LogValue[] {
  return Array.isArray(value);
}

function isRecord(value: LogValue): value is LogRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(value: LogValue) {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && "message" in value) return String(value.message);
  return value === undefined ? "" : String(value);
}

function nestedStack(value: LogValue) {
  if (value instanceof Error) return value.stack;
  return isRecord(value) ? value.stack : undefined;
}

function stderrLine(event: string, fields: LogFields) {
  const request = isText(fields.requestId) ? ` [req ${fields.requestId}]` : "";
  const message = [fields.message, fields.source, errorText(fields.error)]
    .filter((part) => isText(part) && part)
    .join(": ");
  const nested = nestedStack(fields.error);
  const stack = isText(fields.stack) ? fields.stack : isText(nested) ? nested : "";
  const rest = Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) => !["message", "source", "error", "stack", "requestId"].includes(key),
    ),
  );
  const detail = message || JSON.stringify(rest);
  return `web-agent-mcp ${event}${request}: ${detail}${stack ? `\n${stack}` : ""}`;
}

function clipStack(stack: string | undefined) {
  return stack?.split("\n").slice(0, STACK_LINES).join("\n");
}

function maskQueryPart(part: string) {
  if (!part) return part;
  const equals = part.indexOf("=");
  if (equals === -1) return `[${part.length} chars]`;
  return `${part.slice(0, equals)}=[${part.length - equals - 1} chars]`;
}

function maskUrl(value: string) {
  const start = value.indexOf("?");
  if (start === -1) return value;
  const hash = value.indexOf("#", start);
  const end = hash === -1 ? value.length : hash;
  return `${value.slice(0, start + 1)}${value
    .slice(start + 1, end)
    .split("&")
    .map(maskQueryPart)
    .join("&")}${value.slice(end)}`;
}

type Redact = (text: string) => string;

function sanitize(value: LogValue, redact: Redact, depth: number, key = ""): LogValue {
  if (isText(value)) {
    const clean = redact(stripVTControlCharacters(value));
    return URL_KEY.test(key) ? maskUrl(clean) : clean;
  }
  if (value === undefined) return undefined;
  if (value instanceof Error)
    return { message: redact(value.message), stack: redact(clipStack(value.stack) ?? "") };
  if (isList(value))
    return depth >= SANITIZE_DEPTH
      ? "[deep]"
      : value.map((item) => sanitize(item, redact, depth + 1));
  if (isRecord(value))
    return depth >= SANITIZE_DEPTH ? "[deep]" : sanitizeRecord(value, redact, depth);
  if (isBigInt(value)) return value.toString();
  return isScalar(value) ? value : undefined;
}

function sanitizeRecord(value: LogRecord, redact: Redact, depth: number) {
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [name, sanitize(item, redact, depth + 1, name)]),
  );
}

function isBigInt(value: LogValue): value is bigint {
  return typeof value === "bigint";
}

function isScalar(value: LogValue): value is number | boolean | null {
  return value === null || typeof value === "number" || typeof value === "boolean";
}

function measure(value: LogValue) {
  if (isText(value)) return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function summarizeValue(key: string, value: LogValue, depth: number): LogValue {
  if (SENSITIVE_KEY.test(key)) return `[${measure(value)} chars]`;
  if (key === "query" && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, `[${measure(item)} chars]`]),
    );
  }
  if (isText(value) && URL_KEY.test(key)) {
    const masked = maskUrl(value);
    return masked.length > STRING_LIMIT
      ? `${masked.slice(0, STRING_LIMIT)}… [${value.length} chars]`
      : masked;
  }
  if (isText(value))
    return value.length > STRING_LIMIT
      ? `${value.slice(0, STRING_LIMIT)}… [${value.length} chars]`
      : value;
  if (isList(value)) return `[${value.length} items]`;
  if (value instanceof Error || isRecord(value))
    return depth >= SUMMARY_DEPTH ? "[object]" : summarizeObject(value, depth + 1);
  return value;
}

function summarizeObject(input: LogRecord | Error, depth: number): LogFields {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, summarizeValue(key, value, depth)]),
  );
}

export function summarizeInput<Input>(input: Input): LogFields {
  const parsed = toolInput.safeParse(input);
  return parsed.success ? summarizeObject(parsed.data, 1) : {};
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
  private readonly recent = { warn: new Array<number>(), error: new Array<number>() };
  private flushing?: Promise<void>;
  private reportedFailure = false;
  private dirReady = false;
  private closed = false;

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
    if (this.closed || !this.enabled(level)) return;
    try {
      const time = this.now();
      const redact = (text: string) => (this.redactor ? this.redactor.redact(text) : text);
      const own = Object.fromEntries(
        Object.entries(fields).filter(([key, value]) => !RESERVED.has(key) && value !== undefined),
      );
      const clean = sanitizeRecord(own, redact, 0);
      const entry = { time: new Date(time).toISOString(), level, event, ...clean };
      if (level === "warn" || level === "error") this.remember(level, time);
      if (level === "error") this.stderr(stderrLine(event, clean));
      if (this.pending.length >= PENDING_LIMIT) {
        this.fail(new Error(`more than ${PENDING_LIMIT} entries waiting to be written`), 1);
        return;
      }
      this.pending.push({
        file: path.join(this.dir, logFileName(time)),
        line: `${JSON.stringify(entry)}\n`,
      });
      this.schedule();
    } catch (cause) {
      this.fail(cause, 1);
    }
  }

  recentCount(level: "warn" | "error", windowMs: number) {
    const since = this.now() - windowMs;
    return this.recent[level].filter((time) => time >= since).length;
  }

  async flush(): Promise<void> {
    const current = this.flushing;
    if (!current) return;
    await current;
    return this.flush();
  }

  async close() {
    this.closed = true;
    if (active === this) active = undefined;
    await this.flush();
  }

  async prune() {
    const cutoff = dayOf(this.now() - LOG_RETENTION_DAYS * DAY_MS);
    const expired = (await listDir(this.dir)).filter((name) => {
      const day = FILE_PATTERN.exec(name)?.[1];
      return day !== undefined && day !== "" && day < cutoff;
    });
    const results = await inSequence(expired, (name) =>
      withDeadline(rm(path.join(this.dir, name), { force: true }), this.writeTimeoutMs).catch(
        () => TIMED_OUT,
      ),
    );
    return results.filter((done) => done !== TIMED_OUT).length;
  }

  private remember(level: "warn" | "error", time: number) {
    const list = this.recent[level];
    list.push(time);
    if (list.length > RECENT_LIMIT) list.splice(0, list.length - RECENT_LIMIT);
  }

  private schedule() {
    this.flushing ??= this.drain()
      .catch((cause: unknown) => this.fail(cause, 0))
      .finally(() => {
        this.flushing = undefined;
        if (this.pending.length) this.schedule();
      });
  }

  private async drain(): Promise<void> {
    if (!this.pending.length) return;
    const runs = runsByFile(this.pending.splice(0));
    await inSequence(runs, (run) => this.write(run.file, run.lines.join(""), run.lines.length));
    return this.drain();
  }

  private async write(file: string, text: string, count: number) {
    try {
      const result = await withDeadline(this.append(file, text), this.writeTimeoutMs);
      if (result === TIMED_OUT)
        this.fail(new Error(`timed out after ${this.writeTimeoutMs} ms`), count);
    } catch (cause) {
      this.dirReady = false;
      this.fail(cause, count);
    }
  }

  private async appendToFile(file: string, text: string) {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await appendFile(file, text);
  }

  private fail(cause: unknown, count: number) {
    this.failures += count;
    if (this.reportedFailure) return;
    this.reportedFailure = true;
    this.stderr(
      `web-agent-mcp log write failed in ${this.dir}: ${messageOf(cause)}; later failures are only counted`,
    );
  }
}

function runsByFile(batch: readonly { file: string; line: string }[]) {
  const runs: { file: string; lines: string[] }[] = [];
  for (const item of batch) {
    const last = runs.at(-1);
    if (last?.file === item.file) last.lines.push(item.line);
    else runs.push({ file: item.file, lines: [item.line] });
  }
  return runs;
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

type LogQuery = {
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
  const parsed = parseJson(line, logEntry);
  return parsed.success ? parsed.data : undefined;
}

export async function readLog(dir: string, query: LogQuery, now = Date.now()) {
  const since = query.sinceMinutes === undefined ? undefined : now - query.sinceMinutes * 60_000;
  const oldestDay = dayOf(since ?? now - LOG_RETENTION_DAYS * DAY_MS);
  const names = (await listDir(dir))
    .filter((name) => {
      const day = FILE_PATTERN.exec(name)?.[1];
      return day !== undefined && day >= oldestDay;
    })
    .toSorted()
    .toReversed();
  const found: LogEntry[] = [];
  const unreadable: string[] = [];
  await inSequence(names, async (name) => {
    if (found.length >= query.limit) return;
    const text = await withDeadline(readFile(path.join(dir, name), "utf8"), READ_TIMEOUT_MS).catch(
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    if (text === TIMED_OUT) {
      unreadable.push(name);
      return;
    }
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0 && found.length < query.limit; index -= 1) {
      const raw = lines[index] ?? "";
      const entry = raw ? parseLine(raw) : undefined;
      if (entry && matches(entry, raw, query, since)) found.push(entry);
    }
  });
  return { entries: found.toReversed(), unreadable };
}

function formatValue(value: LogValue) {
  return isText(value) && /^[\w.:/@#+-]+$/.test(value) ? value : JSON.stringify(value);
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
