import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../config/config.ts";
import { PACKAGE_DIR } from "../config/version.ts";
import { daemonStatus, stopDaemon } from "../server/daemon.ts";
import { ensureDaemon } from "./daemon-control.ts";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { repeatUntil } from "../shared/async.ts";
import { freePort, type SpawnedDaemon, spawnDaemon } from "../../tests/daemon.ts";
import type { Config } from "../config/config.ts";

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

async function isolatedEnv() {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-proxy-"));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    WEB_AGENT_DAEMON_DATA_DIR: path.join(home, "data"),
    WEB_AGENT_DAEMON_PORT: String(freePort()),
    WEB_AGENT_HEADLESS: "true",
    WEB_AGENT_SECRETS: "none",
    WEB_AGENT_PASSWORD_STORE: "basic",
  };
  const config = loadConfig(env);
  cleanups.push(async () => {
    await stopDaemon(config);
  });
  return { env, config };
}

type ProxyEnv = Awaited<ReturnType<typeof isolatedEnv>>["env"];

async function proxyClient(env: ProxyEnv) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.ts", "mcp"],
    cwd: PACKAGE_DIR,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "proxy-spec", version: "0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function sessionEvents(dataDir: string) {
  const dir = path.join(dataDir, "logs");
  const names = await readdir(dir).catch((): string[] => []);
  const text = (
    await Promise.all(
      names
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFile(path.join(dir, name), "utf8")),
    )
  ).join("");
  return text.split("\n").filter((line) => line.includes('"session_'));
}

describe("pounce mcp with the daemon running", () => {
  let daemon: SpawnedDaemon;
  let env: ProxyEnv;

  test("lists the daemon's tools", async () => {
    ({ env } = await isolatedEnv());
    daemon = await spawnDaemon(env.WEB_AGENT_DAEMON_DATA_DIR, env);
    cleanups.push(() => daemon.stop());
    const client = await proxyClient(env);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("navigate");
  }, 40_000);

  test("is served by the running daemon, not a new one", async () => {
    const config = loadConfig(env);

    expect((await daemonStatus(config)).registry?.pid).toBe(daemon.process.pid ?? -1);
  });
});

describe("pounce mcp with no daemon", () => {
  test("starts the shared daemon", async () => {
    const { env, config } = await isolatedEnv();
    await proxyClient(env);

    expect((await daemonStatus(config)).running).toBe(true);
  }, 40_000);
});

describe("pounce mcp when its client goes away", () => {
  test("ends its daemon session", async () => {
    const { env, config } = await isolatedEnv();
    const client = await proxyClient(env);
    await client.close();
    const closed = await repeatUntil(
      async () =>
        (await sessionEvents(config.dataDir)).some(
          (line) => line.includes('"session_close"') && line.includes('"reason":"client"'),
        )
          ? true
          : undefined,
      { delayMs: () => 100, giveUp: (made) => made >= 50 },
    );

    expect(closed).toBe(true);
  }, 40_000);
});

describe("two pounce mcp started at once with no daemon", () => {
  test("both are served by one daemon", async () => {
    const { env } = await isolatedEnv();
    const clients = await Promise.all([proxyClient(env), proxyClient(env)]);
    const listed = await Promise.all(
      clients.map(async (client) => (await client.listTools()).tools.length > 0),
    );

    expect(listed).toStrictEqual([true, true]);
  }, 60_000);
});

async function stopAndWait(config: Config) {
  await stopDaemon(config);
  await repeatUntil(
    async () => ((await daemonStatus(config)).state === "stopped" ? true : undefined),
    { delayMs: () => 100, giveUp: (made) => made >= 100 },
  );
}

describe("pounce mcp across a daemon restart", () => {
  test("answers the next request without restarting the client", async () => {
    const { env, config } = await isolatedEnv();
    const client = await proxyClient(env);
    await client.listTools();
    await stopAndWait(config);
    await ensureDaemon(config, env);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("navigate");
  }, 60_000);
});

describe("pounce mcp after its daemon stopped", () => {
  test("starts the daemon again and answers the next request", async () => {
    const { env, config } = await isolatedEnv();
    const client = await proxyClient(env);
    await client.listTools();
    await stopAndWait(config);
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toContain("navigate");
  }, 60_000);
});

describe("pounce mcp when another server took the daemon's port", () => {
  test("answers the request with an error that says so", async () => {
    const { env, config } = await isolatedEnv();
    const client = await proxyClient(env);
    await client.listTools();
    await stopAndWait(config);
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: config.port,
      fetch: () => new Response("gone", { status: 404 }),
    });
    cleanups.push(() => squatter.stop(true));

    await expect(client.listTools()).rejects.toThrow(/pounce daemon/);
  }, 60_000);
});

describe("pounce mcp reconnecting to a new daemon session", () => {
  test("passes the client only the replies to its own requests", async () => {
    const { env, config } = await isolatedEnv();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["src/server.ts", "mcp"],
      cwd: PACKAGE_DIR,
      env,
      stderr: "ignore",
    });
    const seen: JSONRPCMessage[] = [];
    Object.assign(transport, { onmessage: (message: JSONRPCMessage) => seen.push(message) });
    await transport.start();
    cleanups.push(() => transport.close());
    const answeredTo = (id: number) =>
      repeatUntil(
        async () =>
          seen.some((message) => "id" in message && message.id === id) ? true : undefined,
        { delayMs: () => 50, giveUp: (made) => made >= 400 },
      );
    await transport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "proxy-spec", version: "0" },
      },
    });
    await answeredTo(1);
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await stopAndWait(config);
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await answeredTo(2);
    await Bun.sleep(500);

    expect(seen.map((message) => ("id" in message ? message.id : undefined))).toStrictEqual([1, 2]);
  }, 60_000);
});
