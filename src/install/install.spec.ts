import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureDaemon } from "../cli/daemon-control.ts";
import type { CommandResult, Runner } from "../cli/process.ts";
import { loadConfig, loadConfigLeniently } from "../config/config.ts";
import { askSourceFor } from "../server/setup.ts";
import type { DaemonRegistry } from "../server/daemon.ts";
import { parseJsonc } from "./jsonc.ts";
import { install, type InstallIo } from "./install.ts";
import type { Choice, Prompts } from "./prompt.ts";
import { SKILL } from "./skill.ts";

const FAKE_KEY = "sk-ant-test-install-0000000000";

let home: string;
let output: string[];
let commands: string[][];
let asked: { kind: string; question: string; initial?: string; labels?: string[] }[];

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "pounce-install-"));
  output = [];
  commands = [];
  asked = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

type Answers = {
  select?: string[];
  pickMany?: string[][];
  confirm?: boolean[];
  secret?: string[];
  onConfirm?: () => Promise<void>;
};

function scriptedPrompts(answers: Answers): Prompts {
  return {
    async select<T extends string>(question: string, choices: Choice<T>[], initial: T) {
      asked.push({
        kind: "select",
        question,
        initial,
        labels: choices.map((choice) => choice.label),
      });
      const answer = answers.select?.shift() ?? initial;
      return choices.find((choice) => choice.value === answer)?.value ?? initial;
    },
    async pickMany<T extends string>(question: string, choices: Choice<T>[], initial: T[]) {
      asked.push({ kind: "pickMany", question, initial: initial.join(",") });
      const answer = answers.pickMany?.shift();
      return answer
        ? choices.filter((choice) => answer.includes(choice.value)).map((choice) => choice.value)
        : initial;
    },
    async confirm(question: string, initial: boolean) {
      asked.push({ kind: "confirm", question, initial: String(initial) });
      await answers.onConfirm?.();
      return answers.confirm?.shift() ?? initial;
    },
    async secret(question: string) {
      asked.push({ kind: "secret", question });
      return answers.secret?.shift() ?? "";
    },
    async text(question: string, initial: string) {
      asked.push({ kind: "text", question, initial });
      return initial;
    },
  };
}

function runner(replies: Record<string, Partial<CommandResult>> = {}): Runner {
  return async (command) => {
    commands.push([...command]);
    const key = command.slice(0, 4).join(" ");
    const match = Object.entries(replies).find(([prefix]) => key.startsWith(prefix));
    return { code: 0, stdout: "", stderr: "", ...match?.[1] };
  };
}

const NO_SYSTEMD = {
  "systemctl --user show-environment": { code: 1, stderr: "Failed to connect to bus" },
};

async function fakeBinary() {
  const file = path.join(home, "Downloads", "pounce-linux-x64");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);
  return file;
}

type Options = {
  env?: NodeJS.ProcessEnv;
  tty?: boolean;
  answers?: Answers;
  replies?: Record<string, Partial<CommandResult>>;
  chromeOk?: boolean;
  source?: string;
};

async function runInstall(args: string[], options: Options = {}) {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/bash",
    WEB_AGENT_DAEMON_PORT: "29999",
    ...options.env,
  };
  const binary = await fakeBinary();
  const io: InstallIo = {
    env,
    tty: options.tty ?? false,
    print: (line) => output.push(line),
    prompts: scriptedPrompts(options.answers ?? {}),
    runner: runner(options.replies ?? NO_SYSTEMD),
    executable: options.source
      ? { path: "/usr/bin/bun", compiled: false }
      : { path: binary, compiled: true },
    sourceCommand: ["/usr/bin/bun", options.source ?? "/src/server.ts"],
    onPath: () => false,
    ensureDaemon: async (config): Promise<DaemonRegistry> => ({
      pid: 4242,
      endpoint: config.endpoint,
      port: config.port,
      dataDir: config.dataDir,
      profileDir: config.profileDir,
      startedAt: new Date().toISOString(),
      version: config.serverVersion,
    }),
    checkChrome: async () =>
      options.chromeOk === false
        ? { ok: false, executable: "/opt/google/chrome/chrome", detail: "not found" }
        : { ok: true, executable: "/opt/google/chrome/chrome" },
  };
  return install(args, io);
}

const BASIC = ["-a", "claude", "--ask", "off", "--profile", "fresh"];
const printed = () => output.join("\n");
const at = (...parts: string[]) => path.join(home, ...parts);
function settings() {
  const { settings: saved, problem } = loadConfigLeniently({ HOME: home });
  if (problem) throw new Error(problem);
  return saved;
}

