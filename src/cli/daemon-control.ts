import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { PRODUCT_NAME, type Config } from "../config/config.ts";
import { repeatUntil } from "../shared/async.ts";
import {
  daemonPresence,
  type DaemonRegistry,
  refuseSecondDaemon,
  runningDaemon,
} from "../server/daemon.ts";
import { runCommand, type Runner, selfCommand } from "./process.ts";

const START_TIMEOUT_MS = 20_000;
const POLL_MS = 200;
const LOG_TAIL_LINES = 20;
const STOPPED_UNIT_STATES = new Set(["auto-restart", "failed", "dead", "exited"]);

export const SERVICE_NAME = `${PRODUCT_NAME}.service`;
export const LEGACY_SERVICE = "claude-code-pair-web-agent.service";

export type Spawned = { exited: () => boolean };

export type DaemonControl = {
  runner: Runner;
  spawnDetached: (
    command: readonly string[],
    logFile: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => Spawned;
};

function spawnDetached(
  command: readonly string[],
  logFile: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Spawned {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const output = openSync(logFile, "a");
  const [file = "", ...args] = command;
  const child = spawn(file, args, { cwd, env, detached: true, stdio: ["ignore", output, output] });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.once("error", () => {
    exited = true;
  });
  child.unref();
  return { exited: () => exited };
}

export const defaultDaemonControl: DaemonControl = { runner: runCommand, spawnDetached };

export function daemonLogFile(config: Config) {
  return path.join(config.dataDir, "daemon.log");
}

function logTail(file: string) {
  try {
    return readFileSync(file, "utf8").trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return "";
  }
}

async function waitForDaemon(
  config: Config,
  deadline: number,
  gaveUp: () => boolean | Promise<boolean>,
) {
  let stopped = false;
  return repeatUntil(
    async () => {
      const registry = await runningDaemon(config);
      stopped = !registry && (await gaveUp());
      return registry;
    },
    { delayMs: () => POLL_MS, giveUp: () => stopped || Date.now() >= deadline },
  );
}

function installedUnit(config: Config) {
  if (existsSync(config.serviceFile)) return SERVICE_NAME;
  const legacy = path.join(path.dirname(config.serviceFile), LEGACY_SERVICE);
  return existsSync(legacy) ? LEGACY_SERVICE : undefined;
}

async function unitStopped(unit: string, control: DaemonControl) {
  const shown = await control.runner([
    "systemctl",
    "--user",
    "show",
    "--property=SubState",
    "--value",
    unit,
  ]);
  return STOPPED_UNIT_STATES.has(shown.stdout.trim());
}

async function startService(config: Config, control: DaemonControl, deadline: number) {
  const unit = installedUnit(config);
  if (!unit) return undefined;
  const started = await control.runner(["systemctl", "--user", "start", unit]);
  if (started.code !== 0) return undefined;
  const registry = await waitForDaemon(config, deadline, () => unitStopped(unit, control));
  if (registry) return registry;
  throw new Error(
    `${unit} started, but its daemon did not come up; see \`journalctl --user -u ${unit}\`.`,
  );
}

async function spawnDaemon(
  config: Config,
  env: NodeJS.ProcessEnv,
  control: DaemonControl,
  deadline: number,
): Promise<DaemonRegistry> {
  const logFile = daemonLogFile(config);
  const child = control.spawnDetached([...selfCommand(), "--daemon"], logFile, config.homeDir, env);
  const registry = await waitForDaemon(config, deadline, child.exited);
  if (registry) return registry;
  const tail = logTail(logFile);
  throw new Error(
    `The pounce daemon did not start within ${START_TIMEOUT_MS / 1000} s.${tail ? `\nLast lines of ${logFile}:\n${tail}` : ""}`,
  );
}

export async function ensureDaemon(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  control: DaemonControl = defaultDaemonControl,
): Promise<DaemonRegistry> {
  const { state, registry } = await daemonPresence(config);
  if (registry && state === "running") return registry;
  if (registry && state === "not responding") throw new Error(refuseSecondDaemon(state, registry));
  const deadline = Date.now() + START_TIMEOUT_MS;
  return (
    (await startService(config, control, deadline)) ?? spawnDaemon(config, env, control, deadline)
  );
}
