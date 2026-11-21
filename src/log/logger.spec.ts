import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";
import {
  activeLogger,
  formatEntry,
  Logger,
  logEvent,
  logFileName,
  parseLogLevel,
  readLog,
  summarizeInput,
  useLogger,
} from "./logger.ts";
import { Redactor } from "../shared/output.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-20T10:00:00.000Z");
const logLine = z.record(z.string(), z.json());
const serializedError = z.object({ message: z.string(), stack: z.string() });

let root: string;
let counter = 0;

async function freshDir() {
  counter += 1;
  return path.join(root, `case-${counter}`);
}

function clock(start = START) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

async function lines(dir: string, name: string) {
  const text = await readFile(path.join(dir, name), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJsonOrThrow(line, logLine));
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-agent-log-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("summarizeInput", () => {
  test("keeps keys and short values", () => {
    expect(
      summarizeInput({ tab: "t1", target: "#go", timeout_ms: 500, submit: true }),
    ).toStrictEqual({
      tab: "t1",
      target: "#go",
      timeout_ms: 500,
      submit: true,
    });
  });

  test("truncates long strings and notes their length", () => {
    const summary = summarizeInput({ url: `https://example.com/${"a".repeat(400)}` });
    expect(String(summary.url).length).toBeLessThan(260);
    expect(summary.url).toMatch(/^https:\/\/example\.com\/a+… \[420 chars\]$/);
  });

  test("logs sensitive keys only as length", () => {
    const summary = summarizeInput({
      text: "hunter2-password",
      secret: "bank/login",
      value: "x",
      code: "await page.click('#a')",
      script: "s".repeat(10),
      expression: "document.cookie",
      body: { a: 1 },
      password: "pw-1234",
      secret_field: "otp",
    });
    expect(summary).toStrictEqual({
      text: "[16 chars]",
      secret: "[10 chars]",
      value: "[1 chars]",
      code: "[22 chars]",
      script: "[10 chars]",
      expression: "[15 chars]",
      body: "[7 chars]",
      password: "[7 chars]",
      secret_field: "[3 chars]",
    });
    expect(JSON.stringify(summary)).not.toMatch(/hunter2|bank\/login|document\.cookie|pw-1234/);
  });

  test("summarizes arrays by length and nested objects by keys", () => {
    const summary = summarizeInput({
      urls: ["a", "b", "c"],
      viewport: { width: 300, height: 200 },
      fields: [{ target: "#a", text: "secret" }],
    });
    expect(summary).toStrictEqual({
      urls: "[3 items]",
      viewport: { width: 300, height: 200 },
      fields: "[1 items]",
    });
  });

  test("masks query values and post bodies but keeps keys and lengths", () => {
    const summary = summarizeInput({
      url: "https://api.example.com/v1/login?token=abc123secret&user=me&empty=",
      query: { api_key: "k-998877", page: "2" },
      post_data: "username=me&password=hunter2",
    });
    expect(summary).toStrictEqual({
      url: "https://api.example.com/v1/login?token=[12 chars]&user=[2 chars]&empty=[0 chars]",
      query: { api_key: "[8 chars]", page: "[1 chars]" },
      post_data: "[28 chars]",
    });
  });

  test("masks the query string of a url field in logged events", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("info", "tab_closed_outside", {
      tab: "t1",
      url: "https://example.com/cb?code=oauth-code-1234#frag",
    });
    await logger.flush();
    const [entry] = await lines(dir, "daemon-2026-11-20.jsonl");
    expect(entry?.url).toBe("https://example.com/cb?code=[15 chars]#frag");
  });

  test("summarizes the loggable values next to a value it cannot log", () => {
    const summary = summarizeInput({
      tab: "t1",
      viewport: { width: 300, height: 200, onResize: () => undefined },
      pick: Symbol("pick"),
    });
    expect(summary).toStrictEqual({
      tab: "t1",
      viewport: { width: 300, height: 200, onResize: "[not logged]" },
      pick: "[not logged]",
    });
  });

  test("handles non-object input", () => {
    expect(summarizeInput(undefined)).toStrictEqual({});
    expect(summarizeInput("x")).toStrictEqual({});
  });
});

