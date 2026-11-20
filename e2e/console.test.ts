import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
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
    assert.match(description, /Messages Chrome itself logs about the page, such as a Permissions-Policy header error, are captured on every site/);
  });

  await t.test("the description states where the patchright engine captures page console calls", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "console_logs")?.description ?? "";
    assert.match(description, /With the default patchright engine, the page's own console calls and uncaught errors are captured only on local development hosts \(localhost, 127\.0\.0\.1, \*\.localhost, \*\.test\) unless the server runs with WEB_AGENT_CONSOLE_HOOK=all \(every site\) or off \(none\)/);
  });

  await t.test("the description states that the playwright engine captures page console calls everywhere", async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "console_logs")?.description ?? "";
    assert.match(description, /With WEB_AGENT_ENGINE=playwright they are captured on every site and WEB_AGENT_CONSOLE_HOOK has no effect/);
  });
});

for (const hook of [undefined, "local", "all", "off"]) {
  describe(`console_logs with the console hook ${hook ?? "at its default"}`, () => {
    let hookDir: string;
    let hookDeps: ToolDeps;
    let hookClient: Client;
    const capturesPageCalls = !stealth || hook !== "off";

    async function hookText(name: string, args: Record<string, unknown>) {
      const result = await hookClient.callTool({ name, arguments: args });
      return (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n");
    }

    before(async () => {
      if (hook === undefined) delete process.env.WEB_AGENT_CONSOLE_HOOK;
      else process.env.WEB_AGENT_CONSOLE_HOOK = hook;
      hookDir = await mkdtemp(path.join(tmpdir(), "web-agent-console-hook-"));
      const config = loadConfig({ WEB_AGENT_DATA_DIR: hookDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
      hookDeps = createDeps(config, new NoSecretStore());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await createServer(config, hookDeps).connect(serverTransport);
      hookClient = new Client({ name: "console-hook", version: "0" });
      await hookClient.connect(clientTransport);
    });

    after(async () => {
      await hookClient?.close();
      await hookDeps?.manager.shutdown();
      await rm(hookDir, { recursive: true, force: true });
    });

    test("records each console call and uncaught error once", { skip: !capturesPageCalls }, async (t) => {
      const tab = /Opened (t\d+)/.exec(await hookText("tab_open", { url: `${fixture.url}/console` }))?.[1] ?? "";
      await new Promise((resolve) => setTimeout(resolve, 500));
      const logs = await hookText("console_logs", { tab });

      await t.test("the console call appears once", () => {
        assert.equal(logs.match(/page log line/g)?.length, 1, logs);
      });

      await t.test("the uncaught error appears once", () => {
        assert.equal(logs.match(/uncaught page error/g)?.length, 1, logs);
      });
    });
  });
}
