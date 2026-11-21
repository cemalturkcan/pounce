import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "../config/config.ts";
import { NoSecretStore } from "../shared/secrets.ts";
import { defineTool } from "./common.ts";
import { createDeps } from "../server/setup.ts";
import { connectInMemory } from "../../tests/mcpHarness.ts";

test("a tool's input transforms run once per call", async () => {
  const workDir = await mkdtemp(path.join(tmpdir(), "web-agent-tool-input-"));
  const deps = createDeps(
    loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir }),
    new NoSecretStore(),
  );
  const server = new McpServer({ name: "units", version: "0" });
  let transforms = 0;
  defineTool(server, deps, {
    name: "echo",
    title: "Echo",
    description: "Echo the word.",
    input: {
      word: z.string().transform((word) => {
        transforms += 1;
        return word.toUpperCase();
      }),
    },
    handler: async (input) => input.word,
  });
  const client = await connectInMemory(server, "units");
  await client.callTool({ name: "echo", arguments: { word: "hi" } });
  await client.close();
  await deps.log.close();
  await rm(workDir, { recursive: true, force: true });
  expect(transforms).toBe(1);
});
