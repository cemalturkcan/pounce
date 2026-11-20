import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PACKAGE_DIR } from "../src/version.ts";
import { startFixture, type Fixture } from "./fixture.ts";

type Daemon = { process: ChildProcess; port: number; stderr: () => string; clients: Client[] };

let fixture: Fixture;
let workDir: string;
const daemons: Daemon[] = [];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function healthy(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
  return response?.ok === true;
}

async function startDaemon(dataDir: string, env: Record<string, string> = {}): Promise<Daemon> {
  const port = await freePort();
  let stderr = "";
  const child = spawn(process.execPath, ["src/server.ts", "--daemon"], {
    cwd: PACKAGE_DIR,
    env: {
      ...process.env,
      DISPLAY: "",
      WAYLAND_DISPLAY: "",
      WEB_AGENT_DAEMON_DATA_DIR: dataDir,
      WEB_AGENT_DAEMON_PORT: String(port),
      WEB_AGENT_HEADLESS: "true",
      WEB_AGENT_PASSWORD_STORE: "basic",
      WEB_AGENT_SECRETS: "none",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const daemon: Daemon = { process: child, port, stderr: () => stderr, clients: [] };
  daemons.push(daemon);
  for (let attempt = 0; attempt < 100 && !(await healthy(port)); attempt += 1) await pause(100);
  assert.equal(await healthy(port), true, `daemon not healthy:\n${stderr}`);
  return daemon;
}

async function stopDaemon(daemon: Daemon) {
  for (const client of daemon.clients) await client.close().catch(() => undefined);
  if (daemon.process.exitCode !== null) return;
  const exited = new Promise((resolve) => daemon.process.once("exit", resolve));
  daemon.process.kill("SIGTERM");
  await Promise.race([exited, pause(15_000)]);
  if (daemon.process.exitCode === null) daemon.process.kill("SIGKILL");
}

async function connect(daemon: Daemon) {
  const client = new Client({ name: "daemon-tabs-e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`)));
  daemon.clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  return { text, isError: result.isError === true };
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

const openedId = (text: string) => /Opened (t\d+)/.exec(text)?.[1] ?? "";

before(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-daemon-tabs-"));
});

after(async () => {
  for (const daemon of daemons) await stopDaemon(daemon);
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("a tab id from before a daemon restart is not open afterwards and never names another page", async () => {
  const dataDir = path.join(workDir, "restart");
  const first = await startDaemon(dataDir);
  const before = await connect(first);
  const old = openedId(await ok(before, "tab_open", { url: `${fixture.url}/article` }));
  assert.ok(old);
  await stopDaemon(first);

  const second = await startDaemon(dataDir);
  const after = await connect(second);
  const fresh = openedId(await ok(after, "tab_open", { url: `${fixture.url}/doc` }));
  assert.notEqual(fresh, old);
  const stale = await call(after, "snapshot", { tab: old });
  assert.equal(stale.isError, true, stale.text);
  assert.match(stale.text, new RegExp(`Tab ${old} is not open \\(it was at ${fixture.url}/article "Fixture Article"\\); it was open before the daemon restarted`));
  await stopDaemon(second);
});

test("a tab closed in this daemon is described with its last url and title", async () => {
  const daemon = await startDaemon(path.join(workDir, "closed"));
  const client = await connect(daemon);
  const tab = openedId(await ok(client, "tab_open", { url: `${fixture.url}/doc` }));
  await ok(client, "tab_close", { tab });
  const gone = await call(client, "snapshot", { tab });
  assert.equal(gone.isError, true);
  assert.match(gone.text, new RegExp(`^Tab ${tab} is not open \\(it was at ${fixture.url}/doc "Fixture Doc"\\); it was closed\\.`));
  await stopDaemon(daemon);
});

test("acting on a tab of another live session is allowed and noted at the start of the result", async () => {
  const daemon = await startDaemon(path.join(workDir, "owners"));
  const owner = await connect(daemon);
  const other = await connect(daemon);
  const tab = openedId(await ok(owner, "tab_open", { url: fixture.url }));
  const foreign = await ok(other, "read_text", { tab, max_chars: 200 });
  assert.ok(foreign.startsWith(`Note: ${tab} belongs to another session.\n`), foreign);
  assert.match(foreign, /Fixture/);
  assert.doesNotMatch(await ok(owner, "read_text", { tab, max_chars: 200 }), /belongs to another session/);
  await stopDaemon(daemon);
});

const EVENT_PREFIX = String.raw`(?:Event \(\d\d:\d\d:\d\d\)|Earlier event \(\d\d:\d\d:\d\d, before this call\)): `;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("tabs that open or close outside a tool action name the opener, the time and any running tool", async () => {
  const daemon = await startDaemon(path.join(workDir, "events"));
  const client = await connect(daemon);
  const tab = openedId(await ok(client, "tab_open", { url: `${fixture.url}/popups` }));
  const opener = escaped(`${fixture.url}/popups`);

  const clicked = await ok(client, "click", { tab, target: "#open-popup" });
  const events = /opened new tab t\d+/.test(clicked) ? clicked : `${clicked}\n${await ok(client, "press", { tab, key: "Shift" })}`;
  const popup = /opened new tab (t\d+)/.exec(events)?.[1] ?? "";
  assert.ok(popup, events);
  assert.match(events, new RegExp(`^${EVENT_PREFIX}opened new tab ${popup} from ${tab} \\(${opener}\\), during click on ${tab}$`, "m"));

  await ok(client, "click", { tab: popup, target: "#finish" });
  await pause(300);
  const closed = await ok(client, "press", { tab, key: "Shift" });
  assert.match(closed, new RegExp(`^${EVENT_PREFIX}tab ${popup} \\(popup\\) closed, with no tool call running on ${tab}; this tab ${tab} is at ${opener}$`, "m"));

  await ok(client, "evaluate", { tab, expression: `document.body.insertAdjacentHTML("beforeend", '<button id="later" onclick="setTimeout(() => window.open(\\'/article\\', \\'_blank\\'), 2500)">Later</button>'); "added"` });
  await ok(client, "click", { tab, target: "#later" });
  await pause(4000);
  const later = await ok(client, "press", { tab, key: "Shift" });
  assert.match(later, new RegExp(`^Earlier event \\(\\d\\d:\\d\\d:\\d\\d, before this call\\): opened new tab t\\d+ from ${tab} \\(${opener}\\), with no tool call running on ${tab}$`, "m"));
  await stopDaemon(daemon);
});

test("a navigation blocked by the client names the Chrome policy file and pattern that match it", async () => {
  const policyRoot = path.join(workDir, "policies");
  await mkdir(path.join(policyRoot, "managed"), { recursive: true });
  const blockedPath = `${new URL(fixture.url).host}/blocked`;
  await writeFile(path.join(policyRoot, "managed", "agent.json"), JSON.stringify({ URLBlocklist: [blockedPath] }));
  const daemon = await startDaemon(path.join(workDir, "policy"), { WEB_AGENT_CHROME_POLICY_DIRS: `${path.join(policyRoot, "managed")}:${path.join(policyRoot, "recommended")}` });
  const client = await connect(daemon);
  const tab = openedId(await ok(client, "tab_open", { url: fixture.url }));
  await ok(client, "intercept", { tab, action: "add", url: "/blocked", mode: "block" });
  await ok(client, "intercept", { tab, action: "add", url: "/other-block", mode: "block" });

  const blocked = await call(client, "navigate", { tab, url: `${fixture.url}/blocked/page` });
  assert.equal(blocked.isError, true, blocked.text);
  assert.match(blocked.text, /ERR_BLOCKED_BY_CLIENT/);
  assert.ok(blocked.text.includes(`Chrome policy: URLBlocklist pattern "${blockedPath}" in ${path.join(policyRoot, "managed", "agent.json")} matches ${fixture.url}/blocked/page.`), blocked.text);

  const other = await call(client, "navigate", { tab, url: `${fixture.url}/other-block` });
  assert.equal(other.isError, true, other.text);
  assert.match(other.text, /ERR_BLOCKED_BY_CLIENT/);
  assert.doesNotMatch(other.text, /Chrome policy/);
  await stopDaemon(daemon);
});

async function postOpen(port: number, body: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/open`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: response.status, json: (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}

const tabLines = (list: string) => list.split("\n").filter((line) => /^t\d+ \[/.test(line));

test("POST /open launches Chrome with exactly one user-owned page at the URL, then reports a running browser", async () => {
  const daemon = await startDaemon(path.join(workDir, "open"));
  const url = `${fixture.url}/article`;
  const cold = await postOpen(daemon.port, JSON.stringify({ url }));
  assert.equal(cold.status, 200, JSON.stringify(cold.json));
  assert.equal(cold.json?.launched, true);
  assert.equal(cold.json?.running, false);
  assert.match(String(cold.json?.tab), /^t\d+$/);
  assert.equal(cold.json?.url, url);

  const client = await connect(daemon);
  const listed = tabLines(await ok(client, "tabs_list"));
  assert.deepEqual(listed, [`${cold.json?.tab} [unclaimed] ${url} "Fixture Article"`]);

  const warm = await postOpen(daemon.port, JSON.stringify({ url: `${fixture.url}/doc` }));
  assert.equal(warm.status, 200);
  assert.deepEqual(warm.json, { launched: false, running: true });
  assert.equal(tabLines(await ok(client, "tabs_list")).length, 1);

  const own = openedId(await ok(client, "tab_open", { url: fixture.url }));
  assert.notEqual(own, cold.json?.tab);
  assert.equal(tabLines(await ok(client, "tabs_list")).length, 2);
  await stopDaemon(daemon);
});

test("POST /open without a URL opens the new tab page, and the route keeps the loopback checks", async () => {
  const daemon = await startDaemon(path.join(workDir, "open-blank"));
  assert.equal((await postOpen(daemon.port, "{}", { origin: "https://evil.test" })).status, 403);
  assert.equal((await postOpen(daemon.port, "not json")).status, 400);
  assert.equal((await postOpen(daemon.port, JSON.stringify({ url: 42 }))).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${daemon.port}/open`)).status, 405);

  const cold = await postOpen(daemon.port, "");
  assert.equal(cold.status, 200, JSON.stringify(cold.json));
  assert.equal(cold.json?.launched, true);
  assert.match(String(cold.json?.url), /^chrome:\/\/new/);
  const client = await connect(daemon);
  const listed = tabLines(await ok(client, "tabs_list"));
  assert.equal(listed.length, 1, listed.join("\n"));
  assert.match(listed[0] ?? "", new RegExp(`^${cold.json?.tab} \\[unclaimed\\] chrome://new`));
  await stopDaemon(daemon);
});
