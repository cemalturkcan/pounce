import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "pounce-dirs-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const newDataDir = () => path.join(home, ".local", "share", "pounce");
const oldDataDir = () => path.join(home, ".local", "share", "claude-code-pair", "web-agent");
const newConfigDir = () => path.join(home, ".config", "pounce");
const oldConfigDir = () => path.join(home, ".config", "web-agent-mcp");

test("the data dir is ~/.local/share/pounce when neither data dir exists", () => {
  expect(loadConfig({ HOME: home }).dataDir).toBe(newDataDir());
});

test("the data dir is the old claude-code-pair/web-agent dir when only it exists", async () => {
  await mkdir(oldDataDir(), { recursive: true });
  expect(loadConfig({ HOME: home }).dataDir).toBe(oldDataDir());
});

test("the data dir is ~/.local/share/pounce when both data dirs exist", async () => {
  await mkdir(oldDataDir(), { recursive: true });
  await mkdir(newDataDir(), { recursive: true });
  expect(loadConfig({ HOME: home }).dataDir).toBe(newDataDir());
});

test("the data dir is pounce under XDG_DATA_HOME when XDG_DATA_HOME is set", () => {
  const xdg = path.join(home, "xdg-data");
  expect(loadConfig({ HOME: home, XDG_DATA_HOME: xdg }).dataDir).toBe(path.join(xdg, "pounce"));
});

test("the old data dir is looked up under XDG_DATA_HOME when XDG_DATA_HOME is set", async () => {
  const xdg = path.join(home, "xdg-data");
  await mkdir(path.join(xdg, "claude-code-pair", "web-agent"), { recursive: true });
  expect(loadConfig({ HOME: home, XDG_DATA_HOME: xdg }).dataDir).toBe(
    path.join(xdg, "claude-code-pair", "web-agent"),
  );
});

test("WEB_AGENT_DATA_DIR wins over an existing old data dir", async () => {
  await mkdir(oldDataDir(), { recursive: true });
  const chosen = path.join(home, "chosen");
  expect(loadConfig({ HOME: home, WEB_AGENT_DATA_DIR: chosen }).dataDir).toBe(chosen);
});

test("the ask adapter file is in ~/.config/pounce when neither config dir exists", () => {
  expect(loadConfig({ HOME: home }).askAdapterPath).toBe(
    path.join(newConfigDir(), "ask-adapter.mjs"),
  );
});

test("the ask adapter file is in ~/.config/web-agent-mcp when only that config dir exists", async () => {
  await mkdir(oldConfigDir(), { recursive: true });
  expect(loadConfig({ HOME: home }).askAdapterPath).toBe(
    path.join(oldConfigDir(), "ask-adapter.mjs"),
  );
});

test("the ask adapter file is in ~/.config/pounce when both config dirs exist", async () => {
  await mkdir(oldConfigDir(), { recursive: true });
  await mkdir(newConfigDir(), { recursive: true });
  expect(loadConfig({ HOME: home }).askAdapterPath).toBe(
    path.join(newConfigDir(), "ask-adapter.mjs"),
  );
});

test("the ask adapter file is in pounce under XDG_CONFIG_HOME when XDG_CONFIG_HOME is set", () => {
  const xdg = path.join(home, "xdg-config");
  expect(loadConfig({ HOME: home, XDG_CONFIG_HOME: xdg }).askAdapterPath).toBe(
    path.join(xdg, "pounce", "ask-adapter.mjs"),
  );
});
