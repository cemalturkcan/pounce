import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext } from "playwright-core";
import { launchOptions, loadChromium } from "../src/browser/launch.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import { RawCdp } from "../tests/rawCdp.ts";
import { HELD_DOCUMENT_MS } from "./fixture-edge.ts";
import { startFixture, type Fixture } from "./fixture.ts";

const DEBUG_PORT_ARG = "--remote-debugging-port=0";

let fixture: Fixture;
const mcp = useMcpHarness({
  name: "user-tabs",
  env: { WEB_AGENT_DEFAULT_LAUNCH_ARGS: DEBUG_PORT_ARG },
});

async function heldCommitMs(cdp: RawCdp) {
  const tab = await cdp.openUserTab("chrome://newtab/");
  const ms = await cdp.commitMs(tab, `${fixture.url}/held-document`);
  await cdp.closeTab(tab);
  return ms;
}

async function baselineCommitMs() {
  const profileDir = await mkdtemp(path.join(tmpdir(), "web-agent-user-tabs-baseline-"));
  const options = launchOptions(mcp.config);
  let context: BrowserContext | undefined;
  let cdp: RawCdp | undefined;
  try {
    context = await (
      await loadChromium(mcp.config.engine)
    ).launchPersistentContext(profileDir, {
      ...options,
      args: [...options.args, DEBUG_PORT_ARG],
    });
    cdp = await RawCdp.fromProfile(profileDir);
    return await heldCommitMs(cdp);
  } finally {
    cdp?.close();
    await context?.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

let daemonCdp: RawCdp;

async function visitCachedScript() {
  const tab = await daemonCdp.openUserTab("chrome://newtab/");
  await daemonCdp.commitMs(tab, `${fixture.url}/cached-script`);
  await daemonCdp.closeTab(tab);
}

beforeAll(async () => {
  fixture = await startFixture();
  await mcp.deps.manager.ensureContext();
  daemonCdp = await RawCdp.fromProfile(mcp.config.profileDir);
});

afterAll(async () => {
  daemonCdp?.close();
  await fixture?.close();
});

describe("a tab the user opens in the daemon's Chrome", () => {
  test("shows a streamed page as soon as Chrome without the daemon does", async () => {
    const baseline = await baselineCommitMs();
    const withDaemon = await heldCommitMs(daemonCdp);
    expect(withDaemon - baseline).toBeLessThan(HELD_DOCUMENT_MS / 2);
  });

  test("loads a cached script from the HTTP cache on a repeat visit", async () => {
    await visitCachedScript();
    await visitCachedScript();
    expect(fixture.requests("/cached.js")).toBe(1);
  });
});
