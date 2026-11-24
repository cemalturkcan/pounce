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
import { loadConfig } from "./config/config.ts";
import { daemonStatus, runningDaemon, startDaemon, stopDaemon } from "./server/daemon.ts";
import { createDeps, createServer, startPruning } from "./server/setup.ts";
import { startLoopWatchdog } from "./server/watchdog.ts";
import { installProcessGuards } from "./log/faults.ts";

const LOOP_STALL_MS = 5000;

function writeStdout(text: string) {
  process.stdout.write(`${text}\n`);
}

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);

  if (args.includes("--daemon-status")) {
    writeStdout(JSON.stringify(await daemonStatus(config), null, 2));
    return;
  }
  if (args.includes("--daemon-stop")) {
    writeStdout(JSON.stringify(await stopDaemon(config)));
    return;
  }
  if (args.includes("--import-profile")) {
    const options = defaultImportOptions(args);
    try {
      writeStdout(
        renderImportReport(
          config,
          options,
          await importProfile(
            config,
            options,
            async () => (await runningDaemon(config)) !== undefined,
          ),
        ),
      );
    } catch (cause) {
      if (!(cause instanceof ImportError)) throw cause;
      writeStderr(renderImportFailure(config, cause));
      process.exitCode = 1;
    }
    return;
  }

  if (args.includes("--daemon")) {
    const running = await runningDaemon(config);
    if (running)
      throw new Error(
        `A daemon is already running at ${running.endpoint} (pid ${running.pid}). Stop it first with --daemon-stop.`,
      );
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
