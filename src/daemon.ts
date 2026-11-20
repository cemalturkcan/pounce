import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import path from "node:path";
import type { Config } from "./config.ts";
import { SERVER_SCRIPT } from "./version.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

export type DaemonRegistry = {
  pid: number;
  endpoint: string;
  port: number;
  dataDir: string;
  profileDir: string;
  startedAt: string;
  version: string;
};

type Session = {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
};

export function isAllowedHost(hostHeader: string | undefined, port: number) {
  if (!hostHeader) return false;
  return LOOPBACK_HOSTS.some((host) => hostHeader === `${host}:${port}`);
}

export function isAllowedOrigin(origin: string | undefined, port: number) {
  if (origin === undefined) return true;
  return LOOPBACK_HOSTS.some((host) => origin === `http://${host}:${port}`);
}

export function readRegistry(config: Config): DaemonRegistry | undefined {
  try {
    return JSON.parse(readFileSync(config.registryPath, "utf8")) as DaemonRegistry;
  } catch {
    return undefined;
  }
}

function sameFile(candidate: string, expected: string) {
  try {
    return realpathSync(candidate) === realpathSync(expected);
  } catch {
    return false;
  }
}

export function isDaemonProcess(pid: number | undefined, script = SERVER_SCRIPT) {
  if (!pid || pid <= 0) return false;
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (!args.includes("--daemon")) return false;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    return args.some((arg) => arg.endsWith("server.ts") && sameFile(path.resolve(cwd, arg), script));
  } catch {
    try {
      process.kill(pid, 0);
      return process.platform !== "linux";
    } catch {
      return false;
    }
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function rpcError(response: ServerResponse, status: number, message: string) {
  writeJson(response, status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function isInitialize(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitialize);
  return Boolean(body && typeof body === "object" && "method" in body && body.method === "initialize");
}

export async function startDaemon(
  config: Config,
  createServer: () => McpServer,
  onShutdown: () => Promise<void>,
  onSessionEnd: (sessionId: string) => void = () => undefined,
) {
  const sessions = new Map<string, Session>();
  const endSession = (sessionId: string | undefined) => {
    if (!sessionId) return;
    sessions.delete(sessionId);
    onSessionEnd(sessionId);
  };

  async function openSession() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastSeen: Date.now() });
      },
      onsessionclosed: (sessionId) => endSession(sessionId),
    });
    transport.onclose = () => endSession(transport.sessionId);
    transport.onerror = (error) => console.error("web-agent-mcp transport error:", error.message);
    await createServer().connect(transport);
    return transport;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    if (!isAllowedHost(request.headers.host, config.port) || !isAllowedOrigin(request.headers.origin, config.port)) {
      rpcError(response, 403, "Forbidden: this server only accepts requests addressed to its loopback endpoint.");
      return;
    }

    const pathname = (request.url ?? "/").split("?")[0];
    if (pathname === "/healthz") {
      writeJson(response, 200, { ok: true, endpoint: config.endpoint, version: config.serverVersion });
      return;
    }
    if (pathname !== "/mcp") {
      response.writeHead(404).end();
      return;
    }

    const text = await readBody(request);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      rpcError(response, 400, "Bad Request: body is not valid JSON.");
      return;
    }

    const header = request.headers["mcp-session-id"];
    const sessionId = Array.isArray(header) ? header[0] : header;
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        rpcError(response, 404, "Session not found. Reconnect to start a new MCP session.");
        return;
      }
      session.lastSeen = Date.now();
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if (request.method === "POST" && isInitialize(body)) {
      await (await openSession()).handleRequest(request, response, body);
      return;
    }
    rpcError(response, 400, "Bad Request: Mcp-Session-Id header is required.");
  }

  const httpServer = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  mkdirSync(config.dataDir, { recursive: true });
  const registry: DaemonRegistry = {
    pid: process.pid,
    endpoint: config.endpoint,
    port: config.port,
    dataDir: config.dataDir,
    profileDir: config.profileDir,
    startedAt: new Date().toISOString(),
    version: config.serverVersion,
  };
  writeFileSync(config.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.error(`web-agent-mcp daemon running at ${config.endpoint}`);

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_SESSION_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen < cutoff) {
        endSession(sessionId);
        void session.transport.close().catch(() => undefined);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    httpServer.close();
    httpServer.closeAllConnections();
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
    await onShutdown();
    if (readRegistry(config)?.pid === process.pid) rmSync(config.registryPath, { force: true });
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void shutdown());
}

export function daemonStatus(config: Config) {
  const registry = readRegistry(config);
  return { running: isDaemonProcess(registry?.pid), endpoint: registry?.endpoint ?? config.endpoint, registry };
}

export function stopDaemon(config: Config) {
  const registry = readRegistry(config);
  if (!registry || !isDaemonProcess(registry.pid)) return { stopped: false, reason: "not_running" };
  process.kill(registry.pid, "SIGTERM");
  return { stopped: true, pid: registry.pid };
}
