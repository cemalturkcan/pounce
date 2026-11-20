import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";

const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY"];
const isLinux = process.platform === "linux";

let workDir: string;
let deps: ToolDeps;
let client: Client;
const savedDisplay = new Map<string, string | undefined>();

async function browserCommandLines(profileDir: string) {
  const lines: string[][] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const raw = await readFile(path.join("/proc", entry, "cmdline"), "utf8").catch(() => "");
    const args = raw.split("\0").filter(Boolean);
    if (args.some((arg) => arg === `--user-data-dir=${profileDir}`) && !args.some((arg) => arg.startsWith("--type="))) lines.push(args);
  }
  return lines;
}

before(async () => {
  if (!isLinux) return;
  for (const key of DISPLAY_KEYS) {
    savedDisplay.set(key, process.env[key]);
    delete process.env[key];
  }
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-sandbox-e2e-"));
  const config = loadConfig({
    HOME: workDir,
    WEB_AGENT_DATA_DIR: workDir,
    WEB_AGENT_HEADLESS: "true",
    WEB_AGENT_PASSWORD_STORE: "basic",
    WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE,
  });
  deps = createDeps(config, { backend: "fake", list: async () => [], get: async () => "" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e-sandbox", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  for (const [key, value] of savedDisplay) if (value !== undefined) process.env[key] = value;
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("Chrome is launched with its sandbox enabled", { skip: !isLinux && "reads /proc" }, async () => {
  const result = await client.callTool({ name: "tab_open", arguments: { url: "about:blank" } });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const browsers = await browserCommandLines(deps.manager.config.profileDir);
  assert.equal(browsers.length, 1, `expected one browser process for ${deps.manager.config.profileDir}`);
  assert.ok(!browsers[0]!.includes("--no-sandbox"), `browser launched with --no-sandbox: ${browsers[0]!.join(" ")}`);
});

test("Chrome is launched with --test-type to hide the unsupported flag infobar", { skip: !isLinux && "reads /proc" }, async () => {
  const result = await client.callTool({ name: "tab_open", arguments: { url: "about:blank" } });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  const browsers = await browserCommandLines(deps.manager.config.profileDir);
  assert.equal(browsers.length, 1, `expected one browser process for ${deps.manager.config.profileDir}`);
  assert.ok(browsers[0]!.includes("--test-type"), `browser launched without --test-type: ${browsers[0]!.join(" ")}`);
});
