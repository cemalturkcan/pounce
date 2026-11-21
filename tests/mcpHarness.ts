import { afterAll, beforeAll, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { z } from "zod";
import type { AskAdapter } from "../src/ask/adapter.ts";
import { type Config, loadConfig } from "../src/config/config.ts";
import { createDeps, createServer } from "../src/server/setup.ts";
import type { Notifier } from "../src/shared/notify.ts";
import { NoSecretStore, type SecretStore } from "../src/shared/secrets.ts";
import type { ToolDeps } from "../src/tools/common.ts";

export type ToolArgs = NonNullable<Parameters<Client["callTool"]>[0]["arguments"]>;

const contentSchema = z.array(
  z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional() }),
);

export type Content = z.infer<typeof contentSchema>[number];
export type CallResult = { text: string; isError: boolean; content: Content[] };

export async function callTool(
  client: Client,
  name: string,
  args: ToolArgs = {},
  options?: RequestOptions,
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args }, undefined, options);
  const content = contentSchema.parse(result.content);
  return {
    text: content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
    isError: result.isError === true,
    content,
  };
}

export async function okTool(
  client: Client,
  name: string,
  args: ToolArgs = {},
  options?: RequestOptions,
) {
  const result = await callTool(client, name, args, options);
  expect(result.isError, `${name} failed: ${result.text}`).toBe(false);
  return result.text;
}

export async function connectInMemory(server: McpServer, name: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name, version: "0" });
  await client.connect(clientTransport);
  return client;
}

export type HarnessSetup = {
  name: string;
  env?: NodeJS.ProcessEnv;
  secrets?: SecretStore;
  askAdapter?: AskAdapter;
  notify?: Notifier;
  prepare?: (config: Config) => Promise<void>;
};

export type McpHarness = {
  workDir: string;
  config: Config;
  deps: ToolDeps;
  client: Client;
  call: (name: string, args?: ToolArgs, options?: RequestOptions) => Promise<CallResult>;
  ok: (name: string, args?: ToolArgs, options?: RequestOptions) => Promise<string>;
  close: () => Promise<void>;
};

export async function startMcpHarness(setup: HarnessSetup): Promise<McpHarness> {
  const workDir = await mkdtemp(path.join(tmpdir(), `web-agent-${setup.name}-`));
  const config = loadConfig({
    HOME: workDir,
    WEB_AGENT_DATA_DIR: workDir,
    WEB_AGENT_HEADLESS: "true",
    WEB_AGENT_PASSWORD_STORE: "basic",
    WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE,
    ...setup.env,
  });
  await setup.prepare?.(config);
  const deps = createDeps(
    config,
    setup.secrets ?? new NoSecretStore(),
    setup.askAdapter,
    setup.notify,
  );
  const client = await connectInMemory(createServer(config, deps), setup.name);
  return {
    workDir,
    config,
    deps,
    client,
    call: (name, args, options) => callTool(client, name, args, options),
    ok: (name, args, options) => okTool(client, name, args, options),
    close: async () => {
      await client.close();
      await deps.manager.shutdown();
      await deps.log.close();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

export function useMcpHarness(setup: HarnessSetup): McpHarness {
  let current: McpHarness | undefined;
  const started = () => {
    if (!current) throw new Error(`The ${setup.name} MCP harness has not started`);
    return current;
  };
  beforeAll(async () => {
    current = await startMcpHarness(setup);
  });
  afterAll(async () => {
    await current?.close();
  });
  return {
    get workDir() {
      return started().workDir;
    },
    get config() {
      return started().config;
    },
    get deps() {
      return started().deps;
    },
    get client() {
      return started().client;
    },
    call: (name, args, options) => started().call(name, args, options),
    ok: (name, args, options) => started().ok(name, args, options),
    close: () => started().close(),
  };
}