async function claudeJson() {
  return parseJsonc(await readFile(at(".claude.json"), "utf8"));
}

describe("a non-interactive install for Claude Code", () => {
  test("exits 0", async () => {
    expect(await runInstall(BASIC)).toBe(0);
  });

  test("places the binary in ~/.local/bin", async () => {
    await runInstall(BASIC);

    expect(existsSync(at(".local", "bin", "pounce"))).toBe(true);
  });

  test("adds ~/.local/bin to PATH in the shell startup file", async () => {
    await runInstall(BASIC);

    expect(await readFile(at(".bashrc"), "utf8")).toContain(
      `export PATH='${at(".local", "bin")}':"$PATH"`,
    );
  });

  test("writes the HTTP entry to ~/.claude.json", async () => {
    await runInstall(BASIC);

    expect(await claudeJson()).toStrictEqual({
      mcpServers: { pounce: { type: "http", url: "http://127.0.0.1:29999/mcp" } },
    });
  });

  test("copies the skill", async () => {
    await runInstall(BASIC);

    expect(await readFile(at(".claude", "skills", "pounce", "SKILL.md"), "utf8")).toBe(SKILL);
  });

  test("saves the choices to config.json", async () => {
    await runInstall(BASIC);

    expect(settings().ask).toStrictEqual({ mode: "off" });
  });

  test("keeps config.json private", async () => {
    await runInstall(BASIC);

    expect((await stat(at(".config", "pounce", "config.json"))).mode & 0o777).toBe(0o600);
  });

  test("makes its WEB_AGENT settings visible to a pounce started without them", async () => {
    await runInstall(BASIC);

    expect(loadConfig({ HOME: home }).endpoint).toBe("http://127.0.0.1:29999/mcp");
  });

  test("prints the first prompt to try", async () => {
    await runInstall(BASIC);

    expect(printed()).toContain("Use pounce to open news.ycombinator.com");
  });
});

test("--no-modify-path leaves the shell startup file alone", async () => {
  await runInstall([...BASIC, "--no-modify-path"]);

  expect(existsSync(at(".bashrc"))).toBe(false);
});

test("config.json goes to the old web-agent-mcp dir when only it exists", async () => {
  await mkdir(at(".config", "web-agent-mcp"), { recursive: true });
  await runInstall(BASIC);

  expect(existsSync(at(".config", "web-agent-mcp", "config.json"))).toBe(true);
});

test("the old web-agent-mcp dir is not orphaned by a new pounce dir", async () => {
  await mkdir(at(".config", "web-agent-mcp"), { recursive: true });
  await runInstall(BASIC);

  expect(existsSync(at(".config", "pounce"))).toBe(false);
});

const uid = process.getuid?.() ?? 0;
const BUNX_SOURCE = `/home/u/.bun/install/cache/.bunx-${uid}/pounce@latest/node_modules/pounce/src/server.ts`;

describe("install run from bunx's cache", () => {
  test("exits 1", async () => {
    expect(await runInstall(BASIC, { source: BUNX_SOURCE })).toBe(1);
  });

  test("tells the user to install pounce globally first", async () => {
    await runInstall(BASIC, { source: BUNX_SOURCE });

    expect(printed()).toContain("run `bun add -g pounce`, then `pounce install`");
  });

  test("writes nothing to the home directory", async () => {
    await runInstall([...BASIC, "--desktop"], { source: BUNX_SOURCE });

    expect(await readdir(home)).toStrictEqual(["Downloads"]);
  });

  test("is refused for bunx's temp dir layout too", async () => {
    expect(
      await runInstall(BASIC, {
        source: `/tmp/bunx-${uid}-pounce@latest/node_modules/pounce/src/server.ts`,
      }),
    ).toBe(1);
  });
});

test("install from bun's global packages runs", async () => {
  expect(
    await runInstall(BASIC, {
      source: "/home/u/.bun/install/global/node_modules/pounce/src/server.ts",
    }),
  ).toBe(0);
});

