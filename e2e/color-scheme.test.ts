import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { createImage } from "../src/pixels.ts";
import { encodePng } from "../src/png.ts";
import { NoSecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";

let workDir: string;
let deps: ToolDeps;
let client: Client;

async function ok(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
  assert.equal(result.isError === true, false, `${name} failed: ${text}`);
  return text;
}

const prefersDark = async (tab: string) => (await ok("evaluate", { tab, expression: "matchMedia('(prefers-color-scheme: dark)').matches" })).split("\n").at(-1);

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-color-"));
  const config = loadConfig({ WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE, WEB_AGENT_DEFAULT_LAUNCH_ARGS: "--force-dark-mode" });
  deps = createDeps(config, new NoSecretStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "color-scheme", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await rm(workDir, { recursive: true, force: true });
});

test("pages follow the system color scheme and emulate overrides it for one tab only", async () => {
  const tab = /Opened (t\d+)/.exec(await ok("tab_open", { url: "data:text/html,<title>Scheme</title><p>scheme</p>" }))?.[1] ?? "";
  const other = /Opened (t\d+)/.exec(await ok("tab_open", { url: "data:text/html,<title>Other</title><p>other</p>" }))?.[1] ?? "";
  assert.equal(await prefersDark(tab), "true");
  await ok("emulate", { tab, color_scheme: "light" });
  assert.equal(await prefersDark(tab), "false");
  assert.equal(await prefersDark(other), "true");
  await ok("emulate", { tab, reset: true });
  assert.equal(await prefersDark(tab), "true");

  const reference = path.join(workDir, "reference.png");
  await writeFile(reference, await encodePng(createImage(400, 300, [255, 255, 255, 255])));
  await ok("compare_design", { tab, reference, model: "none" });
  assert.equal(await prefersDark(tab), "true");
});
