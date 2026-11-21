import { expect, test } from "bun:test";
import { loadConfig } from "../config/config.ts";
import { ToolError } from "../shared/errors.ts";
import { sandboxLaunchError } from "./launch.ts";

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
