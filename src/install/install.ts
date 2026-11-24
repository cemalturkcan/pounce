import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import {
  defaultImportOptions,
  ImportError,
  importProfile,
  renderImportFailure,
  renderImportReport,
  SourceBrowserRunning,
} from "../browser/import-profile.ts";
import { ensureDaemon, SERVICE_NAME } from "../cli/daemon-control.ts";
import { runCommand, type Runner, selfCommand } from "../cli/process.ts";
import { type Config, loadConfigLeniently } from "../config/config.ts";
import { type AskMode, type AskSetting, type Settings } from "../config/settings.ts";
import { SERVER_VERSION } from "../config/version.ts";
import { daemonHoldsProfile, type DaemonRegistry, runningDaemon } from "../server/daemon.ts";
import { messageOf } from "../shared/errors.ts";
import { readConfig, writeEntry } from "./agent-config.ts";
import {
  AGENT_NAMES,
  type AgentName,
  agentName,
  type AgentSpec,
  agentSpecs,
  callingAgent,
} from "./agents.ts";
import { addToPath, binDir, type Executable, onPathAlready, placeBinary } from "./binary.ts";
import { installDesktop } from "./desktop.ts";
import { type ChromeCheck, checkChrome } from "./health.ts";
import {
  BROWSERS,
  type BrowserId,
  browserName,
  browserUserDataDir,
  describeProfile,
  listProfiles,
  profileKey,
} from "./profiles.ts";
import { type Choice, PromptCancelled, type Prompts, terminalPrompts } from "./prompt.ts";
import { installService } from "./service.ts";
import { installSkill } from "./skill.ts";

const ASK_MODES = ["claude", "api-key", "adapter", "off"] as const;
const FIRST_PROMPT = "Use pounce to open news.ycombinator.com and tell me the top story.";

export type InstallIo = {
  env: NodeJS.ProcessEnv;
  tty: boolean;
  print: (line: string) => void;
  prompts: Prompts;
  runner: Runner;
  executable: Executable;
  sourceCommand: string[];
  onPath: (binary: string) => boolean;
  ensureDaemon: (config: Config, env: NodeJS.ProcessEnv) => Promise<DaemonRegistry>;
  checkChrome: (config: Config) => Promise<ChromeCheck>;
};

type AgentEntries = NonNullable<Settings["entries"]>;

export class InstallUsageError extends Error {}

export const INSTALL_USAGE = `Usage: pounce install [options]

  -a, --agent <names...>   ${AGENT_NAMES.join(", ")}, or none to print the entry
  -y, --yes                set up every agent found on this machine
  --ask <mode>             claude, api-key (key from ANTHROPIC_API_KEY or a prompt), adapter or off
  --adapter <path>         the adapter module for --ask adapter
  --profile <choice>       fresh, or <browser>[:<profile dir>] with browser chrome, chromium, brave or edge
  --desktop, --no-desktop  make pounce the default browser, or leave it
  --no-modify-path         do not add ~/.local/bin to PATH in the shell startup file`;

export type InstallFlags = {
  agents: AgentName[];
  none: boolean;
  yes: boolean;
  ask?: AskMode;
  adapter?: string;
  profile?: string;
  desktop?: boolean;
  modifyPath: boolean;
};

function isAskMode(value: string): value is AskMode {
  return ASK_MODES.some((mode) => mode === value);
}