describe("parseLogLevel", () => {
  test("accepts known levels and falls back to info", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("verbose")).toBe("info");
  });
});

describe("Logger", () => {
  test("writes one JSON object per line with time, level and event", async () => {
    const dir = await freshDir();
    const time = clock();
    const logger = new Logger({ dir, now: time.now, stderr: () => undefined });
    logger.log("info", "daemon_start", { pid: 42, version: "0.2.0" });
    logger.log("warn", "tool_call", {
      requestId: "abc123",
      session: "s1",
      tab: "t1",
      tool: "click",
      ok: false,
    });
    await logger.flush();
    const entries = await lines(dir, "daemon-2026-11-20.jsonl");
    expect(entries.length).toBe(2);
    expect(entries[0]).toStrictEqual({
      time: "2026-11-20T10:00:00.000Z",
      level: "info",
      event: "daemon_start",
      pid: 42,
      version: "0.2.0",
    });
    expect(entries[1]?.requestId).toBe("abc123");
    expect(entries[1]?.tab).toBe("t1");
  });

  test("drops entries below the configured level", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, level: "warn", now: clock().now, stderr: () => undefined });
    logger.log("debug", "a");
    logger.log("info", "b");
    logger.log("warn", "c");
    logger.log("error", "d");
    await logger.flush();
    expect((await lines(dir, "daemon-2026-11-20.jsonl")).map((entry) => entry.event)).toStrictEqual(
      ["c", "d"],
    );
  });

  test("redacts registered secrets in every string, nested ones included", async () => {
    const dir = await freshDir();
    const redactor = new Redactor();
    redactor.register("bank/login", "s3cr3t-value-123");
    redactor.register("otp", "918273", 120_000);
    const logger = new Logger({ dir, redactor, now: clock().now, stderr: () => undefined });
    logger.log("info", "tool_call", {
      error: "typed s3cr3t-value-123 into #pw",
      nested: { list: ["code 918273"] },
      encoded: encodeURIComponent("s3cr3t-value-123"),
    });
    await logger.flush();
    const raw = await readFile(path.join(dir, "daemon-2026-11-20.jsonl"), "utf8");
    expect(raw).not.toMatch(/s3cr3t-value-123|918273/);
    expect(raw).toMatch(/<secret:bank\/login>/);
    expect(raw).toMatch(/<secret:otp>/);
  });

  test("strips terminal color codes", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("warn", "tool_call", {
      error: "Call log:\n\u001b[2m  - waiting for locator('#missing')\u001b[22m",
    });
    await logger.flush();
    const [entry] = await lines(dir, "daemon-2026-11-20.jsonl");
    expect(entry?.error).toBe("Call log:\n  - waiting for locator('#missing')");
  });

  test("serializes errors with message and stack", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("warn", "fault", { error: new Error("boom") });
    await logger.flush();
    const [entry] = await lines(dir, "daemon-2026-11-20.jsonl");
    const error = serializedError.parse(entry?.error);
    expect(error.message).toMatch(/boom/);
    expect(error.stack).toMatch(/logger\.spec\.ts/);
  });

  test("errors also go to stderr", async () => {
    const dir = await freshDir();
    const written: string[] = [];
    const logger = new Logger({ dir, now: clock().now, stderr: (line) => written.push(line) });
    logger.log("warn", "tool_call", { error: "quiet" });
    logger.log("error", "unhandled_rejection", {
      message: "unhandled rejection kept the server running",
      error: "kaboom",
      stack: "Error: kaboom\n    at here",
    });
    await logger.flush();
    expect(written.length).toBe(1);
    expect(written[0] ?? "").toMatch(
      /unhandled_rejection: unhandled rejection kept the server running: kaboom/,
    );
    expect(written[0] ?? "").toMatch(/at here/);
  });

  test("starts a new file each UTC day", async () => {
    const dir = await freshDir();
    const time = clock(Date.parse("2026-11-20T23:59:59.000Z"));
    const logger = new Logger({ dir, now: time.now, stderr: () => undefined });
    logger.log("info", "first");
    time.advance(2000);
    logger.log("info", "second");
    await logger.flush();
    expect((await readdir(dir)).toSorted()).toStrictEqual([
      "daemon-2026-11-20.jsonl",
      "daemon-2026-11-21.jsonl",
    ]);
    expect((await lines(dir, "daemon-2026-11-21.jsonl"))[0]?.event).toBe("second");
  });

  test("a failing write never throws, reports once on stderr and is counted", async () => {
    const base = await freshDir();
    await writeFile(base, "a file, not a directory");
    const written: string[] = [];
    const logger = new Logger({
      dir: path.join(base, "logs"),
      now: clock().now,
      stderr: (line) => written.push(line),
    });
    expect(() => logger.log("info", "one")).not.toThrow();
    await logger.flush();
    logger.log("info", "two");
    await logger.flush();
    expect(logger.failures).toBe(2);
    expect(written.length).toBe(1);
    expect(written[0] ?? "").toMatch(/log write failed/);
  });

  test("close writes the pending entries and drops later ones", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now });
    logger.log("info", "before close");
    await logger.close();
    logger.log("info", "after close");
    await logger.flush();
    expect((await lines(dir, logFileName(START))).map((line) => line.event)).toStrictEqual([
      "before close",
    ]);
  });

  test("close uninstalls the logger it was active as", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now });
    useLogger(logger);
    await logger.close();
    expect(activeLogger()).toBeUndefined();
  });

  test("an event logged after its logger closed leaves the removed log folder absent", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    useLogger(logger);
    logEvent("first");
    await logger.close();
    await rm(dir, { recursive: true, force: true });
    logEvent("late");
    await logger.flush();
    expect(await readdir(root)).not.toContain(path.basename(dir));
  });

  test("a hung write is abandoned after the deadline", async () => {
    const dir = await freshDir();
    const written: string[] = [];
    const logger = new Logger({
      dir,
      now: clock().now,
      stderr: (line) => written.push(line),
      append: () => new Promise(() => undefined),
      writeTimeoutMs: 50,
    });
    logger.log("info", "stuck");
    await logger.flush();
    expect(logger.failures).toBe(1);
    expect(written[0] ?? "").toMatch(/timed out/);
  });

  test("appends keep their order under load", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    for (let index = 0; index < 200; index += 1) logger.log("info", "tick", { index });
    await logger.flush();
    const entries = await lines(dir, "daemon-2026-11-20.jsonl");
    expect(entries.map((entry) => entry.index)).toStrictEqual(
      Array.from({ length: 200 }, (_value, index) => index),
    );
  });

  test("counts recent errors and warnings in memory", () => {
    const time = clock();
    const logger = new Logger({
      dir: path.join(root, "unused"),
      now: time.now,
      stderr: () => undefined,
      append: async () => undefined,
    });
    logger.log("error", "a");
    logger.log("warn", "b");
    time.advance(2 * 60 * 60 * 1000);
    logger.log("error", "c");
    expect(logger.recentCount("error", 60 * 60 * 1000)).toBe(1);
    expect(logger.recentCount("warn", 60 * 60 * 1000)).toBe(0);
    expect(logger.recentCount("error", 3 * 60 * 60 * 1000)).toBe(2);
  });

  test("prune deletes daily files older than 14 days and keeps everything else", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("info", "today");
    await logger.flush();
    const names = [
      "daemon-2026-11-06.jsonl",
      "daemon-2026-11-05.jsonl",
      "daemon-2026-10-01.jsonl",
      "notes.txt",
      "daemon-latest.jsonl",
    ];
    await Promise.all(names.map((name) => writeFile(path.join(dir, name), "{}\n")));
    expect(await logger.prune()).toBe(2);
    expect((await readdir(dir)).toSorted()).toStrictEqual([
      "daemon-2026-11-06.jsonl",
      "daemon-2026-11-20.jsonl",
      "daemon-latest.jsonl",
      "notes.txt",
    ]);
  });

  test("prune of a missing directory is a no-op", async () => {
    const logger = new Logger({
      dir: path.join(root, "missing"),
      now: clock().now,
      stderr: () => undefined,
    });
    expect(await logger.prune()).toBe(0);
  });
});

