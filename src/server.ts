#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { format } from "node:util";
import { settleClaudeRefreshes } from "./ask/anthropic/adapter.ts";
import {
  defaultImportOptions,
  ImportError,
  importProfile,
  renderImportFailure,
  renderImportReport,
} from "./browser/import-profile.ts";
import { writeStderr } from "./log/stderr.ts";
import { normalizeUrl } from "./page/collect.ts";
import { type Config, loadConfig, loadConfigLeniently } from "./config/config.ts";
import { SERVER_VERSION } from "./config/version.ts";
import { ensureDaemon } from "./cli/daemon-control.ts";
import { proxyStdioToDaemon } from "./cli/mcp-proxy.ts";
import { launchDetached, openBrowser } from "./cli/open.ts";
import { runInstall } from "./install/install.ts";
import { desktopNotifier } from "./shared/notify.ts";
import {
  daemonHoldsProfile,
  daemonPresence,
  daemonStatus,
  refuseSecondDaemon,
  startDaemon,
  stopDaemon,
} from "./server/daemon.ts";
import { createDeps, createServer, startPruning } from "./server/setup.ts";
import { startLoopWatchdog } from "./server/watchdog.ts";
import { installProcessGuards } from "./log/faults.ts";

const LOOP_STALL_MS = 5000;

function writeStdout(text: string) {
  process.stdout.write(`${text}\n`);
}

const USAGE = `Usage: pounce [command]

  (no command)          MCP server on stdio with its own browser
  mcp                   MCP server on stdio, served by the shared daemon (started when down)
  daemon start|stop|status
  open [url]            open a page in the daemon's browser for you
  import-profile [--from <user data dir>] [--profile <name>] [--live]
  install               set pounce up for your agents
  --version`;

async function runImport(config: Config, args: string[]) {
  const options = defaultImportOptions(args);
  try {
    writeStdout(
      renderImportReport(
        config,
        options,
        await importProfile(config, options, () => daemonHoldsProfile(config)),
      ),
    );
  } catch (cause) {
    if (!(cause instanceof ImportError)) throw cause;
    writeStderr(renderImportFailure(config, cause));
    process.exitCode = 1;
  }
}

async function runDaemonCommand(config: Config, action: string | undefined) {
  if (action === "status") {
    writeStdout(JSON.stringify(await daemonStatus(config), null, 2));
    return;
  }
  if (action === "stop") {
    writeStdout(JSON.stringify(await stopDaemon(config)));
    return;
  }
  if (action === "start") {
    const registry = await ensureDaemon(config);
    writeStdout(`pounce daemon running at ${registry.endpoint} (pid ${registry.pid})`);
    return;
  }
  writeStderr(USAGE);
  process.exitCode = 2;
}

async function runCommand(config: Config, command: string, rest: string[]) {
  if (command === "mcp") return proxyStdioToDaemon((await ensureDaemon(config)).endpoint);
  if (command === "daemon") return runDaemonCommand(config, rest[0]);
  if (command === "import-profile") return runImport(config, rest);
  if (command === "open") {
    process.exitCode = await openBrowser(config, rest[0], {
      ensure: () => ensureDaemon(config),
      launch: launchDetached,
      notify: desktopNotifier,
    });
    return;
  }
  if (command === "help" || command === "--help" || command === "-h") return writeStdout(USAGE);
  writeStderr(`Unknown command: ${command}\n\n${USAGE}`);
  process.exitCode = 2;
}

function readsStatusOnly(command: string | undefined, action: string | undefined, args: string[]) {
  if (command === "daemon") return action === "status" || action === "stop";
  return args.includes("--daemon-status") || args.includes("--daemon-stop");
}

function lenientConfig() {
  const { config, problem } = loadConfigLeniently();
  if (problem)
    writeStderr(`Invalid ${config.configFile}: ${problem}. Run \`pounce install\` to rewrite it.`);
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, ...rest] = args;
  if (command === "--version" || command === "-v" || command === "version") {
    writeStdout(SERVER_VERSION);
    return;
  }
  if (command === "install") {
    process.exitCode = await runInstall(rest);
    return;
  }
  const config = readsStatusOnly(command, rest[0], args) ? lenientConfig() : loadConfig();
  if (command !== undefined && (!command.startsWith("-") || ["--help", "-h"].includes(command)))
    return runCommand(config, command, rest);

  if (args.includes("--daemon-status")) return runDaemonCommand(config, "status");
  if (args.includes("--daemon-stop")) return runDaemonCommand(config, "stop");
  if (args.includes("--import-profile")) return runImport(config, args);

  if (args.includes("--daemon")) {
    const { state, registry } = await daemonPresence(config);
    if (registry && state !== "stopped") throw new Error(refuseSecondDaemon(state, registry));
  }

  const deps = createDeps(config);
  installProcessGuards("pounce");
  await startLoopWatchdog({ thresholdMs: LOOP_STALL_MS }).catch((cause: unknown) =>
    writeStderr(format("pounce loop watchdog failed to start:", cause)),
  );
  startPruning(deps);

  if (args.includes("--daemon")) {
    await startDaemon(
      config,
      () => createServer(config, deps),
      async () => {
        deps.jobs.cancelAll();
        await Promise.allSettled([deps.manager.shutdown(), settleClaudeRefreshes()]);
      },
      (sessionId) => {
        deps.jobs.orphanJobsOf(sessionId);
        return deps.manager.orphanTabsOf(sessionId);
      },
      deps.log,
      (url) => deps.manager.openForUser(url === undefined ? undefined : normalizeUrl(url)),
    );
    return;
  }

  const shutdown = () =>
    void deps.manager
      .shutdown()
      .catch(() => undefined)
      .then(settleClaudeRefreshes)
      .finally(() => process.exit(0));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  await createServer(config, deps).connect(new StdioServerTransport());
  writeStderr("pounce running on stdio");
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    writeStderr(format("pounce failed:", cause instanceof Error ? cause.message : cause));
    process.exit(1);
  });
}