export function parseInstallFlags(args: readonly string[]): InstallFlags {
  const flags: InstallFlags = { agents: [], none: false, yes: false, modifyPath: true };
  const value = (index: number, flag: string) => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("-"))
      throw new InstallUsageError(`${flag} needs a value.`);
    return next;
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-a" || arg === "--agent") {
      value(index, arg);
      while (args[index + 1] !== undefined && !args[index + 1]?.startsWith("-")) {
        index += 1;
        for (const part of (args[index] ?? "").split(",").filter(Boolean)) {
          if (part === "none") {
            flags.none = true;
            continue;
          }
          const name = agentName(part);
          if (!name)
            throw new InstallUsageError(
              `Unknown agent "${part}". Choose from ${AGENT_NAMES.join(", ")}, or none.`,
            );
          if (!flags.agents.includes(name)) flags.agents.push(name);
        }
      }
    } else if (arg === "-y" || arg === "--yes") flags.yes = true;
    else if (arg === "--ask") {
      const mode = value(index, arg);
      if (!isAskMode(mode))
        throw new InstallUsageError(`--ask takes one of ${ASK_MODES.join(", ")}.`);
      flags.ask = mode;
      index += 1;
    } else if (arg === "--adapter") {
      flags.adapter = value(index, arg);
      index += 1;
    } else if (arg === "--profile") {
      flags.profile = value(index, arg);
      index += 1;
    } else if (arg === "--desktop") flags.desktop = true;
    else if (arg === "--no-desktop") flags.desktop = false;
    else if (arg === "--no-modify-path") flags.modifyPath = false;
    else throw new InstallUsageError(`Unknown install option ${arg}.`);
  }
  if (flags.none && flags.agents.length)
    throw new InstallUsageError("--agent none cannot be combined with agent names.");
  return flags;
}

class StepFailure extends Error {}

type Run = {
  io: InstallIo;
  flags: InstallFlags;
  config: Config;
  settings: Settings;
  home: string;
  configHome: string;
  dataHome: string;
  failed: boolean;
};

const ok = (text: string) => `${styleText("green", "✓")} ${text}`;
const warn = (text: string) => `${styleText("yellow", "!")} ${text}`;
const bad = (text: string) => `${styleText("red", "✗")} ${text}`;

function tilde(run: Run, file: string) {
  return file.startsWith(`${run.home}/`) ? `~/${file.slice(run.home.length + 1)}` : file;
}

function fail(run: Run, text: string) {
  run.failed = true;
  run.io.print(bad(text));
}

