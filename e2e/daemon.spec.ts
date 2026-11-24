import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { repeatUntil, sleep } from "../src/shared/async.ts";
import { buildBinary } from "../scripts/build-binary.ts";
import { PACKAGE_DIR } from "../src/config/version.ts";
import { healthy, heldPort, runServer, type SpawnedDaemon, spawnDaemon } from "../tests/daemon.ts";
import { callTool, okTool, type ToolArgs } from "../tests/mcpHarness.ts";
import { parseJsonOrThrow } from "../src/shared/decode.ts";
import { startFixture, type Fixture } from "./fixture.ts";

type Session = { client: Client; transport: StreamableHTTPClientTransport };

const jsonValue = z.json();
const logLine = z.record(z.string(), jsonValue);

let fixture: Fixture;
let workDir: string;
let daemon: SpawnedDaemon;
const sessions: Session[] = [];

async function assertAlive() {
  expect(daemon.process.exitCode, `daemon exited:\n${daemon.stderr()}`).toBe(null);
  expect(await healthy(daemon.port), `daemon not healthy:\n${daemon.stderr()}`).toBe(true);
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(daemon.endpoint);
  const client = new Client({ name: "daemon-e2e", version: "0" });
  await client.connect(transport);
  const session = { client, transport };
  sessions.push(session);
  return session;
}

async function readLogLines() {
  const dir = path.join(workDir, "logs");
  const names = (await readdir(dir).catch((): string[] => []))
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted();
  const raw = (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join(
    "",
  );
  return {
    raw,
    entries: raw
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJsonOrThrow(line, logLine)),
  };
}

function ok(session: Session, name: string, args: ToolArgs = {}) {
  return okTool(session.client, name, args);
}

async function jobStatusMatching(session: Session, id: string, pattern: RegExp) {
  let status = "";
  await repeatUntil(
    async () => {
      status = await ok(session, "run_script", { job: id });
      return pattern.test(status) ? true : undefined;
    },
    { delayMs: () => 100, giveUp: (made) => made >= 50 },
  );
  return status;
}

beforeAll(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-daemon-e2e-"));
  daemon = await spawnDaemon(workDir);
  await assertAlive();
});

