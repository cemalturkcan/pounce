import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import path from "node:path";
import { z } from "zod";
import { withDeadline } from "../shared/async.ts";
import type { Config } from "../config/config.ts";
import { parseJson } from "../shared/decode.ts";
import { messageOf } from "../shared/errors.ts";
import { activeLogger, type Logger, logEvent } from "../log/logger.ts";
import { writeStderr } from "../log/stderr.ts";
import { SERVER_SCRIPT } from "../config/version.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const IDLE_SESSION_MS = 12 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const LOG_FLUSH_MS = 2000;
const IDLE_TIMEOUT_S = 120;

const daemonRegistry = z.object({
  pid: z.number(),
  endpoint: z.string(),
  port: z.number(),
  dataDir: z.string(),
  profileDir: z.string(),
  startedAt: z.string(),
  version: z.string(),
});
type DaemonRegistry = z.infer<typeof daemonRegistry>;

const jsonValue = z.json();
type JsonValue = z.infer<typeof jsonValue>;

const openRequest = z.object({ url: z.string().trim().min(1).optional() });
type OpenRequest = z.infer<typeof openRequest>;

const initializeMessage = z.object({ method: z.literal("initialize") });

type OpenBrowser = (url: string | undefined) => Promise<{ readonly [key: string]: JsonValue }>;

type Session = {
  transport: WebStandardStreamableHTTPServerTransport;
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

function readRegistry(config: Config): DaemonRegistry | undefined {
  let text: string;
  try {
    text = readFileSync(config.registryPath, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseJson(text, daemonRegistry);
  return parsed.success ? parsed.data : undefined;
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
    return args.some(
      (arg) => arg.endsWith("server.ts") && sameFile(path.resolve(cwd, arg), script),
    );
  } catch {
    try {
      process.kill(pid, 0);
      return process.platform !== "linux";
    } catch {
      return false;
    }
  }
}

function json(status: number, body: JsonValue, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers });
}

function rpcError(status: number, message: string) {
  return json(status, { jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
  }
}

async function readBody(request: Request) {
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseOpenRequest(text: string): OpenRequest | undefined {
  if (!text.trim()) return {};
  const parsed = parseJson(text, openRequest);
  return parsed.success ? parsed.data : undefined;
}

function isInitialize(body: JsonValue | undefined): boolean {
  if (Array.isArray(body)) return body.some(isInitialize);
  return initializeMessage.safeParse(body).success;
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
    if (known)
      logEvent(reason === "idle" ? "session_sweep" : "session_close", {
        session: sessionId,
        reason,
        orphanedTabs: orphaned || undefined,
        open: sessions.size,
      });
  };

  async function openSession() {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastSeen: Date.now() });
        logEvent("session_open", { session: sessionId, open: sessions.size });
      },
      onsessionclosed: (sessionId) => endSession(sessionId, "client"),
    });
    Object.assign(transport, {
      onclose: () => endSession(transport.sessionId, "transport closed"),
      onerror: (error: Error) => {
        writeStderr(`web-agent-mcp transport error: ${error.message}`);
        logEvent("transport_error", { session: transport.sessionId, error: error.message }, "warn");
      },
    });
    await createServer().connect(transport);
    return transport;
  }

  function refuseForeign(request: Request) {
    const host = request.headers.get("host") ?? undefined;
    const origin = request.headers.get("origin") ?? undefined;
    if (isAllowedHost(host, config.port) && isAllowedOrigin(origin, config.port)) return undefined;
    logEvent("http_forbidden", { method: request.method, host, origin }, "warn");
    return rpcError(
      403,
      "Forbidden: this server only accepts requests addressed to its loopback endpoint.",
    );
  }

  async function handle(request: Request, pathname: string): Promise<Response> {
    if (pathname === "/healthz")
      return json(200, { ok: true, endpoint: config.endpoint, version: config.serverVersion });
    if (pathname === "/open" && openBrowser) {
      if (request.method !== "POST")
        return json(
          405,
          { error: 'Use POST with a JSON body {"url"?: string}.' },
          { allow: "POST" },
        );
      const open = parseOpenRequest(await readBody(request));
      if (!open)
        return json(400, {
          error:
            "The body must be empty or a JSON object whose optional url is a non-empty string.",
        });
      return json(200, await openBrowser(open.url));
    }
    if (pathname !== "/mcp") return new Response(null, { status: 404 });

    const text = await readBody(request);
    const parsed = text ? parseJson(text, jsonValue) : undefined;
    if (parsed && !parsed.success) return rpcError(400, "Bad Request: body is not valid JSON.");
    const body = parsed?.data;

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session)
        return rpcError(404, "Session not found. Reconnect to start a new MCP session.");
      session.lastSeen = Date.now();
      return session.transport.handleRequest(request, { parsedBody: body });
    }
    if (request.method === "POST" && isInitialize(body))
      return (await openSession()).handleRequest(request, { parsedBody: body });
    return rpcError(400, "Bad Request: Mcp-Session-Id header is required.");
  }

  const httpServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_S,
    development: false,
    fetch: async (request) => {
      let pathname: string | undefined;
      try {
        const refusal = refuseForeign(request);
        if (refusal) return refusal;
        pathname = new URL(request.url).pathname;
        return await handle(request, pathname);
      } catch (cause) {
        const tooLarge = cause instanceof BodyTooLargeError;
        const status = tooLarge ? 413 : 500;
        logEvent(
          "http_error",
          {
            method: request.method,
            path: pathname,
            status,
            error: messageOf(cause),
            stack: cause instanceof Error && !tooLarge ? cause.stack : undefined,
          },
          tooLarge ? "warn" : "error",
        );
        return json(status, { error: messageOf(cause) });
      }
    },
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
  writeStderr(`web-agent-mcp daemon running at ${config.endpoint}`);
  logEvent("daemon_start", {
    version: config.serverVersion,
    engine: config.engine,
    headless: config.headless,
    port: config.port,
    pid: process.pid,
    bun: Bun.version,
    logLevel: log?.level,
  });

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
    void httpServer.stop(true);
    await Promise.allSettled([...sessions.values()].map((session) => session.transport.close()));
    await onShutdown();
    if (readRegistry(config)?.pid === process.pid) rmSync(config.registryPath, { force: true });
    logEvent("daemon_stopped", { ms: Date.now() - startedAt });
    if (log) await withDeadline(log.flush(), LOG_FLUSH_MS);
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void shutdown(signal));
}

export function daemonStatus(config: Config) {
  const registry = readRegistry(config);
  return {
    running: isDaemonProcess(registry?.pid),
    endpoint: registry?.endpoint ?? config.endpoint,
    registry,
  };
}

export function stopDaemon(config: Config) {
  const registry = readRegistry(config);
  if (!registry || !isDaemonProcess(registry.pid)) return { stopped: false, reason: "not_running" };
  process.kill(registry.pid, "SIGTERM");
  return { stopped: true, pid: registry.pid };
}