function saveSettings(run: Run) {
  mkdirSync(run.config.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(run.config.configFile, `${JSON.stringify(run.settings, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(run.config.configFile, 0o600);
}

function binaryStep(run: Run) {
  const { io, flags } = run;
  const targetDir = binDir(run.home, io.env);
  const placement = placeBinary(io.executable, io.sourceCommand, targetDir);
  if (placement.placed)
    io.print(ok(`Installed pounce ${SERVER_VERSION} to ${tilde(run, placement.placed)}`));
  else if (placement.command.length === 1)
    io.print(ok(`pounce ${SERVER_VERSION} runs from ${tilde(run, placement.command[0] ?? "")}`));
  else io.print(ok(`pounce ${SERVER_VERSION} runs from source (${placement.command.join(" ")})`));
  if (placement.command.length === 1 && placement.command[0]?.startsWith(targetDir)) {
    if (!flags.modifyPath) {
      if (!onPathAlready(targetDir, io.env))
        io.print(
          warn(`${tilde(run, targetDir)} is not on your PATH; add it to run pounce by name.`),
        );
    } else {
      const file = addToPath(targetDir, run.home, io.env, run.configHome);
      if (file)
        io.print(
          ok(
            `Added ${tilde(run, targetDir)} to PATH in ${tilde(run, file)}; open a new terminal to use it.`,
          ),
        );
    }
  }
  return placement.command;
}

function agentPlan(run: Run, specs: AgentSpec[]) {
  const { flags, io } = run;
  const detected = specs.filter((spec) => spec.installed).map((spec) => spec.name);
  if (flags.none) return { picker: false, selected: [] };
  if (flags.agents.length) return { picker: false, selected: flags.agents };
  const caller = callingAgent(io.env);
  if (caller) return { picker: false, selected: [caller], caller };
  if (flags.yes) return { picker: false, selected: detected };
  if (!io.tty) return { picker: false, selected: [], undetected: true };
  const remembered = run.settings.agents?.flatMap((name) => agentName(name) ?? []);
  return { picker: true, selected: remembered?.length ? remembered : detected };
}

function manualEntry(run: Run, command: readonly string[]) {
  const http = { mcpServers: { pounce: { type: "http", url: run.config.endpoint } } };
  const [file = "", ...args] = command;
  const stdio = { mcpServers: { pounce: { command: file, args: [...args, "mcp"] } } };
  run.io.print("  Add pounce to an agent as an MCP server, over HTTP:");
  run.io.print(`    ${JSON.stringify(http)}`);
  run.io.print("  or, for an agent that only runs stdio servers:");
  run.io.print(`    ${JSON.stringify(stdio)}`);
}

function configureAgent(
  run: Run,
  spec: AgentSpec,
  command: readonly string[],
  entries: AgentEntries,
) {
  const where = tilde(run, spec.target.file);
  try {
    const entry = spec.entry(run.config.endpoint, command, readConfig(spec.target));
    const outcome = writeEntry(spec.target, entry, run.settings.entries?.[spec.name]);
    if (outcome === "conflict") {
      fail(
        run,
        `${spec.label} already has a different server named pounce in ${where}; left it unchanged.`,
      );
      return false;
    }
    entries[spec.name] = entry;
    run.io.print(
      ok(
        outcome === "unchanged"
          ? `${spec.label} already has pounce (${where})`
          : `${outcome === "added" ? "Added" : "Updated"} pounce in ${spec.label} (${where})`,
      ),
    );
    return true;
  } catch (cause) {
    fail(run, `Could not edit ${where} for ${spec.label}: ${messageOf(cause)}`);
    return false;
  }
}

async function agentsStep(run: Run, command: readonly string[]) {
  const { io } = run;
  const specs = agentSpecs({
    home: run.home,
    configHome: run.configHome,
    env: io.env,
    onPath: io.onPath,
  });
  const plan = agentPlan(run, specs);
  if (plan.caller)
    io.print(
      ok(
        `${specs.find((spec) => spec.name === plan.caller)?.label} is running this, so pounce is set up for it.`,
      ),
    );
  const ordered = specs.toSorted((left, right) => Number(right.installed) - Number(left.installed));
  const choices: Choice<AgentName>[] = ordered.map((spec) => ({
    value: spec.name,
    label: spec.label,
    hint: spec.installed ? "(found)" : undefined,
  }));
  const selected = plan.picker
    ? await io.prompts.pickMany("Set pounce up in these agents?", choices, plan.selected)
    : plan.selected;
  if (plan.undetected) {
    io.print(warn("Could not tell which agent runs this, so no agent was configured."));
    io.print(
      `  Run \`pounce install --agent <name>\` with one of ${AGENT_NAMES.join(", ")}, or add the entry below by hand.`,
    );
  }
  const entries: AgentEntries = { ...run.settings.entries };
  const chosen = specs.filter((spec) => selected.includes(spec.name));
  const configured = chosen.filter((spec) => configureAgent(run, spec, command, entries));
  const skillDirs = [
    ...new Set(configured.flatMap((spec) => (spec.skillsDir ? [spec.skillsDir] : []))),
  ];
  for (const dir of skillDirs) {
    const { file, changed } = installSkill(dir);
    io.print(ok(`${changed ? "Copied" : "Kept"} the pounce skill at ${tilde(run, file)}`));
  }
  if (!chosen.length) manualEntry(run, command);
  run.settings = { ...run.settings, agents: selected, entries };
  saveSettings(run);
  return configured;
}

function claudeSession(run: Run) {
  const dir = run.io.env.CLAUDE_CONFIG_DIR?.trim() || path.join(run.home, ".claude");
  return existsSync(path.join(dir, ".credentials.json"));
}

async function apiKey(run: Run, previous: AskSetting | undefined) {
  const { io } = run;
  const fromEnv = io.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const stored = previous?.mode === "api-key" ? previous.apiKey : undefined;
  if (!io.tty) {
    const key = fromEnv ?? stored;
    if (!key) throw new StepFailure("--ask api-key needs ANTHROPIC_API_KEY in the environment.");
    return key;
  }
  if (fromEnv && (await io.prompts.confirm("Store the key from ANTHROPIC_API_KEY?", true)))
    return fromEnv;
  if (stored && (await io.prompts.confirm("Keep the stored Anthropic API key?", true)))
    return stored;
  const typed = (await io.prompts.secret("Anthropic API key (input hidden):")).trim();
  if (!typed) throw new StepFailure("No Anthropic API key was entered, so none was stored.");
  return typed;
}