describe("the service step", () => {
  test("writes pounce.service that runs the installed binary as the daemon", async () => {
    await runInstall(BASIC, { replies: {} });

    expect(await readFile(at(".config", "systemd", "user", "pounce.service"), "utf8")).toContain(
      `ExecStart=${at(".local", "bin", "pounce")} --daemon`,
    );
  });

  test("is still the daemon's unit after the port saved in config.json is edited", async () => {
    await runInstall(BASIC, { replies: {} });
    const file = at(".config", "pounce", "config.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...saved, env: { WEB_AGENT_DAEMON_PORT: "31111" } }));
    const env = { HOME: home };
    const started: string[][] = [];
    await ensureDaemon(loadConfig(env), env, {
      runner: async (command) => {
        started.push([...command]);
        return { code: 0, stdout: command[2] === "show" ? "failed\n" : "", stderr: "" };
      },
      spawnDetached: (command) => {
        started.push([...command]);
        return { exited: () => true };
      },
    }).catch(() => undefined);

    expect(started[0]).toStrictEqual(["systemctl", "--user", "start", "pounce.service"]);
  });

  test("enables and starts it", async () => {
    await runInstall(BASIC, { replies: {} });

    expect(
      commands.filter((command) => command[2] === "enable" || command[2] === "start"),
    ).toStrictEqual([
      ["systemctl", "--user", "enable", "pounce.service"],
      ["systemctl", "--user", "start", "pounce.service"],
    ]);
  });

  test("starts from default.target in a session without graphical-session.target", async () => {
    await runInstall(BASIC, { env: { DISPLAY: ":0" }, replies: {} });

    expect(await readFile(at(".config", "systemd", "user", "pounce.service"), "utf8")).toContain(
      "WantedBy=default.target",
    );
  });

  test("starts with the session when graphical-session.target is active", async () => {
    await runInstall(BASIC, {
      env: { DISPLAY: ":0" },
      replies: { "systemctl --user is-active": { stdout: "active\n" } },
    });

    expect(await readFile(at(".config", "systemd", "user", "pounce.service"), "utf8")).toContain(
      "WantedBy=graphical-session.target",
    );
  });

  test("is skipped without systemd --user", async () => {
    await runInstall(BASIC);

    expect(existsSync(at(".config", "systemd", "user", "pounce.service"))).toBe(false);
  });

  test("says why it was skipped without systemd --user", async () => {
    await runInstall(BASIC);

    expect(printed()).toContain("systemd --user is not available");
  });

  test("leaves out pounce.service when claude-code-pair-web-agent.service serves the same daemon", async () => {
    await mkdir(at(".config", "systemd", "user"), { recursive: true });
    await writeFile(
      at(".config", "systemd", "user", "claude-code-pair-web-agent.service"),
      "[Service]\nEnvironment=WEB_AGENT_DAEMON_PORT=29999\n",
    );
    await runInstall(BASIC, { replies: {} });

    expect(existsSync(at(".config", "systemd", "user", "pounce.service"))).toBe(false);
  });

  test("writes pounce.service when claude-code-pair-web-agent.service serves another port", async () => {
    await mkdir(at(".config", "systemd", "user"), { recursive: true });
    await writeFile(
      at(".config", "systemd", "user", "claude-code-pair-web-agent.service"),
      "[Service]\nEnvironment=WEB_AGENT_DAEMON_PORT=29741\n",
    );
    await runInstall(BASIC, { replies: {} });

    expect(existsSync(at(".config", "systemd", "user", "pounce.service"))).toBe(true);
  });

  test("says pounce.service runs the daemon when claude-code-pair-web-agent.service serves another port", async () => {
    await mkdir(at(".config", "systemd", "user"), { recursive: true });
    await writeFile(
      at(".config", "systemd", "user", "claude-code-pair-web-agent.service"),
      "[Service]\nEnvironment=WEB_AGENT_DAEMON_PORT=29741\n",
    );
    await runInstall(BASIC, { replies: {} });

    expect(printed()).toContain("pounce.service is enabled and started");
  });
});

describe("choosing agents without a terminal", () => {
  test("an agent running install sets up itself", async () => {
    await runInstall(["--ask", "off"], { env: { CLAUDECODE: "1" } });

    expect(existsSync(at(".claude.json"))).toBe(true);
  });

  test("with no caller and no --agent no agent config is written", async () => {
    await runInstall(["--ask", "off"]);

    expect(existsSync(at(".claude.json"))).toBe(false);
  });

  test("--agent none prints the entry to add by hand", async () => {
    await runInstall(["--agent", "none", "--ask", "off"]);

    expect(printed()).toContain(
      '{"mcpServers":{"pounce":{"type":"http","url":"http://127.0.0.1:29999/mcp"}}}',
    );
  });

  test("-y configures every detected agent", async () => {
    await mkdir(at(".codex"), { recursive: true });
    await mkdir(at(".gemini"), { recursive: true });
    await runInstall(["-y", "--ask", "off"]);

    expect([
      existsSync(at(".codex", "config.toml")),
      existsSync(at(".gemini", "settings.json")),
    ]).toStrictEqual([true, true]);
  });

  test("-y run by an agent configures every detected agent", async () => {
    await mkdir(at(".codex"), { recursive: true });
    await runInstall(["-y", "--ask", "off"], { env: { CLAUDECODE: "1" } });

    expect(existsSync(at(".codex", "config.toml"))).toBe(true);
  });

  test("-y run by an agent also configures that agent", async () => {
    await mkdir(at(".codex"), { recursive: true });
    await runInstall(["-y", "--ask", "off"], { env: { CLAUDECODE: "1" } });

    expect(existsSync(at(".claude.json"))).toBe(true);
  });

  test("an unknown agent name is a usage error", async () => {
    expect(await runInstall(["-a", "notepad"])).toBe(2);
  });
});

const LEGACY_ENTRY = { type: "http", url: "http://127.0.0.1:29999/mcp" };

describe("an agent config with the old web-agent-mcp entry for the same daemon", () => {
  test("has that entry replaced by pounce", async () => {
    await writeFile(
      at(".claude.json"),
      JSON.stringify({ mcpServers: { context7: { url: "x" }, "web-agent-mcp": LEGACY_ENTRY } }),
    );
    await runInstall(BASIC);

    expect(await claudeJson()).toStrictEqual({
      mcpServers: { context7: { url: "x" }, pounce: LEGACY_ENTRY },
    });
  });

  test("says the old entry was replaced", async () => {
    await writeFile(
      at(".claude.json"),
      JSON.stringify({ mcpServers: { "web-agent-mcp": LEGACY_ENTRY } }),
    );
    await runInstall(BASIC);

    expect(printed()).toContain("Replaced web-agent-mcp with pounce in Claude Code");
  });

  test("loses it when pounce is already there too", async () => {
    await writeFile(
      at(".claude.json"),
      JSON.stringify({ mcpServers: { "web-agent-mcp": LEGACY_ENTRY, pounce: LEGACY_ENTRY } }),
    );
    await runInstall(BASIC);

    expect(await claudeJson()).toStrictEqual({ mcpServers: { pounce: LEGACY_ENTRY } });
  });

  test("has it replaced in Codex's TOML too", async () => {
    await mkdir(at(".codex"), { recursive: true });
    await writeFile(
      at(".codex", "config.toml"),
      '[mcp_servers.web-agent-mcp]\nurl = "http://127.0.0.1:29999/mcp"\n\n[other]\nkey = 1\n',
    );
    await runInstall(["-a", "codex", "--ask", "off", "--profile", "fresh"]);

    expect(Bun.TOML.parse(await readFile(at(".codex", "config.toml"), "utf8"))).toStrictEqual({
      mcp_servers: { pounce: { url: "http://127.0.0.1:29999/mcp" } },
      other: { key: 1 },
    });
  });
});

test("a web-agent-mcp entry for another daemon is left alone", async () => {
  const other = { type: "http", url: "http://127.0.0.1:31000/mcp" };
  await writeFile(at(".claude.json"), JSON.stringify({ mcpServers: { "web-agent-mcp": other } }));
  await runInstall(BASIC);

  expect(await claudeJson()).toStrictEqual({
    mcpServers: { "web-agent-mcp": other, pounce: LEGACY_ENTRY },
  });
});

describe("re-running install", () => {
  test("reports the entry as already there", async () => {
    await runInstall(BASIC);
    output = [];
    await runInstall(BASIC);

    expect(printed()).toContain("Claude Code already has pounce");
  });

  test("updates the entry it wrote when the port changed", async () => {
    await runInstall(BASIC);
    await runInstall(BASIC, { env: { WEB_AGENT_DAEMON_PORT: "29998" } });

    expect(await claudeJson()).toStrictEqual({
      mcpServers: { pounce: { type: "http", url: "http://127.0.0.1:29998/mcp" } },
    });
  });

  test("notes a Codex entry it wrote that the user rewrote as an inline table", async () => {
    await runInstall(["-a", "codex", "--ask", "off", "--profile", "fresh"]);
    await writeFile(
      at(".codex", "config.toml"),
      '[mcp_servers]\npounce = { url = "http://127.0.0.1:29999/mcp" }\n',
    );
    output = [];
    await runInstall(["-a", "codex", "--ask", "off", "--profile", "fresh"], {
      env: { WEB_AGENT_DAEMON_PORT: "29998" },
    });

    expect(printed()).toContain("form pounce does not rewrite");
  });

  test("leaves a pounce entry someone else wrote and exits 1", async () => {
    await writeFile(
      at(".claude.json"),
      '{"mcpServers": {"pounce": {"type": "http", "url": "http://elsewhere/mcp"}}}',
    );

    expect(await runInstall(BASIC)).toBe(1);
  });

  test("keeps a WEB_AGENT setting from an earlier run that this run's environment lacks", async () => {
    await runInstall(BASIC, { env: { WEB_AGENT_CHROME_EXECUTABLE: "/usr/bin/chromium" } });
    await runInstall(BASIC);

    expect(loadConfig({ HOME: home }).executablePath).toBe("/usr/bin/chromium");
  });

  test("lets this run's environment replace a WEB_AGENT setting from an earlier run", async () => {
    await runInstall(BASIC, { env: { WEB_AGENT_CHROME_EXECUTABLE: "/usr/bin/chromium" } });
    await runInstall(BASIC, { env: { WEB_AGENT_CHROME_EXECUTABLE: "/opt/brave/brave" } });

    expect(loadConfig({ HOME: home }).executablePath).toBe("/opt/brave/brave");
  });

  test("lets a later --ask choice replace an adapter given by WEB_AGENT_ASK_ADAPTER", async () => {
    await runInstall(BASIC, { env: { WEB_AGENT_ASK_ADAPTER: await fakeBinary() } });
    await runInstall(BASIC);

    expect(askSourceFor(loadConfig({ HOME: home })).label).toBe("off");
  });

  test("drops a WEB_AGENT_ASK_ADAPTER that an earlier version saved", async () => {
    await mkdir(at(".config", "pounce"), { recursive: true });
    await writeFile(
      at(".config", "pounce", "config.json"),
      JSON.stringify({ env: { WEB_AGENT_ASK_ADAPTER: await fakeBinary() } }),
    );
    await runInstall(BASIC);

    expect(askSourceFor(loadConfig({ HOME: home })).label).toBe("off");
  });

  test("offers the previous ask_pages choice as the default", async () => {
    await runInstall(["-a", "claude", "--ask", "adapter", "--adapter", await fakeBinary()]);
    asked = [];
    await runInstall(["-a", "claude"], { tty: true });

    expect(asked.find((question) => question.kind === "select")?.initial).toBe("adapter");
  });
});

describe("the ask_pages step", () => {
  test("stores the key from ANTHROPIC_API_KEY", async () => {
    await runInstall(["-a", "claude", "--ask", "api-key"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
    });

    expect(settings().ask).toStrictEqual({ mode: "api-key", apiKey: FAKE_KEY });
  });

  test("never prints the key", async () => {
    await runInstall(["-a", "claude", "--ask", "api-key"], {
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
    });

    expect(printed()).not.toContain(FAKE_KEY);
  });

  test("asks for the key without echo in a terminal", async () => {
    await runInstall(["-a", "claude", "--ask", "api-key"], {
      tty: true,
      answers: { secret: [FAKE_KEY] },
    });

    expect(settings().ask).toStrictEqual({ mode: "api-key", apiKey: FAKE_KEY });
  });

  test("api-key without a key and without a terminal fails", async () => {
    expect(await runInstall(["-a", "claude", "--ask", "api-key"])).toBe(1);
  });

  test("offers the Claude Code login only when there is a session", async () => {
    await runInstall(["-a", "claude"], { tty: true });

    expect(asked.find((question) => question.kind === "select")?.labels).toStrictEqual([
      "Anthropic API key",
      "My own adapter file",
      "Off",
    ]);
  });

  test("defaults to the Claude Code login when there is a session", async () => {
    await mkdir(at(".claude"), { recursive: true });
    await writeFile(at(".claude", ".credentials.json"), "{}");
    await runInstall(["-a", "claude", "--profile", "fresh"]);

    expect(settings().ask).toStrictEqual({ mode: "claude" });
  });

  test("--ask claude without a session fails", async () => {
    expect(await runInstall(["-a", "claude", "--ask", "claude"])).toBe(1);
  });
});

async function chromeProfile(dir = "Default") {
  const userData = at(".config", "google-chrome");
  await mkdir(path.join(userData, dir), { recursive: true });
  await writeFile(
    path.join(userData, "Local State"),
    JSON.stringify({
      profile: { info_cache: { [dir]: { name: "Person 1", user_name: "me@example.com" } } },
    }),
  );
  await writeFile(path.join(userData, dir, "Bookmarks"), '{"roots": {}}');
}

async function runningChrome() {
  await symlink(`host-${process.pid}`, at(".config", "google-chrome", "SingletonLock"));
}

describe("the profile step", () => {
  test("lists the user's browser profiles with their account", async () => {
    await chromeProfile();
    await runInstall(["-a", "claude", "--ask", "off"], { tty: true });

    expect(asked.find((question) => question.question.includes("profile"))?.labels).toContain(
      "Copy Google Chrome: Person 1 (me@example.com)",
    );
  });

  test("copies the chosen profile into the agent profile", async () => {
    await chromeProfile();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Default"]);

    expect(
      existsSync(path.join(loadConfig({ HOME: home }).profileDir, "Default", "Bookmarks")),
    ).toBe(true);
  });

  test("asks to close a running browser before copying its profile", async () => {
    await chromeProfile();
    await runningChrome();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Default"], {
      tty: true,
      answers: { confirm: [false] },
    });

    expect(asked.some((question) => question.question.startsWith("Close Google Chrome"))).toBe(
      true,
    );
  });

  test("copies the profile once the running browser was closed", async () => {
    await chromeProfile();
    await runningChrome();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Default"], {
      tty: true,
      answers: {
        confirm: [true],
        onConfirm: () => rm(at(".config", "google-chrome", "SingletonLock")),
      },
    });

    expect(
      existsSync(path.join(loadConfig({ HOME: home }).profileDir, "Default", "Bookmarks")),
    ).toBe(true);
  });

  test("without a terminal names how to finish once the browser is closed", async () => {
    await chromeProfile();
    await runningChrome();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Default"]);

    expect(printed()).toContain(
      "Close Google Chrome and run `pounce install --profile chrome:Default` again",
    );
  });

  test("quotes a profile key with a space in the re-run hint", async () => {
    await chromeProfile("Profile 1");
    await runningChrome();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Profile 1"]);

    expect(printed()).toContain("run `pounce install --profile 'chrome:Profile 1'` again");
  });

  test("never suggests an option install does not have", async () => {
    await chromeProfile();
    await runningChrome();
    await runInstall(["-a", "claude", "--ask", "off", "--profile", "chrome:Default"]);

    expect(printed()).not.toContain("--live");
  });

  test("prints the Chrome Sync hint for a fresh profile", async () => {
    await runInstall(BASIC);

    expect(printed()).toContain("turn on Sync");
  });
});

