import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { NoSecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";

let api: http.Server;
let app: http.Server;
let appUrl: string;
let workDir: string;
let deps: ToolDeps;
let client: Client;
let tab = "";

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function text(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const body = (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
  assert.equal(result.isError === true, false, body);
  return body;
}

before(async () => {
  api = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" }).end(request.url === "/frame" ? "<p>api frame loaded</p>" : "ok");
  });
  const apiPort = await listen(api);
  app = http.createServer((_request, response) => {
    response
      .writeHead(200, { "content-type": "text/html" })
      .end(`<title>Local App</title><iframe title="API frame" src="http://localhost:${apiPort}/frame"></iframe><script>window.apiReach = fetch("http://127.0.0.1:${apiPort}/ping", { mode: "no-cors" }).then(() => "reached", () => "blocked");</script>`);
  });
  appUrl = `http://127.0.0.1:${await listen(app)}/`;
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-local-network-"));
  const config = loadConfig({ WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, new NoSecretStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "local-network", version: "0" });
  await client.connect(clientTransport);
  tab = /Opened (t\d+)/.exec(await text("tab_open", { url: appUrl, wait_until: "load" }))?.[1] ?? "";
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  api?.closeAllConnections();
  app?.closeAllConnections();
  api?.close();
  app?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("a local page can frame another loopback origin", async () => {
  const frame = deps.manager.getTab(tab).page.frames().find((candidate) => candidate.url().includes("/frame"));
  assert.ok(frame, "no frame");
  assert.match(await frame.evaluate(() => document.body.innerText), /api frame loaded/);
});

test("a local page can fetch from another loopback origin", async () => {
  assert.match(await text("evaluate", { tab, expression: "window.apiReach" }), /reached\s*$/);
});
