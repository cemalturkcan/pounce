import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type McpHarness, startMcpHarness } from "../tests/mcpHarness.ts";

const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY"];
const isLinux = process.platform === "linux";

let mcp: McpHarness;
const savedDisplay = new Map<string, string | undefined>();

async function browserCommandLines(profileDir: string) {
  const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  const commandLines = await Promise.all(
    pids.map(async (pid) =>
      (await readFile(path.join("/proc", pid, "cmdline"), "utf8").catch(() => ""))
        .split("\0")
        .filter(Boolean),
    ),
  );
  return commandLines.filter(
    (args) =>
      args.some((arg) => arg === `--user-data-dir=${profileDir}`) &&
      !args.some((arg) => arg.startsWith("--type=")),
  );
}

beforeAll(async () => {
  if (!isLinux) return;
  for (const key of DISPLAY_KEYS) {
    savedDisplay.set(key, process.env[key]);
    delete process.env[key];
  }
  mcp = await startMcpHarness({
    name: "sandbox-e2e",
    secrets: { backend: "fake", list: async () => [], get: async () => "" },
  });
});

afterAll(async () => {
  await mcp?.close();
  for (const [key, value] of savedDisplay) if (value !== undefined) process.env[key] = value;
});

test.skipIf(!isLinux)("Chrome is launched with its sandbox enabled", async () => {
  const result = await mcp.call("navigate", { url: "about:blank" });
  expect(result.isError).not.toBe(true);
  const browsers = await browserCommandLines(mcp.config.profileDir);
  expect(browsers.length).toBe(1);
  expect(browsers[0]!).not.toContain("--no-sandbox");
});

test.skipIf(!isLinux)(
  "Chrome is launched with --test-type to hide the unsupported flag infobar",
  async () => {
    const result = await mcp.call("navigate", { url: "about:blank" });
    expect(result.isError).not.toBe(true);
    const browsers = await browserCommandLines(mcp.config.profileDir);
    expect(browsers.length).toBe(1);
    expect(browsers[0]!).toContain("--test-type");
  },
);
