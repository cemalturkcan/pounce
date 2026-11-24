import type { BrowserContext, BrowserType } from "playwright-core";
import type { Config } from "../config/config.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import { REF_ENGINE, refEngineSource } from "./ref-check.ts";

const engines = new Map<Config["engine"], Promise<BrowserType>>();

export function loadChromium(engine: Config["engine"]) {
  const loading = engines.get(engine) ?? loadEngine(engine);
  engines.set(engine, loading);
  return loading;
}

async function loadEngine(engine: Config["engine"]) {
  const module =
    engine === "patchright" ? await import("patchright") : await import("playwright-core");
  // SAFETY: patchright is a drop-in fork of playwright-core with the same runtime API; only its type declarations live in another package.
  const playwright = module as typeof import("playwright-core");
  await playwright.selectors.register(REF_ENGINE, refEngineSource(), { contentScript: true });
  return playwright.chromium;
}

export function skipInjectRoute(context: BrowserContext) {
  // SAFETY: patchright installs a catch-all context route for init scripts that disables the HTTP cache and holds every document of every tab until its whole body has arrived, while the scripts are already registered over CDP when each page attaches; marking the route as installed keeps it off.
  Object.assign(context, { routeInjecting: true });
}

const SANDBOX_FAILURE = /no usable sandbox|setuid sandbox|suid sandbox|namespace/i;

export function sandboxLaunchError(cause: unknown, sandbox: boolean) {
  if (!sandbox) return undefined;
  const message = messageOf(cause);
  if (!SANDBOX_FAILURE.test(message)) return undefined;
  const detail =
    message
      .split("\n")
      .find((line) => SANDBOX_FAILURE.test(line))
      ?.trim() ?? message;
  return new ToolError(
    `Chrome could not start its sandbox: ${detail.slice(0, 300)}`,
    "This kernel or container does not allow the Chrome sandbox (unprivileged user namespaces). Enable them, or restart the daemon with WEB_AGENT_CHROME_SANDBOX=false to launch Chrome without the sandbox.",
  );
}

export function launchOptions(config: Config) {
  return {
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    channel: config.executablePath ? undefined : config.channel,
    executablePath: config.executablePath,
    headless: config.headless,
    viewport: null,
    colorScheme: null,
    locale: config.locale,
    timezoneId: config.timezoneId,
    acceptDownloads: true,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--disable-sync"],
    chromiumSandbox: config.chromeSandbox,
    args: [
      `--password-store=${config.passwordStore}`,
      "--hide-crash-restore-bubble",
      "--test-type",
      ...config.extraArgs,
    ],
  };
}
