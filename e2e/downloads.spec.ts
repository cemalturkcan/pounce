import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../src/config/config.ts";
import { repeatUntil } from "../src/shared/async.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import { type Fixture, startFixture } from "./fixture.ts";

const chosenFolder = (config: Config) => path.join(config.dataDir, "chosen-downloads");

const mcp = useMcpHarness({
  name: "downloads",
  prepare: async (config) => {
    await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
    await writeFile(
      path.join(config.profileDir, "Default", "Preferences"),
      JSON.stringify({ download: { default_directory: chosenFolder(config) } }),
    );
  },
});
let fixture: Fixture | undefined;

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

function fixtureUrl() {
  if (!fixture) throw new Error("The downloads fixture has not started");
  return fixture.url;
}

async function contentSoon(file: string) {
  return repeatUntil(
    () =>
      readFile(file, "utf8").then(
        (text) => text || undefined,
        () => undefined,
      ),
    {
      delayMs: () => 100,
      giveUp: (attempts) => attempts >= 50,
    },
  );
}

test("a download in the user's own tab lands in Chrome's download folder with its real name", async () => {
  const opened = /Opened (t\d+)/.exec(await mcp.ok("navigate", { url: "about:blank" }))?.[1] ?? "";
  const user = await mcp.deps.manager.getTab(opened).page.context().newPage();
  await user.goto(fixtureUrl());
  await user.click("#download");
  expect(await contentSoon(path.join(chosenFolder(mcp.config), "report.csv"))).toBe("a,b\n1,2\n");
});

test("a download in an agent tab lands in the agent subfolder of the download folder", async () => {
  const tab = /Opened (t\d+)/.exec(await mcp.ok("navigate", { url: fixtureUrl() }))?.[1] ?? "";
  const text = await mcp.ok("click", { tab, target: "#download" });
  const reported =
    /download saved to (.+)$/m.exec(text)?.[1] ??
    /download saved to (.+)$/m.exec(await mcp.ok("press", { tab, key: "Shift" }))?.[1];
  expect(reported).toBe(path.join(chosenFolder(mcp.config), "agent", "report.csv"));
});
