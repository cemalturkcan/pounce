import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { PACKAGE_DIR } from "../config/version.ts";
import { readConfig, writeEntry } from "./agent-config.ts";
import { type AgentName, type AgentSpec, agentSpecs } from "./agents.ts";
import { type JsonValue, parseJsonc } from "./jsonc.ts";
import { parseToml } from "./toml.ts";

const ENDPOINT = "http://127.0.0.1:29741/mcp";
const COMMAND = ["/home/u/.local/bin/pounce"];

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "pounce-agents-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function spec(name: AgentName): AgentSpec {
  const found = agentSpecs({
    home,
    configHome: path.join(home, ".config"),
    env: {},
    onPath: () => false,
  }).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no spec for ${name}`);
  return found;
}

async function placeFixture(name: string, file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await copyFile(path.join(PACKAGE_DIR, "tests", "fixtures", "agent-configs", name), file);
}

function write(agent: AgentSpec, owned?: Parameters<typeof writeEntry>[2]) {
  return writeEntry(agent.target, agent.entry(ENDPOINT, COMMAND, readConfig(agent.target)), owned);
}

const jsonObject = z.record(z.string(), z.json());

function at(value: JsonValue | undefined, ...keys: string[]): JsonValue | undefined {
  return keys.reduce<JsonValue | undefined>(
    (node, key) => jsonObject.safeParse(node).data?.[key],
    value,
  );
}

async function written(agent: AgentSpec) {
  const text = await readFile(agent.target.file, "utf8");
  return agent.target.format === "toml" ? parseToml(text) : parseJsonc(text);
}

describe("the entry each agent gets", () => {
  const cases: [AgentName, string[], JsonValue][] = [
    ["claude", ["mcpServers", "pounce"], { type: "http", url: ENDPOINT }],
    ["cursor", ["mcpServers", "pounce"], { url: ENDPOINT }],
    ["gemini", ["mcpServers", "pounce"], { httpUrl: ENDPOINT }],
    ["windsurf", ["mcpServers", "pounce"], { serverUrl: ENDPOINT }],
    ["vscode", ["servers", "pounce"], { type: "http", url: ENDPOINT }],
    ["opencode", ["mcp", "servers", "pounce"], { type: "remote", url: ENDPOINT }],
    ["codex", ["mcp_servers", "pounce"], { url: ENDPOINT }],
    [
      "claude-desktop",
      ["mcpServers", "pounce"],
      { command: "/home/u/.local/bin/pounce", args: ["mcp"] },
    ],
  ];
  for (const [name, keys, entry] of cases)
    test(`${name} gets ${JSON.stringify(entry)}`, async () => {
      const agent = spec(name);
      write(agent);
      expect(at(await written(agent), ...keys)).toStrictEqual(entry);
    });
});

describe("Claude Code with a commented config", () => {
  test("keeps the comments", async () => {
    const agent = spec("claude");
    await placeFixture("commented.jsonc", agent.target.file);
    write(agent);

    expect(await readFile(agent.target.file, "utf8")).toContain("// my own server");
  });

  test("reports the entry as added", async () => {
    const agent = spec("claude");
    await placeFixture("commented.jsonc", agent.target.file);

    expect(write(agent)).toBe("added");
  });

  test("keeps the other server", async () => {
    const agent = spec("claude");
    await placeFixture("commented.jsonc", agent.target.file);
    write(agent);

    expect(at(await written(agent), "mcpServers", "other")).toStrictEqual({
      command: "other-mcp",
      args: ["--flag"],
    });
  });
});

describe("Codex with a commented config.toml", () => {
  test("keeps the comments", async () => {
    const agent = spec("codex");
    await placeFixture("codex.toml", agent.target.file);
    write(agent);
    const text = await readFile(agent.target.file, "utf8");

    expect([text.includes("# Codex settings"), text.includes("# inline comment")]).toStrictEqual([
      true,
      true,
    ]);
  });

  test("keeps the other tables", async () => {
    const agent = spec("codex");
    await placeFixture("codex.toml", agent.target.file);
    write(agent);

    const config = await written(agent);

    expect([
      at(config, "model"),
      at(config, "mcp_servers", "other"),
      at(config, "profiles"),
    ]).toStrictEqual([
      "gpt-6",
      { command: "other-mcp", args: ["--flag"] },
      { fast: { model: "gpt-6-mini" } },
    ]);
  });

  test("replaces an entry pounce wrote before", async () => {
    const agent = spec("codex");
    await placeFixture("codex.toml", agent.target.file);
    const old = { url: "http://127.0.0.1:1/mcp" };
    writeEntry(agent.target, old, undefined);
    write(agent, old);

    expect(at(await written(agent), "mcp_servers", "pounce")).toStrictEqual({ url: ENDPOINT });
  });
});

describe("OpenCode with the old flat mcp map", () => {
  test("adds the entry in the same style", async () => {
    await placeFixture(
      "opencode-v1.jsonc",
      path.join(home, ".config", "opencode", "opencode.jsonc"),
    );
    const agent = spec("opencode");
    write(agent);

    expect(at(await written(agent), "mcp", "pounce")).toStrictEqual({
      type: "remote",
      url: ENDPOINT,
      enabled: true,
    });
  });
});

describe("an entry named pounce that pounce did not write", () => {
  test("is a conflict", async () => {
    const agent = spec("cursor");
    await mkdir(path.dirname(agent.target.file), { recursive: true });
    await writeFile(
      agent.target.file,
      '{"mcpServers": {"pounce": {"url": "http://elsewhere/mcp"}}}',
    );

    expect(write(agent)).toBe("conflict");
  });

  test("is left unchanged", async () => {
    const agent = spec("cursor");
    await mkdir(path.dirname(agent.target.file), { recursive: true });
    const before = '{"mcpServers": {"pounce": {"url": "http://elsewhere/mcp"}}}';
    await writeFile(agent.target.file, before);
    write(agent);

    expect(await readFile(agent.target.file, "utf8")).toBe(before);
  });
});

test("writing the same entry twice reports it unchanged", () => {
  const agent = spec("gemini");
  write(agent);

  expect(write(agent)).toBe("unchanged");
});

test("a new config file is private to the user", async () => {
  const agent = spec("gemini");
  write(agent);

  expect((await stat(agent.target.file)).mode & 0o777).toBe(0o600);
});

async function linked() {
  const agent = spec("windsurf");
  const real = path.join(home, "dotfiles", "mcp_config.json");
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, "{}\n");
  await mkdir(path.dirname(agent.target.file), { recursive: true });
  await symlink(real, agent.target.file);
  write(agent);
  return { agent, real };
}

describe("a symlinked config", () => {
  test("stays a symlink", async () => {
    const { agent } = await linked();

    expect((await lstat(agent.target.file)).isSymbolicLink()).toBe(true);
  });

  test("gets the entry in the file it points to", async () => {
    const { real } = await linked();

    expect(parseJsonc(await readFile(real, "utf8"))).toStrictEqual({
      mcpServers: { pounce: { serverUrl: ENDPOINT } },
    });
  });
});

test("a new JSON config is written indented", async () => {
  const agent = spec("gemini");
  write(agent);

  expect(await readFile(agent.target.file, "utf8")).toBe(
    `${JSON.stringify({ mcpServers: { pounce: { httpUrl: ENDPOINT } } }, null, 2)}\n`,
  );
});