const SET_DEFAULT = ["xdg-settings", "set", "default-web-browser", "pounce.desktop"];

async function script(name: string, body: string) {
  const file = at("bin", name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/bin/bash\n${body}\n`);
  await chmod(file, 0o755);
}

async function systemEntry(id: string, exec: string) {
  await mkdir(at("usr-share", "applications"), { recursive: true });
  await writeFile(
    at("usr-share", "applications", id),
    `[Desktop Entry]\nVersion=1.0\nType=Application\nName=Browser\n${exec}\nMimeType=x-scheme-handler/http;x-scheme-handler/https;\n`,
  );
}

async function omarchyBrowser() {
  await script(
    "omarchy-launch-browser",
    'default_browser=$(omarchy-cmd-default-browser)\nbrowser_exec=$(sed -n "s/^Exec=\\([^ ]*\\).*/\\1/p" "$entry")\nexec setsid uwsm-app -- "$browser_exec" "$@"',
  );
  await systemEntry("omarchy-browser.desktop", "Exec=omarchy-launch-browser %U");
}

function defaultBrowser(id: string): Options {
  return {
    env: { PATH: `${at("bin")}:/usr/bin:/bin`, XDG_DATA_DIRS: at("usr-share") },
    replies: { ...NO_SYSTEMD, "xdg-settings get": { stdout: `${id}\n` } },
  };
}

describe("the desktop step", () => {
  test("makes pounce the default browser when asked", async () => {
    await runInstall([...BASIC, "--desktop"], {
      replies: { ...NO_SYSTEMD, "xdg-settings get": { stdout: "firefox.desktop\n" } },
    });

    expect(commands).toContainEqual([
      "xdg-settings",
      "set",
      "default-web-browser",
      "pounce.desktop",
    ]);
  });

  test("writes a desktop entry that runs pounce open", async () => {
    await runInstall([...BASIC, "--desktop"]);

    expect(
      await readFile(at(".local", "share", "applications", "pounce.desktop"), "utf8"),
    ).toContain(`Exec=${at(".local", "bin", "pounce")} open %U`);
  });

  test("doubles a % in the binary path, which desktop entries reserve for field codes", async () => {
    await runInstall([...BASIC, "--desktop"], { env: { XDG_BIN_HOME: at("100%") } });

    expect(
      await readFile(at(".local", "share", "applications", "pounce.desktop"), "utf8"),
    ).toContain(`Exec=${at("100%%", "pounce")} open %U`);
  });

  test("writes a backslash in the binary path as four, for the string and the quoting rule", async () => {
    await runInstall([...BASIC, "--desktop"], { env: { XDG_BIN_HOME: at("a\\b") } });

    expect(
      await readFile(at(".local", "share", "applications", "pounce.desktop"), "utf8"),
    ).toContain(`Exec="${at("a\\\\\\\\b", "pounce")}" open %U`);
  });

  test("leaves a launcher that dispatches to the default browser alone", async () => {
    await omarchyBrowser();
    await runInstall([...BASIC, "--desktop"], defaultBrowser("omarchy-browser.desktop"));

    expect(commands.some((command) => command[1] === "set")).toBe(false);
  });

  test("says what to change in a launcher that dispatches to the default browser", async () => {
    await omarchyBrowser();
    await runInstall([...BASIC, "--desktop"], defaultBrowser("omarchy-browser.desktop"));

    expect(printed()).toContain(
      `make that launcher run \`${at(".local", "bin", "pounce")} open %U\``,
    );
  });

  test("leaves alone a launcher under another name that asks xdg-settings for the default", async () => {
    await script(
      "open-my-browser",
      'browser=$(xdg-settings get default-web-browser)\nexec gtk-launch "$browser" "$@"',
    );
    await systemEntry("open-my-browser.desktop", "Exec=open-my-browser %U");
    await runInstall([...BASIC, "--desktop"], defaultBrowser("open-my-browser.desktop"));

    expect(commands.some((command) => command[1] === "set")).toBe(false);
  });

  test("replaces a browser script that only mentions xdg-settings", async () => {
    await script(
      "cromite",
      'xdg-settings check default-url-scheme-handler https >/dev/null 2>&1 || true\nexec /opt/cromite/chrome "$@"',
    );
    await systemEntry("cromite.desktop", "Exec=cromite %U");
    await runInstall([...BASIC, "--desktop"], defaultBrowser("cromite.desktop"));

    expect(commands).toContainEqual(SET_DEFAULT);
  });

  test("replaces Ubuntu's snap Firefox", async () => {
    await systemEntry(
      "firefox_firefox.desktop",
      "Exec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u",
    );
    await runInstall([...BASIC, "--desktop"], defaultBrowser("firefox_firefox.desktop"));

    expect(commands).toContainEqual(SET_DEFAULT);
  });

  test("replaces a flatpak Chrome", async () => {
    await systemEntry(
      "com.google.Chrome.desktop",
      "Exec=/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=/app/bin/chrome --file-forwarding com.google.Chrome @@u %U @@",
    );
    await runInstall([...BASIC, "--desktop"], defaultBrowser("com.google.Chrome.desktop"));

    expect(commands).toContainEqual(SET_DEFAULT);
  });

  test("replaces a browser started through a script of the user's own", async () => {
    await script("work-chrome", 'exec google-chrome --profile-directory=Work "$@"');
    await systemEntry("work-chrome.desktop", "Exec=work-chrome %U");
    await runInstall([...BASIC, "--desktop"], defaultBrowser("work-chrome.desktop"));

    expect(commands).toContainEqual(SET_DEFAULT);
  });

  test("is not touched without --desktop", async () => {
    await runInstall(BASIC);

    expect(commands.some((command) => command[0] === "xdg-settings")).toBe(false);
  });
});