afterAll(async () => {
  await Promise.all(sessions.map((session) => session.client.close().catch(() => undefined)));
  await daemon?.stop();
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("the daemon survives failures that used to be unhandled rejections", () => {
  let session: Awaited<ReturnType<typeof connect>>;
  let tab: string;

  beforeAll(async () => {
    session = await connect();
    tab = /Opened (t\d+)/.exec(await ok(session, "navigate", { url: fixture.url }))?.[1] ?? "";
    expect(tab).toMatch(/^t\d+$/);
  });

  test("a modify rule whose rewrite_url changes protocol", async () => {
    const refused = await callTool(session.client, "intercept", {
      tab,
      action: "add",
      url: "/api/data",
      mode: "modify",
      rewrite_url: "ftp://127.0.0.1/data",
    });
    expect(refused.isError).toBe(true);
    await ok(session, "intercept", {
      tab,
      action: "add",
      url: "/api/data",
      mode: "modify",
      rewrite_url: `https://127.0.0.1:${daemon.port}/api/data`,
    });
    await ok(session, "click", { tab, target: "#load" });
    await ok(session, "wait_for", { tab, text: "loaded from api" });
    expect(await ok(session, "intercept", { tab, action: "list" })).toMatch(
      /1 failed .*another protocol/,
    );
    await ok(session, "intercept", { tab, action: "clear" });
    await assertAlive();
  });

  test("patch_response when the upstream refuses the connection", async () => {
    const reserved = heldPort();
    const closed = `127.0.0.2:${reserved.port}`;
    try {
      await ok(session, "intercept", {
        tab,
        action: "add",
        url: `${closed}/`,
        mode: "patch_response",
        replacements: [{ find: "a", replace: "b" }],
      });
      await ok(session, "evaluate", {
        tab,
        expression: `fetch('http://${closed}/x').then(() => 'reached', () => 'failed')`,
      });
      const listed = await ok(session, "intercept", { tab, action: "list" });
      expect(listed).toMatch(/1 failed/);
      await ok(session, "intercept", { tab, action: "clear" });
    } finally {
      reserved.stop(true);
    }
    await assertAlive();
  });

  test("a script with a non-awaited failing browser call", async () => {
    await ok(session, "run_script", {
      tab,
      code: "page.click('#missing', { timeout: 300 }); return 'returned';",
    });
    await sleep(1500);
    await assertAlive();
    expect(await ok(session, "logs", { source: "server", limit: 20 })).toMatch(
      /script_call_after_end[^\n]*Nothing matched #missing/,
    );
  });

  test("a script listener that throws synchronously", async () => {
    const other = await connect();
    const otherTab =
      /Opened (t\d+)/.exec(await ok(other, "navigate", { url: fixture.url }))?.[1] ?? "";
    const result = await ok(session, "run_script", {
      tab,
      code: `page.on("framenavigated", (frame) => { JSON.parse(frame.url()); }); await page.goto(${JSON.stringify(`${fixture.url}/article`)}); await sleep(500); return "alive";`,
    });
    expect(result).toMatch(/Returned: alive/);
    expect(result).toMatch(/Error in a framenavigated callback: .*JSON/);
    await sleep(500);
    await assertAlive();
    expect(await ok(other, "tabs")).toMatch(new RegExp(`${otherTab} \\[yours\\]`));
    expect(await ok(other, "tabs")).not.toMatch(/run_script callback/);
    await ok(other, "tabs", { close: [otherTab] });
  });

  test("synchronous code after an await is stopped by timeout_ms and leaves the daemon answering", async () => {
    const startedAt = Date.now();
    const busy = await callTool(session.client, "run_script", {
      timeout_ms: 1000,
      code: "await sleep(10); const end = Date.now() + 6000; while (Date.now() < end) {} return 'finished';",
    });
    const elapsed = Date.now() - startedAt;
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/timed out after 1000 ms/);
    expect(elapsed, `stopped after ${elapsed} ms`).toBeLessThan(2500);

    const other = await connect();
    const started = await ok(session, "run_script", {
      background: true,
      code: "await sleep(10); while (true) {}",
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    const loopStarted = Date.now();
    await sleep(300);
    expect(await ok(other, "tabs")).toMatch(/Output files/);
    const answeredAfter = Date.now() - loopStarted;
    expect(answeredAfter, `tabs answered after ${answeredAfter} ms`).toBeLessThan(1500);
    expect(await ok(session, "run_script", { job: id })).toMatch(/ running /);
    expect(await ok(session, "run_script", { job: id, cancel: true })).toMatch(/ cancelled /);
    await assertAlive();
  });

  test("a job whose result file cannot be written", async () => {
    const started = await ok(session, "run_script", {
      tab,
      background: true,
      code: "await page.locator('body[data-result-dir=locked]').waitFor({ state: 'attached', timeout: 60000 }); return 'value';",
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    const logFile = /Log: (\S+)/.exec(started)?.[1] ?? "";
    const dir = path.dirname(logFile);
    await chmod(dir, 0o500);
    try {
      await ok(session, "evaluate", {
        tab,
        expression: "document.body.dataset.resultDir = 'locked'",
      });
      const status = await jobStatusMatching(session, id, / done /);
      expect(status).toMatch(/ done /);
      expect(status).toMatch(/could not be written/);
    } finally {
      await chmod(dir, 0o700);
    }
    await assertAlive();
  });
});

test("tabs of an ended session become orphaned and claimable", async () => {
  const first = await connect();
  const tab = /Opened (t\d+)/.exec(await ok(first, "navigate", { url: fixture.url }))?.[1] ?? "";
  const second = await connect();
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[other client\\]`));
  await first.transport.terminateSession();
  await sleep(200);
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[orphaned\\]`));
  await ok(second, "snapshot", { tab });
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[yours\\]`));
  await ok(second, "tabs", { close: [tab] });
  await assertAlive();
});

test("a tab a background job opens after its session ended is orphaned when the job ends", async () => {
  const first = await connect();
  const started = await ok(first, "run_script", {
    background: true,
    code: `await sleep(1000); const opened = await openTab(${JSON.stringify(`${fixture.url}/doc`)}); log("opened " + tabId(opened));`,
  });
  const id = /background job (j\d+)/.exec(started)?.[1] ?? "";
  await first.transport.terminateSession();
  const second = await connect();
  const status = await jobStatusMatching(second, id, / done /);
  const tab = /opened (t\d+)/.exec(status)?.[1] ?? "";
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[orphaned\\]`));
  await assertAlive();
});

test("a tab a background job opens after its session ended stays the session's until its last job ends", async () => {
  const first = await connect();
  const short = await ok(first, "run_script", {
    background: true,
    code: "await sleep(1500); return 'short';",
  });
  const long = await ok(first, "run_script", {
    background: true,
    code: `await sleep(200); const opened = await openTab(${JSON.stringify(`${fixture.url}/doc`)}); log("opened " + tabId(opened)); await sleep(3000); return 'long';`,
  });
  const shortId = /background job (j\d+)/.exec(short)?.[1] ?? "";
  const longId = /background job (j\d+)/.exec(long)?.[1] ?? "";
  await first.transport.terminateSession();
  const second = await connect();
  await jobStatusMatching(second, shortId, / done /);
  const running = await jobStatusMatching(second, longId, /opened t\d+/);
  const tab = /opened (t\d+)/.exec(running)?.[1] ?? "";
  expect(running).toMatch(/ running /);
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[other client\\]`));
  await jobStatusMatching(second, longId, / done /);
  expect(await ok(second, "tabs")).toMatch(new RegExp(`${tab} \\[orphaned\\]`));
  await assertAlive();
});

async function startedJob(session: Session, code: string) {
  const started = await ok(session, "run_script", { background: true, code });
  return /background job (j\d+)/.exec(started)?.[1] ?? "";
}

test("another open session may cancel a background job", async () => {
  const first = await connect();
  const id = await startedJob(first, "await sleep(20000);");
  const second = await connect();
  expect(await ok(second, "run_script", { job: id, cancel: true })).toMatch(/ cancelled /);
  await assertAlive();
});

test("a background job of an ended session is listed as orphaned", async () => {
  const first = await connect();
  const id = await startedJob(first, "await sleep(20000);");
  await first.transport.terminateSession();
  const second = await connect();
  expect(await jobStatusMatching(second, id, /\(orphaned\)/)).toMatch(/ running \(orphaned\) /);
  await ok(second, "run_script", { job: id, cancel: true });
  await assertAlive();
});

test("any session may cancel a background job of an ended session", async () => {
  const first = await connect();
  const id = await startedJob(first, "await sleep(20000);");
  await first.transport.terminateSession();
  await sleep(200);
  const second = await connect();
  expect(await ok(second, "run_script", { job: id, cancel: true })).toMatch(/ cancelled /);
  await assertAlive();
});

test("a failing call carries a request id that leads to its log line", async () => {
  const session = await connect();
  const tab = /Opened (t\d+)/.exec(await ok(session, "navigate", { url: fixture.url }))?.[1] ?? "";
  const typed = `pw-${randomBytes(8).toString("hex")}`;
  const failed = await callTool(session.client, "fill", { tab, target: "e9999", value: typed });
  const { text } = failed;
  expect(failed.isError).toBe(true);
  const requestId = /\[req ([0-9a-f]{6})\]$/.exec(text)?.[1] ?? "";
  expect(requestId, `no request id in: ${text}`).toMatch(/^[0-9a-f]{6}$/);
  expect(text).not.toContain(typed);

  const log =
    (await repeatUntil(
      async () => {
        const current = await readLogLines();
        return current.entries.some((entry) => entry.requestId === requestId) ? current : undefined;
      },
      { delayMs: () => 100, giveUp: (made) => made >= 30 },
    )) ?? (await readLogLines());
  const entry = log.entries.find((candidate) => candidate.requestId === requestId);
  expect(entry, `no log line for ${requestId}`).toBeDefined();
  expect(entry?.event).toBe("tool_call");
  expect(entry?.level).toBe("warn");
  expect(entry?.tool).toBe("fill");
  expect(entry?.tab).toBe(tab);
  expect(entry?.ok).toBe(false);
  expect(entry?.session).toBeString();
  expect(entry?.ms).toBeNumber();
  expect(String(entry?.error)).toMatch(/not in the latest snapshot/);
  expect(entry?.input).toStrictEqual({ tab, target: "e9999", value: `[${typed.length} chars]` });
  expect(log.raw, "typed text leaked into the log").not.toContain(typed);
  for (const event of ["daemon_start", "session_open", "browser_launch"]) {
    expect(
      log.entries.map((candidate) => candidate.event),
      `no ${event} event`,
    ).toContain(event);
  }

  const listed = await ok(session, "logs", { source: "server", request_id: requestId });
  expect(listed).toMatch(new RegExp(`req=${requestId}`));
  expect(listed).toMatch(/tool=fill/);
  expect(listed).toContain(path.join(workDir, "logs"));
  expect(listed).not.toContain(typed);
  expect(
    await ok(session, "logs", { source: "server", level: "warn", tool: "fill", limit: 5 }),
  ).toMatch(new RegExp(`req=${requestId}`));

  const tabs = await ok(session, "tabs");
  expect(tabs, tabs).toContain(`Log: ${path.join(workDir, "logs")}`);
  expect(tabs).toMatch(/\d+ errors? in the last hour/);
  await ok(session, "tabs", { close: [tab] });
});

async function exitedWithin(daemonProcess: SpawnedDaemon["process"], ms: number) {
  if (daemonProcess.exitCode !== null) return true;
  const exited = new Promise((resolve) => daemonProcess.once("exit", resolve));
  await Promise.race([exited, sleep(ms)]);
  return daemonProcess.exitCode !== null;
}

describe("a compiled server", () => {
  let binDir: string;
  let binary: string;

  beforeAll(async () => {
    binDir = await mkdtemp(path.join(tmpdir(), "web-agent-binary-e2e-"));
    binary = path.join(binDir, "pounce");
    await buildBinary(process.arch === "arm64" ? "arm64" : "x64", binary);
  });

  afterAll(async () => {
    await rm(binDir, { recursive: true, force: true });
  });

  describe("running as a daemon whose file was replaced", () => {
    let dataDir: string;
    let compiled: SpawnedDaemon;

    beforeAll(async () => {
      dataDir = path.join(binDir, "data");
      compiled = await spawnDaemon(dataDir, {}, PACKAGE_DIR, [binary]);
      expect(await healthy(compiled.port), compiled.stderr()).toBe(true);
      await copyFile(binary, `${binary}.new`);
      await rename(`${binary}.new`, binary);
    });

    afterAll(async () => {
      await compiled?.stop();
    });

    test("is reported running by its status", async () => {
      const status = await runServer([binary], dataDir, compiled.port, ["--daemon-status"]);

      expect(JSON.parse(status.stdout)).toMatchObject({ running: true });
    });

    test("is stopped by its stop command", async () => {
      await runServer([binary], dataDir, compiled.port, ["--daemon-stop"]);

      expect(await exitedWithin(compiled.process, 15_000)).toBe(true);
    });
  });

  describe("next to a daemon started from source", () => {
    let second: SpawnedDaemon | undefined;

    afterAll(async () => {
      await second?.stop();
    });

    test("reports it running", async () => {
      const status = await runServer([binary], workDir, daemon.port, ["--daemon-status"]);

      expect(JSON.parse(status.stdout)).toMatchObject({ running: true });
    });

    test("refuses to import a profile", async () => {
      const from = path.join(binDir, "chrome");
      await mkdir(path.join(from, "Default"), { recursive: true });

      const imported = await runServer([binary], workDir, daemon.port, [
        "--import-profile",
        "--from",
        from,
      ]);

      expect(imported.stderr).toContain("daemon is running");
    });

    test("refuses to start a second daemon", async () => {
      second = await spawnDaemon(workDir, {}, PACKAGE_DIR, [binary]);

      expect(second.process.exitCode, second.stderr()).toBe(1);
    });
  });
});
