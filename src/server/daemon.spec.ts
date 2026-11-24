import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { PACKAGE_DIR } from "../config/version.ts";
import { loadConfig } from "../config/config.ts";
import { daemonStatus, isAllowedHost, isAllowedOrigin, stopDaemon } from "./daemon.ts";
import { sleep } from "../shared/async.ts";
import {
  freePort,
  healthy,
  runServer,
  SOURCE_SERVER,
  type SpawnedDaemon,
  spawnDaemon,
} from "../../tests/daemon.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const FORBIDDEN_MESSAGE =
  "Forbidden: this server only accepts requests addressed to its loopback endpoint.";

const LogLine = z.object({
  event: z.string(),
  level: z.string(),
  method: z.string().optional(),
  path: z.string().optional(),
  host: z.string().optional(),
  status: z.number().optional(),
});
type LogLine = z.infer<typeof LogLine>;

type RawResponse = { status: number; body: string };

let workDir: string;
let daemon: SpawnedDaemon;
let oversizedPosts = 0;

async function poll<T>(probe: () => Promise<T | undefined>, attempts = 50): Promise<T | undefined> {
  const found = await probe();
  if (found !== undefined || attempts <= 1) return found;
  await sleep(100);
  return poll(probe, attempts - 1);
}

function rawRequest(host: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon.port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`GET /healthz HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
    );
    socket.on("data", (chunk: string) => {
      data += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const split = data.indexOf("\r\n\r\n");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]),
        body: data.slice(split + 4),
      });
    });
  });
}

function oversizedPost() {
  oversizedPosts += 1;
  return fetch(daemon.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(MAX_BODY_BYTES + 1),
  });
}

async function logLines() {
  const dir = path.join(workDir, "logs");
  const names = (await readdir(dir).catch((): string[] => []))
    .filter((name) => name.endsWith(".jsonl"))
    .toSorted();
  const raw = (await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))).join(
    "",
  );
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJsonOrThrow(line, LogLine));
}

function waitForLog(match: (line: LogLine) => boolean) {
  return poll(async () => (await logLines()).find(match));
}

function waitForLogs(match: (line: LogLine) => boolean, count: number) {
  return poll(async () => {
    const found = (await logLines()).filter(match);
    return found.length >= count ? found : undefined;
  });
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-daemon-spec-"));
  daemon = await spawnDaemon(workDir);
  expect(await healthy(daemon.port), daemon.stderr()).toBe(true);
});

afterAll(async () => {
  await daemon?.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe("a Host header that is not a valid URL authority", () => {
  for (const host of ["a b", "", "[::1", "127.0.0.1:PORT@evil"]) {
    test(`is refused like a foreign host: ${JSON.stringify(host)}`, async () => {
      const response = await rawRequest(host.replace("PORT", String(daemon.port)));

      expect(response.status).toBe(403);
    });
  }

  test("gets the JSON-RPC refusal instead of an error page", async () => {
    const response = await rawRequest("a b");

    expect(parseJsonOrThrow(response.body, z.json())).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: FORBIDDEN_MESSAGE },
      id: null,
    });
  });

  test("is logged as a refused request", async () => {
    const host = `[::1-${crypto.randomUUID()}`;
    await rawRequest(host);

    const line = await waitForLog(
      (entry) => entry.event === "http_forbidden" && entry.host === host,
    );
    expect(line).toMatchObject({ level: "warn", method: "GET" });
  }, 15_000);
});

describe("a request body over the size limit", () => {
  test("is answered with 413", async () => {
    const response = await oversizedPost();

    expect(response.status).toBe(413);
  });

  test("is logged with status 413", async () => {
    await oversizedPost();

    const lines = await waitForLogs((entry) => entry.event === "http_error", oversizedPosts);
    expect(lines?.length).toBe(oversizedPosts);
    expect(lines?.at(-1)).toMatchObject({
      level: "warn",
      method: "POST",
      path: "/mcp",
      status: 413,
    });
  }, 15_000);
});

async function withSleeper(check: (pid: number) => Promise<void>) {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)", "src/server.ts", "--daemon"],
    { cwd: PACKAGE_DIR, stdio: "ignore" },
  );
  try {
    await sleep(200);
    await check(child.pid ?? 0);
  } finally {
    child.kill();
  }
}

async function configWithRegistry(pid: number, port: number) {
  const dataDir = await mkdtemp(path.join(workDir, "registry-"));
  const config = loadConfig({
    WEB_AGENT_DAEMON_DATA_DIR: dataDir,
    WEB_AGENT_DAEMON_PORT: String(port),
  });
  await writeFile(
    config.registryPath,
    JSON.stringify({
      pid,
      endpoint: config.endpoint,
      port,
      dataDir,
      profileDir: config.profileDir,
      startedAt: new Date().toISOString(),
      version: config.serverVersion,
    }),
  );
  return config;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("daemonStatus says running for the daemon its registry names", async () => {
  const config = loadConfig({
    WEB_AGENT_DAEMON_DATA_DIR: workDir,
    WEB_AGENT_DAEMON_PORT: String(daemon.port),
  });

  expect((await daemonStatus(config)).running).toBe(true);
});

test("daemonStatus says not running when the registered port answers with another pid", async () => {
  await withSleeper(async (pid) => {
    const config = await configWithRegistry(pid, daemon.port);

    expect((await daemonStatus(config)).running).toBe(false);
  });
});

test("daemonStatus says not running when nothing answers on the registered port", async () => {
  await withSleeper(async (pid) => {
    const config = await configWithRegistry(pid, freePort());

    expect((await daemonStatus(config)).running).toBe(false);
  });
});

test("stopDaemon leaves the registered pid alive when the registered port answers with another pid", async () => {
  await withSleeper(async (pid) => {
    await stopDaemon(await configWithRegistry(pid, daemon.port));
    await sleep(200);

    expect(isAlive(pid)).toBe(true);
  });
});

async function withStalledListener(check: (pid: number, port: number) => Promise<void>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      'const l = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(l.port); setInterval(() => {}, 100000);',
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  try {
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    await check(child.pid, Number(new TextDecoder().decode(value).trim()));
  } finally {
    child.kill();
  }
}

describe("a registered daemon that holds its port but does not answer", () => {
  test("daemonStatus says it is not responding", async () => {
    await withStalledListener(async (pid, port) => {
      expect((await daemonStatus(await configWithRegistry(pid, port))).state).toBe(
        "not responding",
      );
    });
  });

  test("daemonStatus does not call it running", async () => {
    await withStalledListener(async (pid, port) => {
      expect((await daemonStatus(await configWithRegistry(pid, port))).running).toBe(false);
    });
  });

  test("a second daemon refuses to start", async () => {
    await withStalledListener(async (pid, port) => {
      const config = await configWithRegistry(pid, port);
      const result = await runServer(SOURCE_SERVER, config.dataDir, port, ["--daemon"]);

      expect(result.stderr).toContain(`(pid ${pid}) is not responding`);
    });
  });

  test("import-profile refuses to replace the profile", async () => {
    await withStalledListener(async (pid, port) => {
      const config = await configWithRegistry(pid, port);
      const source = await mkdtemp(path.join(workDir, "source-"));
      await mkdir(path.join(source, "Default"));
      const result = await runServer(SOURCE_SERVER, config.dataDir, port, [
        "--import-profile",
        "--from",
        source,
      ]);

      expect(result.stderr).toContain("daemon is running");
    });
  });
});

test("daemonStatus says stopped when nothing answers on the registered port", async () => {
  await withSleeper(async (pid) => {
    const config = await configWithRegistry(pid, freePort());

    expect((await daemonStatus(config)).state).toBe("stopped");
  });
});

describe("a second daemon on the data dir of a running one", () => {
  let second: SpawnedDaemon;

  beforeAll(async () => {
    second = await spawnDaemon(workDir);
  });

  afterAll(async () => {
    await second?.stop();
  });

  test("refuses to start", () => {
    expect(second.process.exitCode, second.stderr()).toBe(1);
  });

  test("says which daemon is running", () => {
    expect(second.stderr()).toContain(`already running at ${daemon.endpoint.href}`);
  });

  test("leaves the registry naming the running daemon", async () => {
    const registry = parseJsonOrThrow(
      await readFile(path.join(workDir, "daemon.json"), "utf8"),
      z.object({ pid: z.number() }),
    );

    expect(registry.pid).toBe(daemon.process.pid ?? 0);
  });
});

describe("a second daemon on the port of a running one", () => {
  let second: SpawnedDaemon;

  beforeAll(async () => {
    second = await spawnDaemon(await mkdtemp(path.join(workDir, "other-")), {
      WEB_AGENT_DAEMON_PORT: String(daemon.port),
    });
  });

  afterAll(async () => {
    await second?.stop();
  });

  test("refuses to start", () => {
    expect(second.process.exitCode, second.stderr()).toBe(1);
  });

  test("says the port is in use", () => {
    expect(second.stderr()).toContain(`Is port ${daemon.port} in use?`);
  });
});

test("host and origin validation only accepts the loopback endpoint", () => {
  expect(isAllowedHost("127.0.0.1:29741", 29741)).toBe(true);
  expect(isAllowedHost("localhost:29741", 29741)).toBe(true);
  expect(isAllowedHost("evil.example", 29741)).toBe(false);
  expect(isAllowedHost("evil.example:29741", 29741)).toBe(false);
  expect(isAllowedHost("127.0.0.1:8080", 29741)).toBe(false);
  expect(isAllowedHost(undefined, 29741)).toBe(false);
  expect(isAllowedOrigin(undefined, 29741)).toBe(true);
  expect(isAllowedOrigin("http://127.0.0.1:29741", 29741)).toBe(true);
  expect(isAllowedOrigin("https://evil.example", 29741)).toBe(false);
  expect(isAllowedOrigin("null", 29741)).toBe(false);
});