test("a Chrome that does not start fails the install", async () => {
  expect(await runInstall(BASIC, { chromeOk: false })).toBe(1);
});

test("a run without a terminal that could not tell the agent keeps the remembered agents", async () => {
  await runInstall(["-a", "codex", "--ask", "off", "--profile", "fresh"]);
  await runInstall(["--ask", "off"]);

  expect(settings().agents).toStrictEqual(["codex"]);
});

test("--agent none forgets the remembered agents", async () => {
  await runInstall(["-a", "codex", "--ask", "off", "--profile", "fresh"]);
  await runInstall(["--agent", "none", "--ask", "off"]);

  expect(settings().agents).toStrictEqual([]);
});

test("a terminal run after an undetected run pre-ticks the detected agents", async () => {
  await mkdir(at(".codex"), { recursive: true });
  await runInstall(["--ask", "off"]);
  asked = [];
  await runInstall(["--ask", "off"], { tty: true });

  expect(asked.find((question) => question.kind === "pickMany")?.initial).toBe("codex");
});

test("a usage error lists the install options", async () => {
  await runInstall(["--frobnicate"]);

  expect(printed()).toContain("--profile <choice>");
});

async function invalidSettings() {
  await mkdir(at(".config", "pounce"), { recursive: true });
  await writeFile(
    at(".config", "pounce", "config.json"),
    JSON.stringify({
      ask: { mode: "api-key", apiKey: "" },
      entries: { claude: { type: "http", url: "http://127.0.0.1:29999/mcp" } },
    }),
  );
}

