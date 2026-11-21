import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { sleep } from "../src/shared/async.ts";
import { healthy, type SpawnedDaemon, spawnDaemon } from "../tests/daemon.ts";
import { callTool, okTool } from "../tests/mcpHarness.ts";
import { startFixture, type Fixture } from "./fixture.ts";

const jsonValue = z.json();
const jsonObject = z.record(z.string(), jsonValue);

type Daemon = SpawnedDaemon & { clients: Client[] };

let fixture: Fixture;
let workDir: string;
const daemons: Daemon[] = [];

async function startDaemon(dataDir: string, env: NodeJS.ProcessEnv = {}): Promise<Daemon> {
  const spawned = await spawnDaemon(dataDir, { DISPLAY: "", WAYLAND_DISPLAY: "", ...env });
  const daemon: Daemon = { ...spawned, clients: [] };
  daemons.push(daemon);
  expect(await healthy(daemon.port), `daemon not healthy:\n${daemon.stderr()}`).toBe(true);
  return daemon;
}

async function stopDaemon(daemon: Daemon) {
  await Promise.all(daemon.clients.map((client) => client.close().catch(() => undefined)));
  await daemon.stop();
}

async function connect(daemon: Daemon) {
  const client = new Client({ name: "daemon-tabs-e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(daemon.endpoint));
  daemon.clients.push(client);
  return client;
}

const call = callTool;
const ok = okTool;

const openedId = (text: string) => /Opened (t\d+)/.exec(text)?.[1] ?? "";

beforeAll(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-daemon-tabs-"));
});

afterAll(async () => {
  await Promise.all(daemons.map(stopDaemon));
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("a tab id from before a daemon restart is not open afterwards and never names another page", async () => {
  const dataDir = path.join(workDir, "restart");
  const first = await startDaemon(dataDir);
  const before = await connect(first);
  const old = openedId(await ok(before, "tab_open", { url: `${fixture.url}/article` }));
  expect(old).toMatch(/^t\d+$/);
  await stopDaemon(first);

  const second = await startDaemon(dataDir);
  const after = await connect(second);
  const fresh = openedId(await ok(after, "tab_open", { url: `${fixture.url}/doc` }));
  expect(fresh).not.toBe(old);
  const stale = await call(after, "snapshot", { tab: old });
  expect(stale.isError).toBe(true);
  expect(stale.text).toMatch(
    new RegExp(
      `Tab ${old} is not open \\(it was at ${fixture.url}/article "Fixture Article"\\); it was open before the daemon restarted`,
    ),
  );
  await stopDaemon(second);
});

test("a tab closed in this daemon is described with its last url and title", async () => {
  const daemon = await startDaemon(path.join(workDir, "closed"));
  const client = await connect(daemon);
  const tab = openedId(await ok(client, "tab_open", { url: `${fixture.url}/doc` }));
  await ok(client, "tab_close", { tab });
  const gone = await call(client, "snapshot", { tab });
  expect(gone.isError).toBe(true);
  expect(gone.text).toMatch(
    new RegExp(
      `^Tab ${tab} is not open \\(it was at ${fixture.url}/doc "Fixture Doc"\\); it was closed\\.`,
    ),
  );
  await stopDaemon(daemon);
});

test("acting on a tab of another live session is allowed and noted at the start of the result", async () => {
  const daemon = await startDaemon(path.join(workDir, "owners"));
  const owner = await connect(daemon);
  const other = await connect(daemon);
  const tab = openedId(await ok(owner, "tab_open", { url: fixture.url }));
  const foreign = await ok(other, "read_text", { tab, max_chars: 200 });
  expect(foreign, foreign).toStartWith(`Note: ${tab} belongs to another session.\n`);
  expect(foreign).toMatch(/Fixture/);
  expect(await ok(owner, "read_text", { tab, max_chars: 200 })).not.toMatch(
    /belongs to another session/,
  );
  await stopDaemon(daemon);
});

test("a tab a tab_open call opens while its session ends is orphaned when the call ends", async () => {
  const daemon = await startDaemon(path.join(workDir, "ending"));
  const transport = new StreamableHTTPClientTransport(daemon.endpoint);
  const ending = new Client({ name: "daemon-tabs-e2e", version: "0" });
  await ending.connect(transport);
  daemon.clients.push(ending);
  const opening = call(ending, "tab_open", { url: `${fixture.url}/doc` }).catch(() => undefined);
  await sleep(50);
  await transport.terminateSession();
  await Promise.race([opening, sleep(5000)]);
  await sleep(500);
  const other = await connect(daemon);
  const opened = tabLines(await ok(other, "tabs_list")).filter((line) =>
    line.includes(`${fixture.url}/doc`),
  );
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatch(/^t\d+ \[orphaned\]/);
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
  const events = /opened new tab t\d+/.test(clicked)
    ? clicked
    : `${clicked}\n${await ok(client, "press", { tab, key: "Shift" })}`;
  const popup = /opened new tab (t\d+)/.exec(events)?.[1] ?? "";
  expect(popup, events).toMatch(/^t\d+$/);
  expect(events).toMatch(
    new RegExp(
      `^${EVENT_PREFIX}opened new tab ${popup} from ${tab} \\(${opener}\\), during click on ${tab}$`,
      "m",
    ),
  );

  await ok(client, "click", { tab: popup, target: "#finish" });
  await sleep(300);
  const closed = await ok(client, "press", { tab, key: "Shift" });
  expect(closed).toMatch(
    new RegExp(
      `^${EVENT_PREFIX}tab ${popup} \\(popup\\) closed, with no tool call running on ${tab}; this tab ${tab} is at ${opener}$`,
      "m",
    ),
  );

  await ok(client, "evaluate", {
    tab,
    expression: `document.body.insertAdjacentHTML("beforeend", '<button id="later" onclick="setTimeout(() => window.open(\\'/article\\', \\'_blank\\'), 2500)">Later</button>'); "added"`,
  });
  await ok(client, "click", { tab, target: "#later" });
  await sleep(4000);
  const later = await ok(client, "press", { tab, key: "Shift" });
  expect(later).toMatch(
    new RegExp(
      `^Earlier event \\(\\d\\d:\\d\\d:\\d\\d, before this call\\): opened new tab t\\d+ from ${tab} \\(${opener}\\), with no tool call running on ${tab}$`,
      "m",
    ),
  );
  await stopDaemon(daemon);
});

test("a navigation blocked by the client names the Chrome policy file and pattern that match it", async () => {
  const policyRoot = path.join(workDir, "policies");
  await mkdir(path.join(policyRoot, "managed"), { recursive: true });
  const blockedPath = `${new URL(fixture.url).host}/blocked`;
  await writeFile(
    path.join(policyRoot, "managed", "agent.json"),
    JSON.stringify({ URLBlocklist: [blockedPath] }),
  );
  const daemon = await startDaemon(path.join(workDir, "policy"), {
    WEB_AGENT_CHROME_POLICY_DIRS: `${path.join(policyRoot, "managed")}:${path.join(policyRoot, "recommended")}`,
  });
  const client = await connect(daemon);
  const tab = openedId(await ok(client, "tab_open", { url: fixture.url }));
  await ok(client, "intercept", { tab, action: "add", url: "/blocked", mode: "block" });
  await ok(client, "intercept", { tab, action: "add", url: "/other-block", mode: "block" });

  const blocked = await call(client, "navigate", { tab, url: `${fixture.url}/blocked/page` });
  expect(blocked.isError).toBe(true);
  expect(blocked.text).toMatch(/ERR_BLOCKED_BY_CLIENT/);
  expect(blocked.text).toContain(
    `Chrome policy: URLBlocklist pattern "${blockedPath}" in ${path.join(policyRoot, "managed", "agent.json")} matches ${fixture.url}/blocked/page.`,
  );

  const other = await call(client, "navigate", { tab, url: `${fixture.url}/other-block` });
  expect(other.isError).toBe(true);
  expect(other.text).toMatch(/ERR_BLOCKED_BY_CLIENT/);
  expect(other.text).not.toMatch(/Chrome policy/);
  await stopDaemon(daemon);
});

async function postOpen(port: number, body: string, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/open`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  return {
    status: response.status,
    json: jsonObject.optional().parse(await response.json().catch(() => undefined)),
  };
}

const tabLines = (list: string) => list.split("\n").filter((line) => /^t\d+ \[/.test(line));

test("POST /open launches Chrome with exactly one user-owned page at the URL, then reports a running browser", async () => {
  const daemon = await startDaemon(path.join(workDir, "open"));
  const url = `${fixture.url}/article`;
  const cold = await postOpen(daemon.port, JSON.stringify({ url }));
  expect(cold.status).toBe(200);
  expect(cold.json?.launched).toBe(true);
  expect(cold.json?.running).toBe(false);
  expect(String(cold.json?.tab)).toMatch(/^t\d+$/);
  expect(cold.json?.url).toBe(url);

  const client = await connect(daemon);
  const listed = tabLines(await ok(client, "tabs_list"));
  expect(listed).toStrictEqual([`${cold.json?.tab} [unclaimed] ${url} "Fixture Article"`]);

  const warm = await postOpen(daemon.port, JSON.stringify({ url: `${fixture.url}/doc` }));
  expect(warm.status).toBe(200);
  expect(warm.json).toStrictEqual({ launched: false, running: true });
  expect(tabLines(await ok(client, "tabs_list")).length).toBe(1);

  const own = openedId(await ok(client, "tab_open", { url: fixture.url }));
  expect(own).not.toBe(cold.json?.tab);
  expect(tabLines(await ok(client, "tabs_list")).length).toBe(2);
  await stopDaemon(daemon);
});

test("POST /open without a URL opens the new tab page, and the route keeps the loopback checks", async () => {
  const daemon = await startDaemon(path.join(workDir, "open-blank"));
  expect((await postOpen(daemon.port, "{}", { origin: "https://evil.test" })).status).toBe(403);
  expect((await postOpen(daemon.port, "not json")).status).toBe(400);
  expect((await postOpen(daemon.port, JSON.stringify({ url: 42 }))).status).toBe(400);
  expect((await fetch(`http://127.0.0.1:${daemon.port}/open`)).status).toBe(405);

  const cold = await postOpen(daemon.port, "");
  expect(cold.status).toBe(200);
  expect(cold.json?.launched).toBe(true);
  expect(String(cold.json?.url)).toMatch(/^chrome:\/\/new/);
  const client = await connect(daemon);
  const listed = tabLines(await ok(client, "tabs_list"));
  expect(listed.length).toBe(1);
  expect(listed[0] ?? "").toMatch(new RegExp(`^${cold.json?.tab} \\[unclaimed\\] chrome://new`));
  await stopDaemon(daemon);
});
