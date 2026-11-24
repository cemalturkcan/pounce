import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { type LogLevel, parseLogLevel } from "../log/logger.ts";
import { SERVER_VERSION } from "./version.ts";

const DEFAULT_CHROME_POLICY_DIRS = [
  "/etc/opt/chrome/policies/managed",
  "/etc/opt/chrome/policies/recommended",
  "/etc/chromium/policies/managed",
  "/etc/chromium/policies/recommended",
];

export const PRODUCT_NAME = "pounce";

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
  homeDir: string;
  userDirsFile: string;
  sitesDir: string;
  logDir: string;
  logLevel: LogLevel;
  registryPath: string;
  engine: Engine;
  channel: string;
  executablePath?: string;
  headless: boolean;
  chromeSandbox: boolean;
  chromePolicyDirs: string[];
  passwordStore: string;
  locale?: string;
  timezoneId?: string;
  extraArgs: string[];
  secretsBackend: "gopass" | "none";
  autoConsent: AutoConsent;
  consoleHook: ConsoleHookMode;
  askAdapter?: string;
  askAdapterPath: string;
  configDir: string;
  configFile: string;
  serviceFile: string;
};

const DEFAULT_PORT = 29741;

export type AutoConsent = "accept" | "reject" | "off";

export type ConsoleHookMode = "local" | "all" | "off";

function parseConsoleHook(value: string | undefined): ConsoleHookMode {
  return value === "all" || value === "off" ? value : "local";
}

function parseAutoConsent(value: string | undefined): AutoConsent {
  const normalized = value?.trim().toLowerCase();
  return normalized === "reject" || normalized === "off" ? normalized : "accept";
}

function parsePort(value: string | undefined, context: z.RefinementCtx) {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  context.addIssue({ code: "custom", message: `Invalid WEB_AGENT_DAEMON_PORT: ${value}` });
  return z.NEVER;
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

function parseDirList(value: string | undefined) {
  const dirs = (value ?? "")
    .split(":")
    .map((dir) => dir.trim())
    .filter(Boolean);
  return dirs.length ? dirs : undefined;
}

const raw = z.string().optional();
const text = raw.transform((value) => value?.trim() || undefined);
const flag = raw.transform(parseBoolean);

const environment = z.object({
  HOME: text,
  XDG_DATA_HOME: text,
  XDG_CONFIG_HOME: text,
  DISPLAY: raw,
  WAYLAND_DISPLAY: raw,
  WEB_AGENT_DAEMON_DATA_DIR: text,
  WEB_AGENT_DATA_DIR: text,
  WEB_AGENT_DAEMON_PORT: raw.transform(parsePort),
  WEB_AGENT_CHROME_USER_DATA_DIR: text,
  WEB_AGENT_OUTPUT_DIR: text,
  WEB_AGENT_SITES_DIR: text,
  WEB_AGENT_LOG_DIR: text,
  WEB_AGENT_LOG_LEVEL: raw.transform(parseLogLevel),
  WEB_AGENT_ENGINE: raw.transform((value): Engine =>
    value === "playwright" ? "playwright" : "patchright",
  ),
  WEB_AGENT_CHROME_CHANNEL: text,
  WEB_AGENT_CHROME_EXECUTABLE: text,
  WEB_AGENT_HEADLESS: flag,
  WEB_AGENT_CHROME_SANDBOX: flag,
  WEB_AGENT_CHROME_POLICY_DIRS: raw.transform(parseDirList),
  WEB_AGENT_PASSWORD_STORE: text,
  WEB_AGENT_DEFAULT_LOCALE: text,
  WEB_AGENT_DEFAULT_TIMEZONE_ID: text,
  WEB_AGENT_DEFAULT_LAUNCH_ARGS: raw.transform(parseLaunchArgs),
  WEB_AGENT_SECRETS: raw.transform((value) => (value === "none" ? "none" : "gopass")),
  WEB_AGENT_AUTO_CONSENT: raw.transform(parseAutoConsent),
  WEB_AGENT_CONSOLE_HOOK: raw.transform(parseConsoleHook),
  WEB_AGENT_ASK_ADAPTER: text,
});

function preferNewDir(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

function decodeEnvironment(source: NodeJS.ProcessEnv) {
  const parsed = environment.safeParse(source);
  if (parsed.success) return parsed.data;
  throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = decodeEnvironment(source);
  const home = env.HOME ?? homedir();
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  const configHome = env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  const dataDir =
    env.WEB_AGENT_DAEMON_DATA_DIR ??
    env.WEB_AGENT_DATA_DIR ??
    preferNewDir(
      path.join(dataHome, PRODUCT_NAME),
      path.join(dataHome, "claude-code-pair", "web-agent"),
    );
  const configDir = preferNewDir(
    path.join(configHome, PRODUCT_NAME),
    path.join(home, ".config", "web-agent-mcp"),
  );
  const port = env.WEB_AGENT_DAEMON_PORT;
  const hasDisplay = Boolean(env.WAYLAND_DISPLAY || env.DISPLAY);

  return {
    serverName: PRODUCT_NAME,
    serverVersion: SERVER_VERSION,
    host: "127.0.0.1",
    port,
    endpoint: `http://127.0.0.1:${port}/mcp`,
    dataDir,
    profileDir: env.WEB_AGENT_CHROME_USER_DATA_DIR ?? path.join(dataDir, "profile"),
    outputDir: env.WEB_AGENT_OUTPUT_DIR ?? path.join(dataDir, "output"),
    homeDir: home,
    userDirsFile: path.join(configHome, "user-dirs.dirs"),
    sitesDir: env.WEB_AGENT_SITES_DIR ?? path.join(dataDir, "sites"),
    logDir: env.WEB_AGENT_LOG_DIR ?? path.join(dataDir, "logs"),
    logLevel: env.WEB_AGENT_LOG_LEVEL,
    registryPath: path.join(dataDir, "daemon.json"),
    engine: env.WEB_AGENT_ENGINE,
    channel: env.WEB_AGENT_CHROME_CHANNEL ?? "chrome",
    executablePath: env.WEB_AGENT_CHROME_EXECUTABLE,
    headless: env.WEB_AGENT_HEADLESS ?? !hasDisplay,
    chromeSandbox: env.WEB_AGENT_CHROME_SANDBOX ?? true,
    chromePolicyDirs: env.WEB_AGENT_CHROME_POLICY_DIRS ?? [...DEFAULT_CHROME_POLICY_DIRS],
    passwordStore: env.WEB_AGENT_PASSWORD_STORE ?? "gnome-libsecret",
    locale: env.WEB_AGENT_DEFAULT_LOCALE,
    timezoneId: env.WEB_AGENT_DEFAULT_TIMEZONE_ID,
    extraArgs: env.WEB_AGENT_DEFAULT_LAUNCH_ARGS,
    secretsBackend: env.WEB_AGENT_SECRETS,
    autoConsent: env.WEB_AGENT_AUTO_CONSENT,
    consoleHook: env.WEB_AGENT_CONSOLE_HOOK,
    askAdapter: env.WEB_AGENT_ASK_ADAPTER,
    askAdapterPath: path.join(configDir, "ask-adapter.mjs"),
    configDir,
    configFile: path.join(configDir, "config.json"),
    serviceFile: path.join(configHome, "systemd", "user", `${PRODUCT_NAME}.service`),
  };
}
