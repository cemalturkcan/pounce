import { homedir } from "node:os";
import path from "node:path";
import { SERVER_VERSION } from "./version.ts";

export type Engine = "patchright" | "playwright";

export type Config = {
  serverName: string;
  serverVersion: string;
  host: "127.0.0.1";
  port: number;
  endpoint: string;
  dataDir: string;
  profileDir: string;
  outputDir: string;
  sitesDir: string;
  registryPath: string;
  engine: Engine;
  channel: string;
  executablePath?: string;
  headless: boolean;
  passwordStore: string;
  locale?: string;
  timezoneId?: string;
  extraArgs: string[];
  secretsBackend: "gopass" | "none";
  askAdapter?: string;
  askCommand: string;
};

const DEFAULT_PORT = 29741;

function dataHome(source: NodeJS.ProcessEnv) {
  return source.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
}

function parsePort(value: string | undefined) {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid WEB_AGENT_DAEMON_PORT: ${value}`);
  }
  return port;
}

function parseBoolean(value: string | undefined) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

export function parseLaunchArgs(value: string | undefined) {
  if (!value?.trim()) return [];
  return value
    .split(/\s+(?=--)/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const dataDir =
    source.WEB_AGENT_DAEMON_DATA_DIR?.trim() ||
    source.WEB_AGENT_DATA_DIR?.trim() ||
    path.join(dataHome(source), "claude-code-pair", "web-agent");
  const port = parsePort(source.WEB_AGENT_DAEMON_PORT);
  const hasDisplay = Boolean(source.WAYLAND_DISPLAY || source.DISPLAY);

  return {
    serverName: "web-agent-mcp",
    serverVersion: SERVER_VERSION,
    host: "127.0.0.1",
    port,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    dataDir,
    profileDir: source.WEB_AGENT_CHROME_USER_DATA_DIR?.trim() || path.join(dataDir, "profile"),
    outputDir: source.WEB_AGENT_OUTPUT_DIR?.trim() || path.join(dataDir, "output"),
    sitesDir: source.WEB_AGENT_SITES_DIR?.trim() || path.join(dataDir, "sites"),
    registryPath: path.join(dataDir, "daemon.json"),
    engine: source.WEB_AGENT_ENGINE === "playwright" ? "playwright" : "patchright",
    channel: source.WEB_AGENT_CHROME_CHANNEL?.trim() || "chrome",
    executablePath: source.WEB_AGENT_CHROME_EXECUTABLE?.trim() || undefined,
    headless: parseBoolean(source.WEB_AGENT_HEADLESS) ?? !hasDisplay,
    passwordStore: source.WEB_AGENT_PASSWORD_STORE?.trim() || "gnome-libsecret",
    locale: source.WEB_AGENT_DEFAULT_LOCALE?.trim() || undefined,
    timezoneId: source.WEB_AGENT_DEFAULT_TIMEZONE_ID?.trim() || undefined,
    extraArgs: parseLaunchArgs(source.WEB_AGENT_DEFAULT_LAUNCH_ARGS),
    secretsBackend: source.WEB_AGENT_SECRETS === "none" ? "none" : "gopass",
    askAdapter: source.WEB_AGENT_ASK_ADAPTER?.trim() || undefined,
    askCommand: source.WEB_AGENT_ASK_CLAUDE_COMMAND?.trim() || "claude",
  };
}
