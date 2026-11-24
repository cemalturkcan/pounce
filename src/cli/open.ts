import { spawn } from "node:child_process";
import { z } from "zod";
import { chromeExecutable } from "../browser/chrome-path.ts";
import type { Config } from "../config/config.ts";
import { writeStderr } from "../log/stderr.ts";
import type { DaemonRegistry } from "../server/daemon.ts";
import { parseJson } from "../shared/decode.ts";
import { messageOf } from "../shared/errors.ts";
import type { Notifier } from "../shared/notify.ts";

const OPEN_TIMEOUT_MS = 60_000;

const openReply = z.object({ launched: z.boolean(), running: z.boolean() });

export type OpenDeps = {
  ensure: () => Promise<DaemonRegistry>;
  launch: (command: readonly string[]) => void;
  notify: Notifier;
};

export function launchDetached(command: readonly string[]) {
  const [file = "", ...args] = command;
  const child = spawn(file, args, { detached: true, stdio: "ignore" });
  child.once("error", (cause) => writeStderr(`pounce open: ${cause.message}`));
  child.unref();
}

async function fail(deps: OpenDeps, message: string) {
  writeStderr(message);
  await deps.notify("pounce", message);
  return 1;
}

function launchOnProfile(
  config: Config,
  registry: DaemonRegistry,
  urls: readonly string[],
  deps: OpenDeps,
) {
  deps.launch([
    chromeExecutable(config),
    `--user-data-dir=${registry.profileDir}`,
    "--test-type",
    ...urls,
  ]);
}

export async function openBrowser(config: Config, urls: readonly string[], deps: OpenDeps) {
  const [url, ...rest] = urls;
  let registry: DaemonRegistry;
  try {
    registry = await deps.ensure();
  } catch (cause) {
    return fail(
      deps,
      `The pounce daemon is not running and could not be started: ${messageOf(cause)}`,
    );
  }
  let text: string;
  try {
    const response = await fetch(`http://127.0.0.1:${registry.port}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(url ? { url } : {}),
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (cause) {
    return fail(deps, `The pounce daemon did not answer: ${messageOf(cause)}`);
  }
  const reply = parseJson(text, openReply);
  if (reply.success && reply.data.launched) {
    if (rest.length) launchOnProfile(config, registry, rest, deps);
    return 0;
  }
  if (reply.success && reply.data.running) {
    launchOnProfile(config, registry, urls, deps);
    return 0;
  }
  return fail(deps, `The pounce daemon could not open the browser: ${text}`);
}
