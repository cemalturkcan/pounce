import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { writeStderr } from "../log/stderr.ts";
import { messageOf } from "../shared/errors.ts";

const initializeResult = z.object({ protocolVersion: z.string() });

function failedRequest(message: JSONRPCMessage, cause: unknown): JSONRPCMessage | undefined {
  if (!isJSONRPCRequest(message)) return undefined;
  return {
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32000, message: `The pounce daemon did not answer: ${messageOf(cause)}` },
  };
}

export async function proxyStdioToDaemon(endpoint: string): Promise<void> {
  const daemon = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await daemon.terminateSession().catch(() => undefined);
    await daemon.close().catch(() => undefined);
    process.exit(0);
  };

  Object.assign(daemon, {
    onmessage: (message: JSONRPCMessage) => {
      if (isJSONRPCResultResponse(message)) {
        const result = initializeResult.safeParse(message.result);
        if (result.success) daemon.setProtocolVersion(result.data.protocolVersion);
      }
      void client.send(message);
    },
    onerror: (error: Error) => writeStderr(`pounce mcp: ${error.message}`),
  });
  Object.assign(client, {
    onmessage: (message: JSONRPCMessage) => {
      void daemon.send(message).catch((cause: unknown) => {
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

  await daemon.start();
  await client.start();
}
