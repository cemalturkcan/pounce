import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadConfig, loadConfigLeniently } from "./config.ts";

const FAKE_KEY = "sk-ant-test-stored-0000000000";
const ENV_KEY = "sk-ant-test-env-1111111111";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "pounce-settings-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(dir: string, settings: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "config.json"), settings);
}

const newConfigDir = () => path.join(home, ".config", "pounce");
const oldConfigDir = () => path.join(home, ".config", "web-agent-mcp");

test("ask_pages uses the Claude Code login when there is no config.json", () => {
  expect(loadConfig({ HOME: home }).ask).toStrictEqual({ mode: "claude" });
});

test("config.json turns ask_pages off", async () => {
  await writeSettings(newConfigDir(), JSON.stringify({ ask: { mode: "off" } }));

  expect(loadConfig({ HOME: home }).ask).toStrictEqual({ mode: "off" });
});

test("config.json is read from the old web-agent-mcp dir when only it exists", async () => {
  await writeSettings(oldConfigDir(), JSON.stringify({ ask: { mode: "off" } }));

  expect(loadConfig({ HOME: home }).ask).toStrictEqual({ mode: "off" });
});

test("config.json names the adapter file", async () => {
  await writeSettings(
    newConfigDir(),
    JSON.stringify({ ask: { mode: "adapter", path: "/opt/adapter.mjs" } }),
  );

  expect(loadConfig({ HOME: home }).ask).toStrictEqual({
    mode: "adapter",
    path: "/opt/adapter.mjs",
  });
});

test("the stored API key is used in api-key mode", async () => {
  await writeSettings(
    newConfigDir(),
    JSON.stringify({ ask: { mode: "api-key", apiKey: FAKE_KEY } }),
  );

  expect(loadConfig({ HOME: home }).ask).toStrictEqual({ mode: "api-key", apiKey: FAKE_KEY });
});

test("ANTHROPIC_API_KEY overrides the stored key in api-key mode", async () => {
  await writeSettings(
    newConfigDir(),
    JSON.stringify({ ask: { mode: "api-key", apiKey: FAKE_KEY } }),
  );

  expect(loadConfig({ HOME: home, ANTHROPIC_API_KEY: ENV_KEY }).ask).toStrictEqual({
    mode: "api-key",
    apiKey: ENV_KEY,
  });
});

test("ANTHROPIC_API_KEY does not switch the Claude Code login mode", () => {
  expect(loadConfig({ HOME: home, ANTHROPIC_API_KEY: ENV_KEY }).ask).toStrictEqual({
    mode: "claude",
  });
});

test("an unreadable config.json is named in the error", async () => {
  await writeSettings(newConfigDir(), "{ not json");

  expect(() => loadConfig({ HOME: home })).toThrow(path.join(newConfigDir(), "config.json"));
});

const EMPTY_KEY = JSON.stringify({
  ask: { mode: "api-key", apiKey: "" },
  entries: { claude: { type: "http", url: "http://127.0.0.1:29741/mcp" } },
});

test("a config.json that fails the schema is still loaded leniently", async () => {
  await writeSettings(newConfigDir(), EMPTY_KEY);

  expect(loadConfigLeniently({ HOME: home }).config.configFile).toBe(
    path.join(newConfigDir(), "config.json"),
  );
});

test("the lenient load names the field that fails the schema", async () => {
  await writeSettings(newConfigDir(), EMPTY_KEY);

  expect(loadConfigLeniently({ HOME: home }).problem).toContain("ask.apiKey");
});

test("the lenient load keeps the settings that pass the schema", async () => {
  await writeSettings(newConfigDir(), EMPTY_KEY);

  expect(loadConfigLeniently({ HOME: home }).settings.entries).toStrictEqual({
    claude: { type: "http", url: "http://127.0.0.1:29741/mcp" },
  });
});

test("the strict load names the field that fails the schema", async () => {
  await writeSettings(newConfigDir(), EMPTY_KEY);

  expect(() => loadConfig({ HOME: home })).toThrow("ask.apiKey");
});