describe("a config.json that fails the schema", () => {
  test("does not stop install", async () => {
    await invalidSettings();

    expect(await runInstall(BASIC)).toBe(0);
  });

  test("is named with the field that is wrong", async () => {
    await invalidSettings();
    await runInstall(BASIC);

    expect(printed()).toContain("ask.apiKey");
  });

  test("is rewritten from the new answers", async () => {
    await invalidSettings();
    await runInstall(BASIC);

    expect(settings().ask).toStrictEqual({ mode: "off" });
  });

  test("keeps the entries pounce wrote, so a port change updates them", async () => {
    await invalidSettings();
    await writeFile(
      at(".claude.json"),
      '{"mcpServers": {"pounce": {"type": "http", "url": "http://127.0.0.1:29999/mcp"}}}',
    );
    await runInstall(BASIC, { env: { WEB_AGENT_DAEMON_PORT: "29998" } });

    expect(printed()).toContain("Updated pounce in Claude Code");
  });

  test("is offered for a rewrite in a terminal", async () => {
    await invalidSettings();
    await runInstall(BASIC, { tty: true });

    expect(asked.some((question) => question.question.startsWith("Rewrite"))).toBe(true);
  });

  test("is left alone when the rewrite is declined", async () => {
    await invalidSettings();
    const before = await readFile(at(".config", "pounce", "config.json"), "utf8");
    await runInstall(BASIC, { tty: true, answers: { confirm: [false] } });

    expect(await readFile(at(".config", "pounce", "config.json"), "utf8")).toBe(before);
  });
});

