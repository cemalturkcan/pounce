import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { formatEntry, Logger, logFileName, parseLogLevel, readLog, summarizeInput } from "./log.ts";
import { Redactor } from "./output.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-20T10:00:00.000Z");

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
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-agent-log-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("summarizeInput", () => {
  test("keeps keys and short values", () => {
    assert.deepEqual(summarizeInput({ tab: "t1", target: "#go", timeout_ms: 500, submit: true }), { tab: "t1", target: "#go", timeout_ms: 500, submit: true });
  });

  test("truncates long strings and notes their length", () => {
    const summary = summarizeInput({ url: `https://example.com/${"a".repeat(400)}` }) as { url: string };
    assert.ok(summary.url.length < 260);
    assert.match(summary.url, /^https:\/\/example\.com\/a+… \[420 chars\]$/);
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
    assert.deepEqual(summary, {
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
    assert.doesNotMatch(JSON.stringify(summary), /hunter2|bank\/login|document\.cookie|pw-1234/);
  });

  test("summarizes arrays by length and nested objects by keys", () => {
    const summary = summarizeInput({ urls: ["a", "b", "c"], viewport: { width: 300, height: 200 }, fields: [{ target: "#a", text: "secret" }] });
    assert.deepEqual(summary, { urls: "[3 items]", viewport: { width: 300, height: 200 }, fields: "[1 items]" });
  });

  test("handles non-object input", () => {
    assert.deepEqual(summarizeInput(undefined), {});
    assert.deepEqual(summarizeInput("x"), {});
  });
});

describe("parseLogLevel", () => {
  test("accepts known levels and falls back to info", () => {
    assert.equal(parseLogLevel("debug"), "debug");
    assert.equal(parseLogLevel("WARN"), "warn");
    assert.equal(parseLogLevel(undefined), "info");
    assert.equal(parseLogLevel("verbose"), "info");
  });
});

describe("Logger", () => {
  test("writes one JSON object per line with time, level and event", async () => {
    const dir = await freshDir();
    const time = clock();
    const logger = new Logger({ dir, now: time.now, stderr: () => undefined });
    logger.log("info", "daemon_start", { pid: 42, version: "0.2.0" });
    logger.log("warn", "tool_call", { requestId: "abc123", session: "s1", tab: "t1", tool: "click", ok: false });
    await logger.flush();
    const entries = await lines(dir, "daemon-2026-11-20.jsonl");
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { time: "2026-11-20T10:00:00.000Z", level: "info", event: "daemon_start", pid: 42, version: "0.2.0" });
    assert.equal(entries[1]?.requestId, "abc123");
    assert.equal(entries[1]?.tab, "t1");
  });

  test("drops entries below the configured level", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, level: "warn", now: clock().now, stderr: () => undefined });
    logger.log("debug", "a");
    logger.log("info", "b");
    logger.log("warn", "c");
    logger.log("error", "d");
    await logger.flush();
    assert.deepEqual(
      (await lines(dir, "daemon-2026-11-20.jsonl")).map((entry) => entry.event),
      ["c", "d"],
    );
  });

  test("redacts registered secrets in every string, nested ones included", async () => {
    const dir = await freshDir();
    const redactor = new Redactor();
    redactor.register("bank/login", "s3cr3t-value-123");
    redactor.register("otp", "918273", 120_000);
    const logger = new Logger({ dir, redactor, now: clock().now, stderr: () => undefined });
    logger.log("info", "tool_call", { error: "typed s3cr3t-value-123 into #pw", nested: { list: ["code 918273"] }, encoded: encodeURIComponent("s3cr3t-value-123") });
    await logger.flush();
    const raw = await readFile(path.join(dir, "daemon-2026-11-20.jsonl"), "utf8");
    assert.doesNotMatch(raw, /s3cr3t-value-123|918273/);
    assert.match(raw, /<secret:bank\/login>/);
    assert.match(raw, /<secret:otp>/);
  });

  test("strips terminal color codes", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("warn", "tool_call", { error: "Call log:\n\u001b[2m  - waiting for locator('#missing')\u001b[22m" });
    await logger.flush();
    const [entry] = await lines(dir, "daemon-2026-11-20.jsonl");
    assert.equal(entry?.error, "Call log:\n  - waiting for locator('#missing')");
  });

  test("serializes errors with message and stack", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("warn", "fault", { error: new Error("boom") });
    await logger.flush();
    const [entry] = await lines(dir, "daemon-2026-11-20.jsonl");
    assert.match(String((entry?.error as { message: string }).message), /boom/);
    assert.match(String((entry?.error as { stack: string }).stack), /log\.test\.ts/);
  });

  test("errors also go to stderr", async () => {
    const dir = await freshDir();
    const written: string[] = [];
    const logger = new Logger({ dir, now: clock().now, stderr: (line) => written.push(line) });
    logger.log("warn", "tool_call", { error: "quiet" });
    logger.log("error", "unhandled_rejection", { message: "unhandled rejection kept the server running", error: "kaboom", stack: "Error: kaboom\n    at here" });
    await logger.flush();
    assert.equal(written.length, 1);
    assert.match(written[0] ?? "", /unhandled_rejection: unhandled rejection kept the server running: kaboom/);
    assert.match(written[0] ?? "", /at here/);
  });

  test("starts a new file each UTC day", async () => {
    const dir = await freshDir();
    const time = clock(Date.parse("2026-11-20T23:59:59.000Z"));
    const logger = new Logger({ dir, now: time.now, stderr: () => undefined });
    logger.log("info", "first");
    time.advance(2000);
    logger.log("info", "second");
    await logger.flush();
    assert.deepEqual((await readdir(dir)).sort(), ["daemon-2026-11-20.jsonl", "daemon-2026-11-21.jsonl"]);
    assert.equal((await lines(dir, "daemon-2026-11-21.jsonl"))[0]?.event, "second");
  });

  test("a failing write never throws, reports once on stderr and is counted", async () => {
    const base = await freshDir();
    await writeFile(base, "a file, not a directory");
    const written: string[] = [];
    const logger = new Logger({ dir: path.join(base, "logs"), now: clock().now, stderr: (line) => written.push(line) });
    assert.doesNotThrow(() => logger.log("info", "one"));
    await logger.flush();
    logger.log("info", "two");
    await logger.flush();
    assert.equal(logger.failures, 2);
    assert.equal(written.length, 1);
    assert.match(written[0] ?? "", /log write failed/);
  });

  test("a hung write is abandoned after the deadline", async () => {
    const dir = await freshDir();
    const written: string[] = [];
    const logger = new Logger({ dir, now: clock().now, stderr: (line) => written.push(line), append: () => new Promise(() => undefined), writeTimeoutMs: 50 });
    logger.log("info", "stuck");
    await logger.flush();
    assert.equal(logger.failures, 1);
    assert.match(written[0] ?? "", /timed out/);
  });

  test("appends keep their order under load", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    for (let index = 0; index < 200; index += 1) logger.log("info", "tick", { index });
    await logger.flush();
    const entries = await lines(dir, "daemon-2026-11-20.jsonl");
    assert.deepEqual(
      entries.map((entry) => entry.index),
      Array.from({ length: 200 }, (_value, index) => index),
    );
  });

  test("counts recent errors and warnings in memory", () => {
    const time = clock();
    const logger = new Logger({ dir: path.join(root, "unused"), now: time.now, stderr: () => undefined, append: async () => undefined });
    logger.log("error", "a");
    logger.log("warn", "b");
    time.advance(2 * 60 * 60 * 1000);
    logger.log("error", "c");
    assert.equal(logger.recentCount("error", 60 * 60 * 1000), 1);
    assert.equal(logger.recentCount("warn", 60 * 60 * 1000), 0);
    assert.equal(logger.recentCount("error", 3 * 60 * 60 * 1000), 2);
  });

  test("prune deletes daily files older than 14 days and keeps everything else", async () => {
    const dir = await freshDir();
    const logger = new Logger({ dir, now: clock().now, stderr: () => undefined });
    logger.log("info", "today");
    await logger.flush();
    const names = ["daemon-2026-11-06.jsonl", "daemon-2026-11-05.jsonl", "daemon-2026-10-01.jsonl", "notes.txt", "daemon-latest.jsonl"];
    for (const name of names) await writeFile(path.join(dir, name), "{}\n");
    assert.equal(await logger.prune(), 2);
    assert.deepEqual((await readdir(dir)).sort(), ["daemon-2026-11-06.jsonl", "daemon-2026-11-20.jsonl", "daemon-latest.jsonl", "notes.txt"]);
  });

  test("prune of a missing directory is a no-op", async () => {
    const logger = new Logger({ dir: path.join(root, "missing"), now: clock().now, stderr: () => undefined });
    assert.equal(await logger.prune(), 0);
  });
});

