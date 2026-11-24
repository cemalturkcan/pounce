import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Config, loadConfig } from "../config/config.ts";
import { serviceUnit } from "../install/service.ts";
import { stopDaemon } from "../server/daemon.ts";
import { freePort, healthy, type SpawnedDaemon, spawnDaemon } from "../../tests/daemon.ts";
import { defaultDaemonControl, ensureDaemon } from "./daemon-control.ts";
import type { Runner } from "./process.ts";

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
});

async function isolatedEnv() {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-control-"));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    WEB_AGENT_DAEMON_DATA_DIR: path.join(home, "data"),
    WEB_AGENT_DAEMON_PORT: String(freePort()),
    WEB_AGENT_HEADLESS: "true",
    WEB_AGENT_SECRETS: "none",
    WEB_AGENT_PASSWORD_STORE: "basic",
  };
  const config = loadConfig(env);
  cleanups.push(async () => {
    await stopDaemon(config);
  });
  return { home, env, config };
}

async function installUnit(config: Config, env: NodeJS.ProcessEnv) {
  await mkdir(path.dirname(config.serviceFile), { recursive: true });
  await writeFile(config.serviceFile, serviceUnit(["/usr/bin/pounce"], env, false));
}

const failingRunner: Runner = async () => ({ code: 1, stdout: "", stderr: "no systemd" });

describe("ensureDaemon with no daemon and no service", () => {
  test("starts a detached daemon that answers its health check", async () => {
    const { env, config } = await isolatedEnv();
    await ensureDaemon(config, env);

    expect(await healthy(config.port)).toBe(true);
  }, 40_000);
});

describe("ensureDaemon with pounce.service installed", () => {
  test("starts the service instead of a detached daemon", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, env);
    const commands: string[][] = [];
    let service: SpawnedDaemon | undefined;
    const runner: Runner = async (command) => {
      commands.push([...command]);
      service = await spawnDaemon(config.dataDir, env);
      cleanups.push(() => service?.stop() ?? Promise.resolve());
      return { code: 0, stdout: "", stderr: "" };
    };
    const registry = await ensureDaemon(config, env, { ...defaultDaemonControl, runner });

    expect({ commands, pid: registry.pid }).toStrictEqual({
      commands: [["systemctl", "--user", "start", "pounce.service"]],
      pid: service?.process.pid ?? -1,
    });
  }, 40_000);

  test("falls back to a detached daemon when systemctl fails", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, env);
    await ensureDaemon(config, env, { ...defaultDaemonControl, runner: failingRunner });

    expect(await healthy(config.port)).toBe(true);
  }, 40_000);
});

describe("ensureDaemon when the daemon exits at once", () => {
  test("says it did not start and shows its output", async () => {
    const { env, config } = await isolatedEnv();
    const held = Bun.listen({ hostname: "127.0.0.1", port: config.port, socket: { data() {} } });
    cleanups.push(async () => held.stop(true));

    await expect(ensureDaemon(config, env)).rejects.toThrow(/did not start[\s\S]*in use/);
  }, 40_000);
});

function recordingControl(commands: string[][], subState: string) {
  const spawned: string[][] = [];
  const runner: Runner = async (command) => {
    commands.push([...command]);
    if (command[2] === "show") return { code: 0, stdout: `${subState}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    spawned,
    control: {
      runner,
      spawnDetached: (command: readonly string[]) => {
        spawned.push([...command]);
        return { exited: () => true };
      },
    },
  };
}

describe("ensureDaemon when pounce.service starts but its daemon exits", () => {
  test("names the unit's journal", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, env);
    const { control } = recordingControl([], "auto-restart");

    await expect(ensureDaemon(config, env, control)).rejects.toThrow(
      "journalctl --user -u pounce.service",
    );
  });

  test("gives up well before an MCP client's startup timeout", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, env);
    const { control } = recordingControl([], "auto-restart");
    const startedAt = Date.now();
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  test("does not start a second daemon beside the unit", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, env);
    const { control, spawned } = recordingControl([], "auto-restart");
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(spawned).toStrictEqual([]);
  });
});

async function defaultEnv() {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-control-"));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  await mkdir(path.join(home, ".local", "share", "claude-code-pair", "web-agent"), {
    recursive: true,
  });
  return { env, config: loadConfig(env) };
}

const OWNER_LEGACY_UNIT = [
  "[Service]",
  "ExecStart=/usr/bin/bun src/server.ts --daemon",
  "Environment=WEB_AGENT_DAEMON_DATA_DIR=%h/.local/share/claude-code-pair/web-agent",
  "",
].join("\n");

async function installLegacyUnit(config: Config) {
  await mkdir(path.dirname(config.serviceFile), { recursive: true });
  await writeFile(
    path.join(path.dirname(config.serviceFile), "claude-code-pair-web-agent.service"),
    OWNER_LEGACY_UNIT,
  );
}

describe("ensureDaemon with only the legacy claude-code-pair-web-agent.service", () => {
  test("starts that unit for the default port and data dir", async () => {
    const { env, config } = await defaultEnv();
    await installLegacyUnit(config);
    const commands: string[][] = [];
    const { control } = recordingControl(commands, "failed");
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(commands[0]).toStrictEqual([
      "systemctl",
      "--user",
      "start",
      "claude-code-pair-web-agent.service",
    ]);
  });

  test("starts a daemon directly when the port is overridden", async () => {
    const { env, config } = await defaultEnv();
    await installLegacyUnit(config);
    const portEnv = { ...env, WEB_AGENT_DAEMON_PORT: String(freePort()) };
    const { control, spawned } = recordingControl([], "failed");
    await ensureDaemon(loadConfig(portEnv), portEnv, control).catch(() => undefined);

    expect(spawned.map((command) => command.at(-1))).toStrictEqual(["--daemon"]);
  });
});

describe("ensureDaemon with pounce.service for another setup", () => {
  test("starts a daemon directly when the unit serves another port", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, { ...env, WEB_AGENT_DAEMON_PORT: String(freePort()) });
    const { control, spawned } = recordingControl([], "failed");
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(spawned.map((command) => command.at(-1))).toStrictEqual(["--daemon"]);
  });

  test("starts a daemon directly when the unit serves another data dir", async () => {
    const { env, config } = await isolatedEnv();
    await installUnit(config, { ...env, WEB_AGENT_DAEMON_DATA_DIR: path.join(env.HOME, "other") });
    const { control, spawned } = recordingControl([], "failed");
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(spawned.map((command) => command.at(-1))).toStrictEqual(["--daemon"]);
  });

  test("starts the unit whose data dir has a space and a percent sign", async () => {
    const { env: base } = await isolatedEnv();
    const env = { ...base, WEB_AGENT_DAEMON_DATA_DIR: path.join(base.HOME, "my 100% data") };
    const config = loadConfig(env);
    await installUnit(config, env);
    const commands: string[][] = [];
    const { control } = recordingControl(commands, "failed");
    await ensureDaemon(config, env, control).catch(() => undefined);

    expect(commands[0]).toStrictEqual(["systemctl", "--user", "start", "pounce.service"]);
  });
});
