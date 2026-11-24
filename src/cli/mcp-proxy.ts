import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isInitializedNotification,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeStderr } from "../log/stderr.ts";
import { messageOf } from "../shared/errors.ts";

const SESSION_GONE = 404;

const initializeResult = z.object({ protocolVersion: z.string() });

function failedRequest(message: JSONRPCMessage, cause: unknown): JSONRPCMessage | undefined {
  if (!isJSONRPCRequest(message)) return undefined;
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: `The pounce daemon did not answer: ${messageOf(cause)}` },
  };
}

function sessionLost(cause: unknown) {
  return !(cause instanceof StreamableHTTPError) || cause.code === SESSION_GONE;
}

type Handshake = {
  sentInitialize?: JSONRPCRequest;
  initialize?: JSONRPCRequest;
  initialized?: JSONRPCNotification;
  protocolVersion?: string;
};

export async function proxyStdioToDaemon(connect: () => Promise<string>): Promise<void> {
  const client = new StdioServerTransport();
  const handshake: Handshake = {};
  let reconnects = 0;
  let closing = false;
  let recovery: Promise<StreamableHTTPClientTransport> | undefined;
  const replays = new Map<RequestId, () => void>();
  let failReplay: ((error: Error) => void) | undefined;

  function forward(transport: StreamableHTTPClientTransport, message: JSONRPCMessage) {
    const id =
      isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message) ? message.id : undefined;
    const replayAnswered = id === undefined ? undefined : replays.get(id);
    if (id !== undefined && replayAnswered) {
      replays.delete(id);
      replayAnswered();
      return;
    }
    if (isJSONRPCResultResponse(message) && message.id === handshake.sentInitialize?.id) {
      handshake.initialize = handshake.sentInitialize;
      const result = initializeResult.safeParse(message.result);
      if (result.success) {
        handshake.protocolVersion = result.data.protocolVersion;
        transport.setProtocolVersion(result.data.protocolVersion);
      }
    }
    void client.send(message);
  }

  async function open(endpoint: string) {
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    Object.assign(transport, {
      onmessage: (message: JSONRPCMessage) => forward(transport, message),
      onerror: (error: Error) => {
        writeStderr(`pounce mcp: ${error.message}`);
        failReplay?.(error);
      },
    });
    await transport.start();
    return transport;
  }

  async function replayHandshake(transport: StreamableHTTPClientTransport) {
    const { initialize, initialized, protocolVersion } = handshake;
    if (!initialize) return;
    reconnects += 1;
    const id = `pounce-reconnect-${reconnects}`;
    const reply = new Promise<void>((resolve, reject) => {
      replays.set(id, resolve);
      failReplay = reject;
    });
    try {
      await transport.send({ ...initialize, id });
      await reply;
    } finally {
      replays.delete(id);
      failReplay = undefined;
    }
    if (protocolVersion) transport.setProtocolVersion(protocolVersion);
    if (initialized) await transport.send(initialized);
  }

  let daemon = await open(await connect());

  async function reconnect(failed: StreamableHTTPClientTransport) {
    if (daemon !== failed) return daemon;
    recovery ??= (async () => {
      await failed.close().catch(() => undefined);
      const fresh = await open(await connect());
      await replayHandshake(fresh);
      daemon = fresh;
      return fresh;
    })().finally(() => {
      recovery = undefined;
    });
    return recovery;
  }

  async function relay(message: JSONRPCMessage) {
    const transport = daemon;
    try {
      await transport.send(message);
      return;
    } catch (cause) {
      if (closing || !sessionLost(cause)) throw cause;
    }
    const fresh = await reconnect(transport);
    await fresh.send(message);
  }

  const close = async () => {
    if (closing) return;
    closing = true;
    await daemon.terminateSession().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    process.exit(0);
  };

  Object.assign(client, {
    onmessage: (message: JSONRPCMessage) => {
      if (isJSONRPCRequest(message) && message.method === "initialize")
        handshake.sentInitialize = message;
      if (isInitializedNotification(message)) handshake.initialized = message;
      void relay(message).catch((cause: unknown) => {
        const reply = failedRequest(message, cause);
        if (reply) void client.send(reply);
        else writeStderr(`pounce mcp: ${messageOf(cause)}`);
      });
    },
    onclose: () => void close(),
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(signal, () => void close());
  process.stdin.once("end", () => void close());

  await client.start();
}
