import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import path from "node:path";
import { withDeadline } from "./async.ts";
import type { Config } from "./config.ts";
import { activeLogger, type Logger, logEvent } from "./log.ts";
import { SERVER_SCRIPT } from "./version.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const LOG_FLUSH_MS = 2000;
const KEEP_ALIVE_MS = 120_000;

export type DaemonRegistry = {
  pid: number;
  endpoint: string;
  port: number;
  dataDir: string;
  profileDir: string;
  startedAt: string;
  version: string;
};

export type OpenBrowser = (url: string | undefined) => Promise<Record<string, unknown>>;

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

function parseOpenRequest(text: string): { url?: string } | undefined {
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const url = (body as { url?: unknown }).url;
  if (url !== undefined && (typeof url !== "string" || !url.trim())) return undefined;
  return { url: url?.trim() };
}

function isInitialize(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitialize);
  return Boolean(body && typeof body === "object" && "method" in body && body.method === "initialize");
}

export async function startDaemon(
  config: Config,
  createServer: () => McpServer,
  onShutdown: () => Promise<void>,
  onSessionEnd: (sessionId: string) => number | void = () => undefined,
  log: Logger | undefined = activeLogger(),
  openBrowser?: OpenBrowser,
) {
  const sessions = new Map<string, Session>();
  const endSession = (sessionId: string | undefined, reason: string) => {
    if (!sessionId) return;
    const known = sessions.delete(sessionId);
    const orphaned = onSessionEnd(sessionId);
    if (known) logEvent(reason === "idle" ? "session_sweep" : "session_close", { session: sessionId, reason, orphanedTabs: orphaned || undefined, open: sessions.size });
  };

  async function openSession() {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastSeen: Date.now() });
        logEvent("session_open", { session: sessionId, open: sessions.size });
      },
      onsessionclosed: (sessionId) => endSession(sessionId, "client"),
    });
    transport.onclose = () => endSession(transport.sessionId, "transport closed");
    transport.onerror = (error) => {
      console.error("web-agent-mcp transport error:", error.message);
      logEvent("transport_error", { session: transport.sessionId, error: error.message }, "warn");
    };
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
    if (pathname === "/open" && openBrowser) {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        writeJson(response, 405, { error: "Use POST with a JSON body {\"url\"?: string}." });
        return;
      }
      const open = parseOpenRequest(await readBody(request));
      if (!open) {
        writeJson(response, 400, { error: "The body must be empty or a JSON object whose optional url is a non-empty string." });
        return;
      }
      writeJson(response, 200, await openBrowser(open.url));
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
      logEvent("http_error", { method: request.method, path: (request.url ?? "/").split("?")[0], error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, "error");
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  httpServer.keepAliveTimeout = KEEP_ALIVE_MS;
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
  logEvent("daemon_start", { version: config.serverVersion, engine: config.engine, headless: config.headless, port: config.port, pid: process.pid, node: process.version, logLevel: log?.level });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_SESSION_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen < cutoff) {
        endSession(sessionId, "idle");
        void session.transport.close().catch(() => undefined);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const startedAt = Date.now();
    logEvent("daemon_shutdown", { signal, sessions: sessions.size });
    clearInterval(sweep);
    httpServer.close();
    httpServer.closeAllConnections();
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
    await onShutdown();
    if (readRegistry(config)?.pid === process.pid) rmSync(config.registryPath, { force: true });
    logEvent("daemon_stopped", { ms: Date.now() - startedAt });
    if (log) await withDeadline(log.flush(), LOG_FLUSH_MS);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => void shutdown(signal));
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
