import { describe, expect, test } from "bun:test";
import type { Runner } from "../cli/process.ts";
import { loadConfig } from "../config/config.ts";
import { ToolError } from "../shared/errors.ts";
import { launchEnvironment, sandboxLaunchError } from "./launch.ts";

test("a launch failure caused by the Chrome sandbox points at WEB_AGENT_CHROME_SANDBOX", () => {
  const messages = [
    "browserType.launchPersistentContext: Target page, context or browser has been closed\n[pid=1][err] No usable sandbox! If you are running on Ubuntu 23.10+ ...",
    "[pid=1][err] Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
    "The SUID sandbox helper binary was found, but is not configured correctly (setuid sandbox)",
  ];
  for (const message of messages) {
    const mapped = sandboxLaunchError(new Error(message), true);
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped?.message).toMatch(/sandbox/i);
    expect(mapped?.hint ?? "").toMatch(/WEB_AGENT_CHROME_SANDBOX=false/);
  }
  expect(sandboxLaunchError(new Error(messages[0]), false)).toBe(undefined);
  expect(
    sandboxLaunchError(new Error("Executable doesn't exist at /opt/google/chrome/chrome"), true),
  ).toBe(undefined);
  expect(sandboxLaunchError("No usable sandbox", true) instanceof ToolError).toBe(true);
});

test("the browser launches without a color scheme override so pages follow the system", async () => {
  const { launchOptions } = await import("./launch.ts");
  const options = launchOptions(loadConfig({ HOME: "/tmp/x", WEB_AGENT_HEADLESS: "true" }));
  expect(options.colorScheme).toBe(null);
  expect(options.viewport).toBe(null);
});

const INSTALLED = {
  HOME: "/home/someone",
  INVOCATION_ID: "0f3c9a",
  DISPLAY: ":0",
  XAUTHORITY: "/tmp/xauth_install",
};

const SERVICE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pounce.service\n";
const TERMINAL_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-graphical.slice/app-term-0999.scope\n";

function userManager(stdout: string, code = 0): Runner {
  return async () => ({ code, stdout, stderr: "" });
}

describe("Chrome's environment when the daemon runs as the systemd service", () => {
  test("takes XAUTHORITY from the user manager over the one written at install", async () => {
    const env = await launchEnvironment(
      INSTALLED,
      userManager("DISPLAY=:0\nXAUTHORITY=/tmp/xauth_login\n"),
      SERVICE_CGROUP,
    );

    expect(env.XAUTHORITY).toBe("/tmp/xauth_login");
  });

  test("takes DISPLAY from the user manager over the one written at install", async () => {
    const env = await launchEnvironment(INSTALLED, userManager("DISPLAY=:1\n"), SERVICE_CGROUP);

    expect(env.DISPLAY).toBe(":1");
  });

  test("takes WAYLAND_DISPLAY from the user manager", async () => {
    const env = await launchEnvironment(
      INSTALLED,
      userManager("WAYLAND_DISPLAY=wayland-1\n"),
      SERVICE_CGROUP,
    );

    expect(env.WAYLAND_DISPLAY).toBe("wayland-1");
  });

  test("keeps a display value the user manager does not have", async () => {
    const env = await launchEnvironment(INSTALLED, userManager("DISPLAY=:1\n"), SERVICE_CGROUP);

    expect(env.XAUTHORITY).toBe("/tmp/xauth_install");
  });

  test("keeps the install's display when the user manager cannot be asked", async () => {
    const env = await launchEnvironment(INSTALLED, userManager("DISPLAY=:1\n", 1), SERVICE_CGROUP);

    expect(env.DISPLAY).toBe(":0");
  });

  test("skips a value the user manager prints escaped", async () => {
    const env = await launchEnvironment(
      INSTALLED,
      userManager("XAUTHORITY=$'/tmp/a\\nb'\n"),
      SERVICE_CGROUP,
    );

    expect(env.XAUTHORITY).toBe("/tmp/xauth_install");
  });

  test("ignores other variables of the user manager", async () => {
    const env = await launchEnvironment(
      INSTALLED,
      userManager("HOME=/elsewhere\n"),
      SERVICE_CGROUP,
    );

    expect(env.HOME).toBe("/home/someone");
  });
});

test("a daemon started from a terminal that runs in its own unit keeps its own display", async () => {
  const env = await launchEnvironment(INSTALLED, userManager("DISPLAY=:1\n"), TERMINAL_CGROUP);

  expect(env.DISPLAY).toBe(":0");
});
