import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "../config/config.ts";
import { sleep } from "../shared/async.ts";
import { NoSecretStore } from "../shared/secrets.ts";
import type { ToolDeps } from "../tools/common.ts";
import { callTool, connectInMemory } from "../../tests/mcpHarness.ts";
import { createDeps, createServer, startPruning } from "./setup.ts";

let workDir: string;
let config: Config;
let deps: ToolDeps;
const clients: Client[] = [];

async function connectClient(server: McpServer) {
  const client = await connectInMemory(server, "setup-spec");
  clients.push(client);
  return client;
}

async function toolNames(client: Client) {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-setup-"));
  config = loadConfig({ WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_PASSWORD_STORE: "basic" });
  deps = createDeps(config, new NoSecretStore());
});

afterAll(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await deps.log.close();
  await rm(workDir, { recursive: true, force: true });
});

test("pruning runs at start and again on every interval", async () => {
  let store = 0;
  let log = 0;
  const stop = startPruning(
    {
      store: { prune: async () => void (store += 1) },
      log: { prune: async () => ((log += 1), 0), log: () => undefined },
    },
    40,
  );
  await sleep(150);
  stop();
  expect(store).toBeGreaterThanOrEqual(3);
  expect(log).toBeGreaterThanOrEqual(3);
});

test("a later server built from the same deps lists the same tools as the first", async () => {
  const first = await connectClient(createServer(config, deps));
  const later = await connectClient(createServer(config, deps));
  expect(await toolNames(later)).toStrictEqual(await toolNames(first));
});

test("a later server built from the same deps answers a tool call", async () => {
  await connectClient(createServer(config, deps));
  const later = await connectClient(createServer(config, deps));
  const result = await callTool(later, "tabs");
  expect(result.text).toMatch(/^Browser not started/);
});

test("servers built from the same deps share their tool definitions", () => {
  const registered = spyOn(McpServer.prototype, "registerTool");
  try {
    createServer(config, deps);
    createServer(config, deps);
    const definitions = registered.mock.calls.map((call: unknown[]) => call[1]);
    const first = definitions.slice(0, definitions.length / 2);
    const later = definitions.slice(definitions.length / 2);
    expect(first.length).toBeGreaterThan(0);
    expect(later.filter((definition, index) => definition !== first[index])).toStrictEqual([]);
  } finally {
    registered.mockRestore();
  }
});

const RETIRED_TOOLS =
  /\b(tabs_list|tab_close|tab_open|tab_resize|read_text|fill_form|network_requests|network_export|site_notes|secrets_list|collect_pages|save_page|console_logs|server_log)\b/g;

test("the server instructions name no retired tool", async () => {
  const client = await connectClient(createServer(config, deps));
  expect(client.getInstructions()?.match(RETIRED_TOOLS) ?? []).toStrictEqual([]);
});

test("the server instructions tell code that a structured result arrives as JSON text to parse", async () => {
  const client = await connectClient(createServer(config, deps));
  expect(client.getInstructions()).toContain(
    "When you call these tools from code, a result with structured fields (such as save_pages, read_page or evaluate) arrives as JSON text: parse it, for example with JSON.parse, before reading fields such as dir; other results arrive as plain text. read_page's text is always in content, and evaluate's and run_script's returned value always in value; when it is over max_chars, that field holds a clipped preview, clipped is true, totalChars is the full size and file is the path of the whole result. run_script logs over max_chars beside a value that fits come the same way, in logs.",
  );
});

test("no tool description or parameter text names a retired tool", async () => {
  const client = await connectClient(createServer(config, deps));
  const { tools } = await client.listTools();
  const named = tools.flatMap((tool) =>
    (JSON.stringify([tool.description, tool.inputSchema]).match(RETIRED_TOOLS) ?? []).map(
      (name) => `${tool.name}: ${name}`,
    ),
  );
  expect(named).toStrictEqual([]);
});
