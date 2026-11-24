import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config/config.ts";
import { legacyUnitServes, SERVICE_NAME } from "../cli/daemon-control.ts";
import type { Runner } from "../cli/process.ts";
import { inSequence } from "../shared/async.ts";

const DISPLAY_VARIABLES = new Set(["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]);

function systemdQuote(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function execLine(command: readonly string[]) {
  const [program = "", ...args] = command;
  return [
    systemdQuote(program.replaceAll("%", "%%")),
    ...args.map((arg) => systemdQuote(arg.replaceAll("%", "%%").replaceAll("$", "$$$$"))),
  ].join(" ");
}

function environmentLine(key: string, value: string) {
  return `Environment=${systemdQuote(`${key}=${value}`.replaceAll("%", "%%"))}`;
}

function presentEntries(env: NodeJS.ProcessEnv, keep: (key: string) => boolean) {
  return Object.entries(env)
    .flatMap(([key, value]) => (keep(key) && value ? [[key, value] as const] : []))
    .toSorted(([left], [right]) => left.localeCompare(right));
}

export function serviceUnit(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  graphical: boolean,
) {
  const target = graphical ? "graphical-session.target" : "default.target";
  const display = graphical
    ? []
    : presentEntries(env, (key) => DISPLAY_VARIABLES.has(key)).map(([key, value]) =>
        environmentLine(key, value),
      );
  return [
    "[Unit]",
    "Description=pounce browser daemon for AI agents",
    ...(graphical ? [`After=${target}`, `PartOf=${target}`] : []),
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execLine([...command, "--daemon"])}`,
    "Restart=on-failure",
    "RestartSec=5",
    "SuccessExitStatus=143",
    "PassEnvironment=DISPLAY WAYLAND_DISPLAY XAUTHORITY",
    ...display,
    "",
    "[Install]",
    `WantedBy=${target}`,
    "",
  ].join("\n");
}

export type ServiceResult =
  | { kind: "unavailable" }
  | { kind: "legacy" }
  | { kind: "failed"; step: string; detail: string }
  | { kind: "installed"; started: boolean; changed: boolean };

export async function systemdAvailable(runner: Runner) {
  return (await runner(["systemctl", "--user", "show-environment"])).code === 0;
}

export async function installService(
  config: Config,
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  runner: Runner,
  daemonRunning: boolean,
): Promise<ServiceResult> {
  if (legacyUnitServes(config, env)) return { kind: "legacy" };
  if (!(await systemdAvailable(runner))) return { kind: "unavailable" };
  const graphical =
    (
      await runner(["systemctl", "--user", "is-active", "graphical-session.target"])
    ).stdout.trim() === "active";
  const unit = serviceUnit(command, env, graphical);
  const changed =
    !existsSync(config.serviceFile) || readFileSync(config.serviceFile, "utf8") !== unit;
  if (changed) {
    mkdirSync(path.dirname(config.serviceFile), { recursive: true });
    writeFileSync(config.serviceFile, unit);
  }
  const steps: [string, string[]][] = [
    ["daemon-reload", ["systemctl", "--user", "daemon-reload"]],
    ["enable", ["systemctl", "--user", "enable", SERVICE_NAME]],
  ];
  if (!daemonRunning) steps.push(["start", ["systemctl", "--user", "start", SERVICE_NAME]]);
  let failure: { step: string; detail: string } | undefined;
  await inSequence(steps, async ([step, commandLine]) => {
    if (failure) return;
    const result = await runner(commandLine);
    if (result.code !== 0) failure = { step, detail: result.stderr.trim() };
  });
  if (failure) return { kind: "failed", ...failure };
  return { kind: "installed", started: !daemonRunning, changed };
}