describe("readLog", () => {
  let dir: string;
  const time = clock(Date.parse("2026-11-19T22:00:00.000Z"));

  before(async () => {
    dir = await freshDir();
    const logger = new Logger({ dir, level: "debug", now: time.now, stderr: () => undefined });
    logger.log("info", "daemon_start", { pid: 1 });
    time.advance(30 * 60 * 1000);
    logger.log("warn", "tool_call", { requestId: "aaa111", tool: "click", ok: false, error: "Ref e9 is not in the latest snapshot" });
    time.advance(3 * 60 * 60 * 1000);
    logger.log("debug", "tool_call", { requestId: "bbb222", tool: "snapshot", ok: true });
    logger.log("info", "tool_call", { requestId: "ccc333", tool: "click", ok: true });
    logger.log("error", "fault", { source: "job j1", error: "disk full" });
    await logger.flush();
    await writeFile(path.join(dir, "daemon-2026-11-20.jsonl"), "not json\n", { flag: "a" });
  });

  test("returns entries across files, newest last, limited from the end", async () => {
    const all = await readLog(dir, { limit: 30, level: "debug" }, time.now());
    assert.deepEqual(
      all.entries.map((entry) => entry.event),
      ["daemon_start", "tool_call", "tool_call", "tool_call", "fault"],
    );
    const last = await readLog(dir, { limit: 2, level: "debug" }, time.now());
    assert.deepEqual(
      last.entries.map((entry) => entry.requestId ?? entry.event),
      ["ccc333", "fault"],
    );
  });

  test("filters by minimum level", async () => {
    const result = await readLog(dir, { limit: 30, level: "warn" }, time.now());
    assert.deepEqual(
      result.entries.map((entry) => entry.level),
      ["warn", "error"],
    );
  });

  test("defaults to info and above", async () => {
    const result = await readLog(dir, { limit: 30 }, time.now());
    assert.ok(!result.entries.some((entry) => entry.level === "debug"));
  });

  test("filters by tool, request id, time window and text", async () => {
    assert.deepEqual(
      (await readLog(dir, { limit: 30, tool: "click" }, time.now())).entries.map((entry) => entry.requestId),
      ["aaa111", "ccc333"],
    );
    assert.deepEqual(
      (await readLog(dir, { limit: 30, requestId: "aaa111" }, time.now())).entries.map((entry) => entry.tool),
      ["click"],
    );
    assert.deepEqual(
      (await readLog(dir, { limit: 30, sinceMinutes: 60 }, time.now())).entries.map((entry) => entry.event),
      ["tool_call", "fault"],
    );
    assert.deepEqual(
      (await readLog(dir, { limit: 30, contains: "DISK" }, time.now())).entries.map((entry) => entry.event),
      ["fault"],
    );
  });

  test("a missing directory yields no entries", async () => {
    assert.deepEqual((await readLog(path.join(root, "nope"), { limit: 5 }, time.now())).entries, []);
  });

  test("formats one compact line per entry", () => {
    const line = formatEntry({ time: "2026-11-20T01:30:00.000Z", level: "warn", event: "tool_call", requestId: "aaa111", session: "0f3e9c1a-1111-2222-3333-444455556666", tab: "t2", tool: "click", ms: 12, ok: false, error: "Ref e9 is not in\nthe latest snapshot", input: { target: "e9" } });
    assert.equal(line, '2026-11-20 01:30:00 warn tool_call req=aaa111 session=0f3e9c1a tab=t2 tool=click ms=12 ok=false error="Ref e9 is not in\\nthe latest snapshot" input={"target":"e9"}');
  });

  test("log file names use the UTC date", () => {
    assert.equal(logFileName(Date.parse("2026-01-02T23:00:00.000Z")), "daemon-2026-01-02.jsonl");
  });

  test("entries older than the retention window are not searched beyond 14 days", async () => {
    const result = await readLog(dir, { limit: 30, sinceMinutes: 1 }, time.now() + 10 * DAY);
    assert.deepEqual(result.entries, []);
  });
});