async function adapterPath(run: Run, previous: AskSetting | undefined) {
  const { io, flags } = run;
  const remembered = previous?.mode === "adapter" ? previous.path : run.config.askAdapterPath;
  const file =
    flags.adapter ??
    (io.tty
      ? await io.prompts.text("Path to your adapter module:", remembered)
      : previous?.mode === "adapter"
        ? previous.path
        : undefined);
  if (!file) throw new StepFailure("--ask adapter needs --adapter <absolute path to the module>.");
  if (!path.isAbsolute(file)) throw new StepFailure(`The adapter path must be absolute: ${file}`);
  if (!existsSync(file)) throw new StepFailure(`No adapter module at ${file}.`);
  return file;
}

async function askStep(run: Run): Promise<AskSetting | undefined> {
  const { io, flags } = run;
  const previous = run.settings.ask;
  const session = claudeSession(run);
  const fallback: AskMode = session ? "claude" : "off";
  const remembered =
    previous?.mode === "claude" && !session ? fallback : (previous?.mode ?? fallback);
  const choices: Choice<AskMode>[] = [
    ...(session
      ? [
          {
            value: "claude" as const,
            label: "Claude Code login",
            hint: "(uses your Claude subscription)",
          },
        ]
      : []),
    { value: "api-key", label: "Anthropic API key" },
    { value: "adapter", label: "My own adapter file" },
    { value: "off", label: "Off" },
  ];
  const mode =
    flags.ask ??
    (io.tty
      ? await io.prompts.select(
          "Which model should ask_pages and compare_design use?",
          choices,
          remembered,
        )
      : remembered);
  try {
    if (mode === "claude") {
      if (!session)
        throw new StepFailure(
          "No Claude Code login was found (~/.claude/.credentials.json); sign in with `claude` or pick another --ask mode.",
        );
      io.print(ok("ask_pages uses your Claude Code login"));
      return { mode };
    }
    if (mode === "api-key") {
      const key = await apiKey(run, previous);
      io.print(
        ok(
          `ask_pages uses an Anthropic API key, stored in ${tilde(run, run.config.configFile)} (readable only by you)`,
        ),
      );
      return { mode, apiKey: key };
    }
    if (mode === "adapter") {
      const file = await adapterPath(run, previous);
      io.print(ok(`ask_pages uses the adapter ${tilde(run, file)}`));
      return { mode, path: file };
    }
    io.print(ok("ask_pages and the compare_design model layer are off"));
    return { mode };
  } catch (cause) {
    if (!(cause instanceof StepFailure)) throw cause;
    fail(run, cause.message);
    return undefined;
  }
}

function agentProfileExists(config: Config) {
  try {
    return readdirSync(config.profileDir).length > 0;
  } catch {
    return false;
  }
}

function parseProfileChoice(value: string) {
  if (value === "fresh" || value === "keep") return value;
  const [browser = "", dir = "Default"] = value.split(/:(.*)/s);
  const known = BROWSERS.find((candidate) => candidate.id === browser);
  if (!known)
    throw new StepFailure(
      `--profile takes fresh or <browser>[:<profile dir>] with browser one of ${BROWSERS.map((candidate) => candidate.id).join(", ")}.`,
    );
  return { browser: known.id, dir: dir || "Default" };
}

async function profileStep(run: Run) {
  const { io, flags, config } = run;
  const exists = agentProfileExists(config);
  const profiles = listProfiles(run.configHome);
  let choice: string;
  if (flags.profile) choice = flags.profile;
  else if (io.tty) {
    const choices: Choice<string>[] = [
      ...(exists
        ? [{ value: "keep", label: "Keep the current agent profile" }]
        : [{ value: "fresh", label: "Fresh profile", hint: "(sign in to Chrome there to sync)" }]),
      ...profiles.map((profile) => ({
        value: profileKey(profile),
        label: `Copy ${describeProfile(profile)}`,
      })),
    ];
    choice = await io.prompts.select(
      "Which browser profile should pounce start from?",
      choices,
      exists ? "keep" : "fresh",
    );
  } else choice = "keep";
  let parsed: ReturnType<typeof parseProfileChoice>;
  try {
    parsed = parseProfileChoice(choice);
  } catch (cause) {
    if (!(cause instanceof StepFailure)) throw cause;
    fail(run, cause.message);
    return;
  }
  if (parsed === "keep" || parsed === "fresh") {
    if (exists) io.print(ok(`Keeping the agent profile at ${tilde(run, config.profileDir)}`));
    else {
      io.print(ok(`pounce starts with a fresh profile at ${tilde(run, config.profileDir)}`));
      io.print(
        "  Sign in to Chrome in the pounce window and turn on Sync to bring your bookmarks, passwords and sessions.",
      );
    }
    run.settings = { ...run.settings, profile: run.settings.profile ?? "fresh" };
    return;
  }
  await importStep(run, parsed.browser, parsed.dir);
}

