import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { NoSecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { startFixture, type Fixture } from "./fixture.ts";

let fixture: Fixture;
let workDir: string;
let deps: ToolDeps;
let client: Client;
const stealth = (process.env.WEB_AGENT_ENGINE ?? "patchright") === "patchright";

async function text(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
}

before(async () => {
  process.env.WEB_AGENT_CONSOLE_HOOK = "off";
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-console-"));
  const config = loadConfig({ WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, new NoSecretStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "console", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("console_logs on a site outside the console hook", async (t) => {
  const tab = /Opened (t\d+)/.exec(await text("tab_open", { url: `${fixture.url}/console` }))?.[1] ?? "";
  await new Promise((resolve) => setTimeout(resolve, 500));
  const logs = await text("console_logs", { tab });

  await t.test("still returns what the browser logs about the page", () => {
    assert.match(logs, /Permissions-Policy header: Unrecognized feature: 'fixture-feature'/);
  });

  await t.test("returns the page's own console calls only with the playwright engine", () => {
    assert.equal(/page log line/.test(logs), !stealth, logs);
  });

  await t.test("the description names both sources and where each is captured", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "console_logs")?.description ?? "";
    assert.match(description, /the page's own console calls and uncaught errors are captured only on local development hosts/);
    assert.match(description, /Messages Chrome itself logs about the page, such as a Permissions-Policy header error, are captured on every site/);
  });
});