describe("readLog", () => {
  let dir: string;
  const time = clock(Date.parse("2026-11-19T22:00:00.000Z"));

  beforeAll(async () => {
    dir = await freshDir();
    const logger = new Logger({ dir, level: "debug", now: time.now, stderr: () => undefined });
    logger.log("info", "daemon_start", { pid: 1 });
    time.advance(30 * 60 * 1000);
    logger.log("warn", "tool_call", {
      requestId: "aaa111",
      tool: "click",
      ok: false,
      error: "Ref e9 is not in the latest snapshot",
    });
    time.advance(3 * 60 * 60 * 1000);
    logger.log("debug", "tool_call", { requestId: "bbb222", tool: "snapshot", ok: true });
    logger.log("info", "tool_call", { requestId: "ccc333", tool: "click", ok: true });
    logger.log("error", "fault", { source: "job j1", error: "disk full" });
    await logger.flush();
    await writeFile(path.join(dir, "daemon-2026-11-20.jsonl"), "not json\n", { flag: "a" });
  });

  test("returns entries across files, newest last, limited from the end", async () => {
    const all = await readLog(dir, { limit: 30, level: "debug" }, time.now());
    expect(all.entries.map((entry) => entry.event)).toStrictEqual([
      "daemon_start",
      "tool_call",
      "tool_call",
      "tool_call",
      "fault",
    ]);
    const last = await readLog(dir, { limit: 2, level: "debug" }, time.now());
    expect(last.entries.map((entry) => entry.requestId ?? entry.event)).toStrictEqual([
      "ccc333",
      "fault",
    ]);
  });

  test("filters by minimum level", async () => {
    const result = await readLog(dir, { limit: 30, level: "warn" }, time.now());
    expect(result.entries.map((entry) => entry.level)).toStrictEqual(["warn", "error"]);
  });

  test("defaults to info and above", async () => {
    const result = await readLog(dir, { limit: 30 }, time.now());
    expect(result.entries.filter((entry) => entry.level === "debug")).toStrictEqual([]);
  });

  test("filters by tool, request id, time window and text", async () => {
    expect(
      (await readLog(dir, { limit: 30, tool: "click" }, time.now())).entries.map(
        (entry) => entry.requestId,
      ),
    ).toStrictEqual(["aaa111", "ccc333"]);
    expect(
      (await readLog(dir, { limit: 30, requestId: "aaa111" }, time.now())).entries.map(
        (entry) => entry.tool,
      ),
    ).toStrictEqual(["click"]);
    expect(
      (await readLog(dir, { limit: 30, sinceMinutes: 60 }, time.now())).entries.map(
        (entry) => entry.event,
      ),
    ).toStrictEqual(["tool_call", "fault"]);
    expect(
      (await readLog(dir, { limit: 30, contains: "DISK" }, time.now())).entries.map(
        (entry) => entry.event,
      ),
    ).toStrictEqual(["fault"]);
  });

  test("a missing directory yields no entries", async () => {
    expect(
      (await readLog(path.join(root, "nope"), { limit: 5 }, time.now())).entries,
    ).toStrictEqual([]);
  });

  test("formats one compact line per entry", () => {
    const line = formatEntry({
      time: "2026-11-20T01:30:00.000Z",
      level: "warn",
      event: "tool_call",
      requestId: "aaa111",
      session: "0f3e9c1a-1111-2222-3333-444455556666",
      tab: "t2",
      tool: "click",
      ms: 12,
      ok: false,
      error: "Ref e9 is not in\nthe latest snapshot",
      input: { target: "e9" },
    });
    expect(line).toBe(
      '2026-11-20 01:30:00 warn tool_call req=aaa111 session=0f3e9c1a tab=t2 tool=click ms=12 ok=false error="Ref e9 is not in\\nthe latest snapshot" input={"target":"e9"}',
    );
  });

  test("log file names use the UTC date", () => {
    expect(logFileName(Date.parse("2026-01-02T23:00:00.000Z"))).toBe("daemon-2026-01-02.jsonl");
  });

  test("entries older than the retention window are not searched beyond 14 days", async () => {
    const result = await readLog(dir, { limit: 30, sinceMinutes: 1 }, time.now() + 10 * DAY);
    expect(result.entries).toStrictEqual([]);
  });
});