async function importStep(run: Run, browser: BrowserId, dir: string) {
  const { io, config } = run;
  const options = {
    ...defaultImportOptions([]),
    from: browserUserDataDir(browser, run.configHome),
    profile: dir,
    live: false,
  };
  const key = profileKey({ browser, dir });
  const name = browserName(browser);
  try {
    const report = await importProfile(config, options, () => daemonHoldsProfile(config));
    io.print(ok(renderImportReport(config, options, report).split("\n").join("\n  ")));
    run.settings = { ...run.settings, profile: key };
  } catch (cause) {
    if (cause instanceof SourceBrowserRunning) {
      if (io.tty && (await io.prompts.confirm(`Close ${name}, then try the copy again?`, true)))
        return importStep(run, browser, dir);
      fail(
        run,
        `${name} is running. Close ${name} and run \`pounce install --profile ${key}\` again.`,
      );
    } else if (cause instanceof ImportError) fail(run, renderImportFailure(config, cause));
    else fail(run, messageOf(cause));
  }
}

async function serviceStep(run: Run, command: readonly string[]) {
  const { io, config } = run;
  const running = await runningDaemon(config);
  const result = await installService(config, command, io.env, io.runner, running !== undefined);
  if (result.kind === "legacy")
    io.print(
      warn(
        "claude-code-pair-web-agent.service already runs the daemon here, so pounce.service was not created.",
      ),
    );
  else if (result.kind === "unavailable")
    io.print(
      warn(
        "systemd --user is not available, so no service was set up; run `pounce daemon start` after a reboot.",
      ),
    );
  else if (result.kind === "failed")
    fail(run, `systemctl --user ${result.step} ${SERVICE_NAME} failed: ${result.detail}`);
  else if (result.started) io.print(ok(`${SERVICE_NAME} is enabled and started`));
  else
    io.print(
      ok(
        `${SERVICE_NAME} is enabled; the daemon already running (pid ${running?.pid}) keeps serving until it stops`,
      ),
    );
  return running;
}

async function desktopStep(run: Run, command: readonly string[]) {
  const { io, flags } = run;
  const display = Boolean(io.env.DISPLAY || io.env.WAYLAND_DISPLAY);
  const wanted =
    flags.desktop ??
    (io.tty && display
      ? await io.prompts.confirm(
          "Open links from other apps in pounce (desktop entry and default browser)?",
          run.settings.desktop ?? false,
        )
      : (run.settings.desktop ?? false));
  run.settings = { ...run.settings, desktop: wanted };
  if (!wanted) return;
  const result = await installDesktop(command, run.dataHome, io.env, io.runner);
  if (result.kind === "already") io.print(ok("pounce is already the default browser"));
  else if (result.kind === "default")
    io.print(ok("pounce.desktop added and set as the default browser"));
  else if (result.kind === "wrapper") {
    io.print(
      warn(
        `Your default browser is ${result.current}, a launcher that runs \`${result.exec}\`, so it was left as is.`,
      ),
    );
    io.print(
      `  To send links to pounce, make that launcher run \`${[...command, "open"].join(" ")} %U\` instead.`,
    );
  } else fail(run, `xdg-settings could not make pounce the default browser: ${result.detail}`);
}

