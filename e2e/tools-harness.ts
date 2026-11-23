import { afterAll, beforeAll, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { AskAdapter } from "../src/ask/adapter.ts";
import type { Notifier } from "../src/shared/notify.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { type McpHarness, type ToolArgs, useMcpHarness } from "../tests/mcpHarness.ts";
import { type Fixture, startFixture } from "./fixture.ts";

export const TEST_SECRET = `fixture-${randomBytes(9).toString("hex")}`;

export const fakeSecrets: SecretStore = {
  backend: "fake",
  list: async () => ["fixture/site"],
  get: async (name, field) => {
    expect(name).toBe("fixture/site");
    return field === "username" ? "fixture-user" : TEST_SECRET;
  },
};

function paragraphAdapter(prompts: string[]): AskAdapter {
  return {
    name: "fixture adapter",
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      const documents = [
        ...prompt.matchAll(/<document source="([^"]+)">\n([\s\S]*?)\n<\/document>/g),
      ];
      const hits = documents
        .filter((match) => (match[2] ?? "").includes("Paragraph 7 of"))
        .map((match) => `- Paragraph 7 is in the article [${match[1]}]`);
      const misses = documents
        .filter((match) => !(match[2] ?? "").includes("Paragraph 7 of"))
        .map((match) => match[1]);
      return {
        text: [...hits, misses.length ? `NOT FOUND: ${misses.join(", ")}` : ""].join("\n"),
        usage: { input_tokens: 1000, output_tokens: 20 },
      };
    },
  };
}

export async function holdsFocus(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    return await page.evaluate(() => document.hasFocus());
  } finally {
    await session.detach();
  }
}

export async function focusEvents(page: Page) {
  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.focuses = "0";
    addEventListener(
      "focus",
      () => (root.dataset.focuses = String(Number(root.dataset.focuses) + 1)),
    );
  });
  return () => page.evaluate(() => Number(document.documentElement.dataset.focuses));
}

export function openedTab(text: string) {
  const id = /Opened (t\d+)/.exec(text)?.[1];
  expect(id, text).toMatch(/^t\d+$/);
  return id ?? "";
}

export async function failedCall(harness: Pick<McpHarness, "call">, name: string, args: ToolArgs) {
  const result = await harness.call(name, args);
  expect(result.isError, `${name} should have failed: ${result.text}`).toBe(true);
  return result.text;
}

export const savedDir = (text: string) => /pages into (\S+)/.exec(text)?.[1] ?? "";

async function collectedText(index: string) {
  const dir = savedDir(index);
  const file = (await readdir(dir)).find((entry) => entry.endsWith(".txt")) ?? "";
  return { index, text: await readFile(path.join(dir, file), "utf8") };
}

type ToolsHarnessOptions = { env?: NodeJS.ProcessEnv; secrets?: SecretStore };

export function useToolsHarness(name: string, options: ToolsHarnessOptions = {}) {
  const askPrompts: string[] = [];
  const notifications: [string, string][] = [];
  const recordingNotifier: Notifier = async (title, body) => {
    notifications.push([title, body]);
    return undefined;
  };
  const fakeAdapter = paragraphAdapter(askPrompts);
  let current: Fixture | undefined;
  const mcp = useMcpHarness({
    name,
    env: { WEB_AGENT_LOG_LEVEL: "debug", ...options.env },
    secrets: options.secrets ?? fakeSecrets,
    askAdapter: fakeAdapter,
    notify: recordingNotifier,
  });
  const { ok } = mcp;
  const fixture = () => {
    if (!current) throw new Error("The tools fixture has not started");
    return current;
  };

  beforeAll(async () => {
    current = await startFixture();
  });

  afterAll(async () => {
    await current?.close();
  });

  return {
    mcp,
    call: mcp.call,
    ok,
    fixture,
    fakeAdapter,
    askPrompts,
    notifications,
    openedTab,
    failure: (tool: string, args: ToolArgs) => failedCall(mcp, tool, args),
    openTab: async (route: string, waitUntil: "load" | "commit" = "load") => {
      const tab = await mcp.deps.manager.openTab("stdio");
      await tab.page.goto(`${fixture().url}${route}`, { waitUntil });
      return tab;
    },
    refOf: (snapshot: string, label: string) => {
      const line = snapshot.split("\n").find((candidate) => candidate.includes(label));
      const ref = line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
      expect(ref, `no ref for ${label} in:\n${snapshot}`).toMatch(/^[a-z0-9]+$/);
      return ref ?? "";
    },
    collectFeed: async (extra: ToolArgs) =>
      collectedText(
        await ok("save_pages", {
          urls: [`${fixture().url}/feed`],
          include: ["text"],
          settle_ms: 0,
          ...extra,
        }),
      ),
    collectText: async (route: string, extra: ToolArgs = {}) =>
      collectedText(
        await ok("save_pages", { urls: [fixture().url + route], include: ["text"], ...extra }),
      ),
    dismissIn: async (route: string) => {
      const tab = openedTab(await ok("navigate", { url: `${fixture().url}${route}` }));
      try {
        const text = await ok("dismiss_overlays", { tab });
        return { text, state: await ok("read_page", { tab, target: "#modal-state" }) };
      } finally {
        await ok("tabs", { close: [tab] });
      }
    },
    counter: async (tab: string) =>
      Number(
        /(\d+)\s*$/.exec(await ok("evaluate", { tab, expression: "window.clicks || 0" }))?.[1],
      ),
  };
}
