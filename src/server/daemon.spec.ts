import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { PACKAGE_DIR } from "../config/version.ts";
import { isAllowedHost, isAllowedOrigin, isDaemonProcess } from "./daemon.ts";
import { sleep } from "../shared/async.ts";
import { healthy, type SpawnedDaemon, spawnDaemon } from "../../tests/daemon.ts";

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

test("isDaemonProcess requires this package's server.ts and --daemon", async () => {
  expect(isDaemonProcess(process.pid)).toBe(false);
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)", "src/server.ts", "--daemon"],
    { cwd: PACKAGE_DIR, stdio: "ignore" },
  );
  const other = spawn(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)", "/elsewhere/server.ts", "--daemon"],
    { cwd: tmpdir(), stdio: "ignore" },
  );
  try {
    await sleep(200);
    expect(isDaemonProcess(child.pid)).toBe(true);
    expect(isDaemonProcess(other.pid)).toBe(false);
  } finally {
    child.kill();
    other.kill();
  }
});

async function withSleeper(args: string[], check: (pid: number | undefined) => void) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", ...args], {
    cwd: tmpdir(),
    stdio: "ignore",
  });
  try {
    await sleep(200);
    check(child.pid);
  } finally {
    child.kill();
  }
}

test("isDaemonProcess of a compiled server accepts its own executable run with --daemon", async () => {
  await withSleeper(["--daemon"], (pid) =>
    expect(isDaemonProcess(pid, { binary: process.execPath })).toBe(true),
  );
});

test("isDaemonProcess of a compiled server rejects its own executable run without --daemon", async () => {
  await withSleeper([], (pid) =>
    expect(isDaemonProcess(pid, { binary: process.execPath })).toBe(false),
  );
});

test("isDaemonProcess of a compiled server rejects another executable run with --daemon", async () => {
  await withSleeper(["--daemon"], (pid) =>
    expect(isDaemonProcess(pid, { binary: "/usr/bin/env" })).toBe(false),
  );
});

test("isDaemonProcess accepts the server started through a bin link named pounce", async () => {
  const binDir = await mkdtemp(path.join(tmpdir(), "pounce-bin-"));
  try {
    const link = path.join(binDir, "pounce");
    await symlink(path.join(PACKAGE_DIR, "src", "server.ts"), link);
    await withSleeper([link, "--daemon"], (pid) =>
      expect(isDaemonProcess(pid, { script: path.join(PACKAGE_DIR, "src", "server.ts") })).toBe(
        true,
      ),
    );
  } finally {
    await rm(binDir, { recursive: true, force: true });
  }
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