async function healthStep(run: Run, before: DaemonRegistry | undefined, askChanged: boolean) {
  const { io, config } = run;
  try {
    const registry = await io.ensureDaemon(config, io.env);
    io.print(
      ok(
        `Daemon answers at ${registry.endpoint} (pounce ${registry.version}, pid ${registry.pid})`,
      ),
    );
    const restart = existsSync(config.serviceFile)
      ? `systemctl --user restart ${SERVICE_NAME}`
      : "pounce daemon stop && pounce daemon start";
    if (registry.version !== SERVER_VERSION)
      io.print(
        warn(
          `The running daemon is pounce ${registry.version}; restart it to use ${SERVER_VERSION}: ${restart}`,
        ),
      );
    else if (before && askChanged)
      io.print(warn(`Restart the daemon to apply the new ask_pages setting: ${restart}`));
  } catch (cause) {
    fail(run, `The daemon did not start: ${messageOf(cause)}`);
  }
  const chrome = await io.checkChrome(config);
  if (chrome.ok) io.print(ok(`Chrome starts headless (${chrome.executable})`));
  else
    fail(
      run,
      `Chrome did not start (${chrome.executable}: ${chrome.detail}). Install Google Chrome, or set WEB_AGENT_CHROME_EXECUTABLE to a Chromium-based browser.`,
    );
}

async function rewriteInvalidSettings(run: Run, problem: string) {
  const { io } = run;
  const file = tilde(run, run.config.configFile);
  io.print(warn(`${file} does not match what pounce expects: ${problem}`));
  if (!io.tty) {
    io.print("  It is rewritten from this run's choices; the settings that were valid are kept.");
    return true;
  }
  if (await io.prompts.confirm(`Rewrite ${file} from your answers?`, true)) return true;
  io.print(bad(`Left ${file} as it is; fix it by hand or run \`pounce install\` again.`));
  return false;
}

export async function install(args: readonly string[], io: InstallIo): Promise<number> {
  let flags: InstallFlags;
  let loaded: ReturnType<typeof loadConfigLeniently>;
  if (args.includes("--help") || args.includes("-h")) {
    io.print(INSTALL_USAGE);
    return 0;
  }
  try {
    flags = parseInstallFlags(args);
    loaded = loadConfigLeniently(io.env);
  } catch (cause) {
    io.print(bad(messageOf(cause)));
    if (cause instanceof InstallUsageError) io.print(`\n${INSTALL_USAGE}`);
    return 2;
  }
  const { config } = loaded;
  const home = config.homeDir;
  const run: Run = {
    io,
    flags,
    config,
    settings: loaded.settings,
    home,
    configHome: io.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config"),
    dataHome: io.env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share"),
    failed: false,
  };
  io.print(styleText("bold", `pounce ${SERVER_VERSION} setup`));
  try {
    if (loaded.problem && !(await rewriteInvalidSettings(run, loaded.problem))) return 1;
    const command = binaryStep(run);
    const configured = await agentsStep(run, command);
    const previousAsk = run.settings.ask;
    const ask = await askStep(run);
    if (ask) run.settings = { ...run.settings, ask };
    saveSettings(run);
    await profileStep(run);
    saveSettings(run);
    const before = await serviceStep(run, command);
    await desktopStep(run, command);
    saveSettings(run);
    io.print(ok(`Saved your choices to ${tilde(run, config.configFile)}`));
    await healthStep(run, before, !Bun.deepEquals(previousAsk, run.settings.ask));
    io.print("");
    if (configured.length)
      io.print(
        `Restart ${configured.map((spec) => spec.label).join(", ")} so ${configured.length === 1 ? "it loads" : "they load"} pounce, then try:`,
      );
    else io.print("Then try:");
    io.print(`  "${FIRST_PROMPT}"`);
  } catch (cause) {
    if (cause instanceof PromptCancelled) {
      io.print(warn("Setup cancelled; run `pounce install` again to finish."));
      return 130;
    }
    throw cause;
  }
  return run.failed ? 1 : 0;
}

export function defaultInstallIo(): InstallIo {
  const env = process.env;
  return {
    env,
    tty: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    print: (line) => process.stdout.write(`${line}\n`),
    prompts: terminalPrompts(),
    runner: runCommand,
    executable: { path: process.execPath, compiled: Bun.isStandaloneExecutable },
    sourceCommand: selfCommand(),
    onPath: (binary) => Bun.which(binary, { PATH: env.PATH ?? "" }) !== null,
    ensureDaemon: (config, daemonEnv) => ensureDaemon(config, daemonEnv),
    checkChrome,
  };
}

export function runInstall(args: readonly string[]) {
  return install(args, defaultInstallIo());
}
