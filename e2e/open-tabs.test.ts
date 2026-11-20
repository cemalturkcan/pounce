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

before(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-open-tabs-"));
  const config = loadConfig({ WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, new NoSecretStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "open-tabs", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("tabs opened concurrently right after launch each load their own page", async () => {
  const routes = ["/counter", "/frames", "/article", "/doc", "/media"];
  const results = await Promise.all(routes.map((route) => client.callTool({ name: "tab_open", arguments: { url: `${fixture.url}${route}` } })));
  const texts = results.map((result) => (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n"));
  const ids = texts.map((text) => /Opened (t\d+)/.exec(text)?.[1]);
  assert.equal(new Set(ids).size, routes.length, texts.join("\n---\n"));
  for (const [index, route] of routes.entries()) {
    assert.match(texts[index] ?? "", new RegExp(`Opened t\\d+: \\S+${route} .*\\(HTTP 200\\)`), texts.join("\n---\n"));
  }
});
