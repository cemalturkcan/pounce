import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PACKAGE_DIR } from "../src/version.ts";
import { startFixture, type Fixture } from "./fixture.ts";

type Session = { client: Client; transport: StreamableHTTPClientTransport };

let fixture: Fixture;
let workDir: string;
let daemon: ChildProcess;
let port: number;
let stderr = "";
const sessions: Session[] = [];

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function healthy() {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
  return response?.ok === true;
}

async function assertAlive() {
  assert.equal(daemon.exitCode, null, `daemon exited:\n${stderr}`);
  assert.equal(await healthy(), true, `daemon not healthy:\n${stderr}`);
}

async function connect() {
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "daemon-e2e", version: "0" });
  await client.connect(transport);
  const session = { client, transport };
  sessions.push(session);
  return session;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (result.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function readLogLines() {
  const dir = path.join(workDir, "logs");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl")).sort();
  const raw = (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join("");
  return { raw, entries: raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}

async function ok(session: Session, name: string, args: Record<string, unknown> = {}) {
  const result = await session.client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  assert.equal(result.isError === true, false, `${name} failed: ${text}`);
  return text;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-daemon-e2e-"));
  port = await freePort();
  daemon = spawn(process.execPath, ["src/server.ts", "--daemon"], {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      WEB_AGENT_DAEMON_DATA_DIR: workDir,
      WEB_AGENT_DAEMON_PORT: String(port),
      WEB_AGENT_HEADLESS: "true",
      WEB_AGENT_PASSWORD_STORE: "basic",
      WEB_AGENT_SECRETS: "none",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  for (let attempt = 0; attempt < 100 && !(await healthy()); attempt += 1) await pause(100);
  await assertAlive();
});

after(async () => {
  for (const session of sessions) await session.client.close().catch(() => undefined);
  if (daemon && daemon.exitCode === null) {
    const exited = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await Promise.race([exited, pause(15_000)]);
    if (daemon.exitCode === null) daemon.kill("SIGKILL");
  }
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("the daemon survives failures that used to be unhandled rejections", async (t) => {
  const session = await connect();
  const tab = /Opened (t\d+)/.exec(await ok(session, "tab_open", { url: fixture.url }))?.[1] ?? "";
  assert.ok(tab);

  await t.test("a modify rule whose rewrite_url changes protocol", async () => {
    const refused = await session.client.callTool({ name: "intercept", arguments: { tab, action: "add", url: "/api/data", mode: "modify", rewrite_url: "ftp://127.0.0.1/data" } });
    assert.equal(refused.isError, true);
    await ok(session, "intercept", { tab, action: "add", url: "/api/data", mode: "modify", rewrite_url: `https://127.0.0.1:${port}/api/data` });
    await ok(session, "click", { tab, target: "#load" });
    await ok(session, "wait_for", { tab, text: "loaded from api" });
    assert.match(await ok(session, "intercept", { tab, action: "list" }), /1 failed .*another protocol/);
    await ok(session, "intercept", { tab, action: "clear" });
    await assertAlive();
  });

  await t.test("patch_response when the upstream refuses the connection", async () => {
    const closed = await freePort();
    await ok(session, "intercept", { tab, action: "add", url: `127.0.0.1:${closed}/`, mode: "patch_response", replacements: [{ find: "a", replace: "b" }] });
    await ok(session, "evaluate", { tab, expression: `fetch('http://127.0.0.1:${closed}/x').then(() => 'reached', () => 'failed')` });
    assert.match(await ok(session, "intercept", { tab, action: "list" }), /1 failed/);
    await ok(session, "intercept", { tab, action: "clear" });
    await assertAlive();
  });

  await t.test("a script with a non-awaited failing browser call", async () => {
    await ok(session, "run_script", { tab, code: "page.click('#missing', { timeout: 300 }); return 'returned';" });
    await pause(1500);
    await assertAlive();
    assert.match(await ok(session, "tabs_list"), /Recent background errors[\s\S]*unhandled rejection/);
    assert.match(stderr, /unhandled rejection kept the server running/);
  });

  await t.test("a script listener that throws synchronously", async () => {
    const other = await connect();
    const otherTab = /Opened (t\d+)/.exec(await ok(other, "tab_open", { url: fixture.url }))?.[1] ?? "";
    const result = await ok(session, "run_script", {
      tab,
      code: `page.on("framenavigated", (frame) => { JSON.parse(frame.url()); }); await page.goto(${JSON.stringify(`${fixture.url}/article`)}); await sleep(500); return "alive";`,
    });
    assert.match(result, /Returned: alive/);
    assert.match(result, /Error in a framenavigated callback: .*JSON/);
    await pause(500);
    await assertAlive();
    assert.match(await ok(other, "tabs_list"), new RegExp(`${otherTab} \\[yours\\]`));
    assert.match(await ok(other, "tabs_list"), /Recent background errors[\s\S]*run_script callback/);
    await ok(other, "tab_close", { tab: otherTab });
  });

  await t.test("a job whose result file cannot be written", async () => {
    const started = await ok(session, "run_script", { background: true, code: "await sleep(1500); return 'value';" });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    const logFile = /Log: (\S+)/.exec(started)?.[1] ?? "";
    const dir = path.dirname(logFile);
    await chmod(dir, 0o500);
    try {
      let status = "";
      for (let attempt = 0; attempt < 50 && !/ done /.test(status); attempt += 1) {
        await pause(100);
        status = await ok(session, "jobs", { action: "status", id });
      }
      assert.match(status, / done /);
      assert.match(status, /could not be written/);
    } finally {
      await chmod(dir, 0o700);
    }
    await assertAlive();
  });
});

test("tabs of an ended session become orphaned and claimable", async () => {
  const first = await connect();
  const tab = /Opened (t\d+)/.exec(await ok(first, "tab_open", { url: fixture.url }))?.[1] ?? "";
  const second = await connect();
  assert.match(await ok(second, "tabs_list"), new RegExp(`${tab} \\[other client\\]`));
  await first.transport.terminateSession();
  await pause(200);
  assert.match(await ok(second, "tabs_list"), new RegExp(`${tab} \\[orphaned\\]`));
  await ok(second, "snapshot", { tab });
  assert.match(await ok(second, "tabs_list"), new RegExp(`${tab} \\[yours\\]`));
  await ok(second, "tab_close", { tab });
  await assertAlive();
});

test("a failing call carries a request id that leads to its log line", async () => {
  const session = await connect();
  const tab = /Opened (t\d+)/.exec(await ok(session, "tab_open", { url: fixture.url }))?.[1] ?? "";
  const typed = `pw-${randomBytes(8).toString("hex")}`;
  const failed = await session.client.callTool({ name: "fill", arguments: { tab, target: "e9999", text: typed } });
  const text = textOf(failed);
  assert.equal(failed.isError, true);
  const requestId = /\[req ([0-9a-f]{6})\]$/.exec(text)?.[1] ?? "";
  assert.ok(requestId, `no request id in: ${text}`);
  assert.ok(!text.includes(typed));

  let log = await readLogLines();
  for (let attempt = 0; attempt < 30 && !log.entries.some((entry) => entry.requestId === requestId); attempt += 1) {
    await pause(100);
    log = await readLogLines();
  }
  const entry = log.entries.find((candidate) => candidate.requestId === requestId);
  assert.ok(entry, `no log line for ${requestId}`);
  assert.equal(entry.event, "tool_call");
  assert.equal(entry.level, "warn");
  assert.equal(entry.tool, "fill");
  assert.equal(entry.tab, tab);
  assert.equal(entry.ok, false);
  assert.equal(typeof entry.session, "string");
  assert.equal(typeof entry.ms, "number");
  assert.match(String(entry.error), /not in the latest snapshot/);
  assert.deepEqual(entry.input, { tab, target: "e9999", text: `[${typed.length} chars]` });
  assert.ok(!log.raw.includes(typed), "typed text leaked into the log");
  for (const event of ["daemon_start", "session_open", "browser_launch"]) {
    assert.ok(log.entries.some((candidate) => candidate.event === event), `no ${event} event`);
  }

  const listed = await ok(session, "server_log", { request_id: requestId });
  assert.match(listed, new RegExp(`req=${requestId}`));
  assert.match(listed, /tool=fill/);
  assert.ok(listed.includes(path.join(workDir, "logs")));
  assert.ok(!listed.includes(typed));
  assert.match(await ok(session, "server_log", { level: "warn", tool: "fill", limit: 5 }), new RegExp(`req=${requestId}`));

  const tabs = await ok(session, "tabs_list");
  assert.ok(tabs.includes(`Log: ${path.join(workDir, "logs")}`), tabs);
  assert.match(tabs, /\d+ errors? in the last hour/);
  await ok(session, "tab_close", { tab });
});
