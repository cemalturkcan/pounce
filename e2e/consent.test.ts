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
const roots: string[] = [];

before(async () => {
  fixture = await startFixture();
});

after(async () => {
  await fixture?.close();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

type Server = { call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>; ok: (name: string, args?: Record<string, unknown>) => Promise<string>; deps: ToolDeps };

async function withServer(mode: string | undefined, run: (server: Server) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-consent-"));
  roots.push(root);
  const config = loadConfig({ WEB_AGENT_DATA_DIR: root, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE, ...(mode ? { WEB_AGENT_AUTO_CONSENT: mode } : {}) });
  const deps = createDeps(config, new NoSecretStore());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  const client = new Client({ name: "consent", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as { text?: string }[]).map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
  };
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await call(name, args);
    assert.equal(result.isError, false, `${name} failed: ${result.text}`);
    return result.text;
  };
  try {
    await run({ call, ok, deps });
  } finally {
    await client.close();
    await deps.manager.shutdown();
  }
}

const opened = (text: string) => /Opened (t\d+)/.exec(text)?.[1] ?? "";

async function stateOf(server: Server, tab: string, id = "consent-state") {
  return (await server.ok("evaluate", { tab, expression: `document.getElementById(${JSON.stringify(id)}).textContent` })).split("\n").at(-1);
}

async function eventually(read: () => Promise<string | undefined>, expected: string) {
  let value: string | undefined;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    value = await read();
    if (value === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(value, expected);
}

test("cookie banners are accepted automatically by default", async () => {
  await withServer(undefined, async (server) => {
    const english = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    assert.match(english, /^Event: accepted the cookie banner \(Accept all\)$/m);
    await eventually(() => stateOf(server, opened(english)), "accepted");

    const turkish = await server.ok("tab_open", { url: `${fixture.url}/consent/tr` });
    await eventually(() => stateOf(server, opened(turkish)), "accepted");

    const framed = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/frame` }));
    await eventually(() => stateOf(server, framed), "accepted");

    const delayed = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/delayed` }));
    await eventually(() => stateOf(server, delayed), "accepted");
    assert.match(await server.ok("scroll", { tab: delayed, direction: "down" }), /Earlier event .*: accepted the cookie banner \(OK\)/);

    const navigated = await server.ok("navigate", { tab: framed, url: `${fixture.url}/consent/en` });
    assert.match(navigated, /^Event: accepted the cookie banner \(Accept all\)$/m);

    const collected = await server.ok("collect_pages", { urls: [`${fixture.url}/consent/tr`], include: ["text"] });
    assert.match(collected, /accepted/);
  });
});

test("automatic consent never commits an order and leaves other dialogs alone", async () => {
  await withServer(undefined, async (server) => {
    const tab = opened(await server.ok("tab_open", { url: `${fixture.url}/checkout` }));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(await stateOf(server, tab, "order-state"), "pending");
    const text = await server.ok("dismiss_overlays", { tab });
    assert.match(text, /closed by clicking "Vazgeç" \(cancel\)/);
    assert.doesNotMatch(text, /onayla|payment/i);
    assert.equal(await stateOf(server, tab, "order-state"), "dialog dismissed");
  });
});

test("WEB_AGENT_AUTO_CONSENT=reject rejects and off leaves the banner", async () => {
  await withServer("reject", async (server) => {
    const text = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    assert.match(text, /^Event: rejected the cookie banner \(Reject all\)$/m);
    await eventually(() => stateOf(server, opened(text)), "rejected");
  });
  await withServer("off", async (server) => {
    const text = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    const tab = opened(text);
    assert.doesNotMatch(text, /cookie banner/);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(await stateOf(server, tab), "pending");
    assert.match(await server.ok("dismiss_overlays", { tab, consent: "reject" }), /Clicked "Reject all" \(reject\)/);
    const again = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/tr` }));
    assert.match(await server.ok("dismiss_overlays", { tab: again }), /Clicked "Tümünü kabul et" \(accept\)/);
    assert.equal(await stateOf(server, again), "accepted");
  });
});

test("automatic consent never acts on a tab the session does not own", async () => {
  await withServer(undefined, async (server) => {
    const context = await server.deps.manager.ensureContext();
    const page = await context.newPage();
    const tab = server.deps.manager.tabOf(page)?.id ?? "";
    await server.ok("navigate", { tab, url: `${fixture.url}/consent/en` });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(await stateOf(server, tab), "pending");
  });
});
