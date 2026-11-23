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
import { daemonStatus, startDaemon, stopDaemon } from "./server/daemon.ts";
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
    writeStdout(JSON.stringify(daemonStatus(config), null, 2));
    return;
  }
  if (args.includes("--daemon-stop")) {
    writeStdout(JSON.stringify(stopDaemon(config)));
    return;
  }
  if (args.includes("--import-profile")) {
    const options = defaultImportOptions(args);
    try {
      writeStdout(
        renderImportReport(
          config,
          options,
          await importProfile(config, options, () => daemonStatus(config).running),
        ),
      );
    } catch (cause) {
      if (!(cause instanceof ImportError)) throw cause;
      writeStderr(renderImportFailure(config, cause));
      process.exitCode = 1;
    }
    return;
  }

  const deps = createDeps(config);
  installProcessGuards("web-agent-mcp");
  await startLoopWatchdog({ thresholdMs: LOOP_STALL_MS }).catch((cause: unknown) =>
    writeStderr(format("web-agent-mcp loop watchdog failed to start:", cause)),
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
  writeStderr("web-agent-mcp running on stdio");
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    writeStderr(format("web-agent-mcp failed:", cause instanceof Error ? cause.message : cause));
    process.exit(1);
  });
}