const BROKEN_SETTINGS = `{"ask": {"mode": "api-key", "apiKey": "${FAKE_KEY}"},}`;

async function brokenSettings() {
  await mkdir(at(".config", "pounce"), { recursive: true });
  await writeFile(at(".config", "pounce", "config.json"), BROKEN_SETTINGS, { mode: 0o644 });
}

async function settingsBackups() {
  const dir = at(".config", "pounce");
  return (await readdir(dir))
    .filter((name) => name.startsWith("config.json.bak-"))
    .map((name) => path.join(dir, name));
}

describe("a config.json that is not valid JSON", () => {
  test("is copied before it is rewritten", async () => {
    await brokenSettings();
    await runInstall(BASIC);

    const [backup] = await settingsBackups();
    expect(await readFile(backup ?? "", "utf8")).toBe(BROKEN_SETTINGS);
  });

  test("is copied to a file only the user can read", async () => {
    await brokenSettings();
    await runInstall(BASIC);

    const [backup] = await settingsBackups();
    expect((await stat(backup ?? "")).mode & 0o777).toBe(0o600);
  });

  test("names where the copy is", async () => {
    await brokenSettings();
    await runInstall(BASIC);

    const [backup] = await settingsBackups();
    expect(printed()).toContain(`~/${path.relative(home, backup ?? "")}`);
  });

  test("is copied once per run", async () => {
    await brokenSettings();
    await runInstall(BASIC);

    expect(await settingsBackups()).toHaveLength(1);
  });

  test("is not copied when the rewrite is declined", async () => {
    await brokenSettings();
    await runInstall(BASIC, { tty: true, answers: { confirm: [false] } });

    expect(await settingsBackups()).toStrictEqual([]);
  });
});

test("a valid config.json is not copied", async () => {
  await runInstall(BASIC);
  await runInstall(BASIC);

  expect(await settingsBackups()).toStrictEqual([]);
});

describe("an API key of only spaces", () => {
  test("fails the install", async () => {
    expect(
      await runInstall(["-a", "claude", "--ask", "api-key"], {
        tty: true,
        answers: { secret: ["   "] },
      }),
    ).toBe(1);
  });

  test("is never stored", async () => {
    await runInstall(["-a", "claude", "--ask", "api-key"], {
      tty: true,
      answers: { secret: ["   "] },
    });

    expect(await readFile(at(".config", "pounce", "config.json"), "utf8")).not.toContain(
      '"apiKey"',
    );
  });
});
