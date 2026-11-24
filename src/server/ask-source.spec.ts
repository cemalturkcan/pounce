import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config/config.ts";
import type { AskSetting } from "../config/settings.ts";
import { askSourceFor } from "./setup.ts";

const KEY = "sk-ant-test-key-000000000000";
const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function configWith(ask: AskSetting | undefined, env: Record<string, string> = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-ask-source-"));
  dirs.push(home);
  const configDir = path.join(home, ".config", "pounce");
  await Bun.write(path.join(configDir, "config.json"), JSON.stringify(ask ? { ask } : {}));
  return { home, config: loadConfig({ HOME: home, ...env }) };
}

async function adapterFile(home: string) {
  const file = path.join(home, "adapter.mjs");
  await writeFile(file, 'export default { name: "own", complete: async () => ({ text: "" }) };');
  return file;
}

test("off makes ask_pages refuse with a sentence naming pounce install", async () => {
  const { config } = await configWith({ mode: "off" });

  await expect(askSourceFor(config).get()).rejects.toThrow("`pounce install`");
});

test("WEB_AGENT_ASK_ADAPTER overrides off", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-ask-source-"));
  dirs.push(home);
  const file = await adapterFile(home);
  const { config } = await configWith({ mode: "off" }, { WEB_AGENT_ASK_ADAPTER: file });

  expect((await askSourceFor(config).get()).name).toBe("own");
});

test("api-key mode uses the built-in adapter with the key", async () => {
  const { config } = await configWith({ mode: "api-key", apiKey: KEY });

  expect((await askSourceFor(config).get()).name).toBe("Anthropic API key");
});

test("api-key mode without a key refuses naming ANTHROPIC_API_KEY", async () => {
  const { config } = await configWith({ mode: "api-key" });

  await expect(askSourceFor(config).get()).rejects.toThrow("ANTHROPIC_API_KEY");
});

test("adapter mode loads the configured file", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-ask-source-"));
  dirs.push(home);
  const { config } = await configWith({ mode: "adapter", path: await adapterFile(home) });

  expect((await askSourceFor(config).get()).name).toBe("own");
});

test("without config.json the Claude Code login adapter is used", async () => {
  const { config } = await configWith(undefined);

  expect((await askSourceFor(config).get()).name).toBe("Anthropic Claude account");
});
