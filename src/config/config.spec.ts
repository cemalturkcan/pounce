import path from "node:path";
import { expect, test } from "bun:test";
import { loadConfig, parseLaunchArgs } from "./config.ts";

test("config reads launch args and defaults", () => {
  expect(parseLaunchArgs("--disable-features=A,B --lang=tr")).toStrictEqual([
    "--disable-features=A,B",
    "--lang=tr",
  ]);
  expect(parseLaunchArgs(undefined)).toStrictEqual([]);
  const config = loadConfig({ WEB_AGENT_DAEMON_DATA_DIR: "/data", WEB_AGENT_DAEMON_PORT: "4000" });
  expect(config.profileDir).toBe("/data/profile");
  expect(config.outputDir).toBe("/data/output");
  expect(config.sitesDir).toBe("/data/sites");
  expect(config.logDir).toBe("/data/logs");
  expect(config.logLevel).toBe("info");
  const logging = loadConfig({
    WEB_AGENT_DAEMON_DATA_DIR: "/data",
    WEB_AGENT_LOG_DIR: "/var/log/agent",
    WEB_AGENT_LOG_LEVEL: "debug",
  });
  expect(logging.logDir).toBe("/var/log/agent");
  expect(logging.logLevel).toBe("debug");
  expect(config.endpoint).toBe("http://127.0.0.1:4000/mcp");
  expect(config.engine).toBe("patchright");
  expect(config.headless).toBe(true);
  expect(loadConfig({ DISPLAY: ":0" }).headless).toBe(false);
  expect(() => loadConfig({ WEB_AGENT_DAEMON_PORT: "abc" })).toThrow(
    /Invalid WEB_AGENT_DAEMON_PORT/,
  );
});

test("config enables the Chrome sandbox unless WEB_AGENT_CHROME_SANDBOX turns it off", () => {
  expect(loadConfig({}).chromeSandbox).toBe(true);
  expect(loadConfig({ WEB_AGENT_CHROME_SANDBOX: "true" }).chromeSandbox).toBe(true);
  expect(loadConfig({ WEB_AGENT_CHROME_SANDBOX: "1" }).chromeSandbox).toBe(true);
  expect(loadConfig({ WEB_AGENT_CHROME_SANDBOX: "false" }).chromeSandbox).toBe(false);
  expect(loadConfig({ WEB_AGENT_CHROME_SANDBOX: "0" }).chromeSandbox).toBe(false);
  expect(loadConfig({ WEB_AGENT_CHROME_SANDBOX: "maybe" }).chromeSandbox).toBe(true);
});

test("config reads Chrome policy files from the system folders unless WEB_AGENT_CHROME_POLICY_DIRS names others", () => {
  expect(loadConfig({}).chromePolicyDirs).toStrictEqual([
    "/etc/opt/chrome/policies/managed",
    "/etc/opt/chrome/policies/recommended",
    "/etc/chromium/policies/managed",
    "/etc/chromium/policies/recommended",
  ]);
  expect(
    loadConfig({ WEB_AGENT_CHROME_POLICY_DIRS: " /tmp/a/managed : /tmp/b " }).chromePolicyDirs,
  ).toStrictEqual(["/tmp/a/managed", "/tmp/b"]);
});

test("the default ask adapter file is ~/.config/web-agent-mcp/ask-adapter.mjs and WEB_AGENT_ASK_ADAPTER is read separately", () => {
  const home = path.join(path.sep, "tmp", "fake-home");
  const fallback = loadConfig({ HOME: home });
  expect(fallback.askAdapterPath).toBe(
    path.join(home, ".config", "web-agent-mcp", "ask-adapter.mjs"),
  );
  expect(fallback.askAdapter).toBe(undefined);
  expect(
    loadConfig({ HOME: home, WEB_AGENT_ASK_ADAPTER: " /opt/adapters/mine.mjs " }).askAdapter,
  ).toBe("/opt/adapters/mine.mjs");
});

test("WEB_AGENT_CONSOLE_HOOK defaults to local and takes all or off", () => {
  expect(loadConfig({ HOME: "/tmp/x" }).consoleHook).toBe("local");
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_CONSOLE_HOOK: "all" }).consoleHook).toBe("all");
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_CONSOLE_HOOK: "off" }).consoleHook).toBe("off");
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_CONSOLE_HOOK: "maybe" }).consoleHook).toBe("local");
});

test("WEB_AGENT_AUTO_CONSENT defaults to accept and takes reject or off", () => {
  expect(loadConfig({ HOME: "/tmp/x" }).autoConsent).toBe("accept");
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_AUTO_CONSENT: "reject" }).autoConsent).toBe(
    "reject",
  );
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_AUTO_CONSENT: " OFF " }).autoConsent).toBe("off");
  expect(loadConfig({ HOME: "/tmp/x", WEB_AGENT_AUTO_CONSENT: "maybe" }).autoConsent).toBe(
    "accept",
  );
});
