import type { Config } from "../config/config.ts";

const LINUX_CHANNEL_PATHS = new Map([
  ["chrome", "/opt/google/chrome/chrome"],
  ["chrome-beta", "/opt/google/chrome-beta/chrome"],
  ["chrome-dev", "/opt/google/chrome-unstable/chrome"],
  ["msedge", "/opt/microsoft/msedge/msedge"],
  ["msedge-beta", "/opt/microsoft/msedge-beta/msedge"],
  ["msedge-dev", "/opt/microsoft/msedge-dev/msedge"],
]);

export function chromeExecutable(config: Pick<Config, "executablePath" | "channel">) {
  return config.executablePath ?? LINUX_CHANNEL_PATHS.get(config.channel) ?? config.channel;
}
