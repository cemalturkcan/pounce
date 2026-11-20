import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("an uncaught exception is recorded as a fault and the process keeps serving", async () => {
  const errorsModule = new URL("./errors.ts", import.meta.url).href;
  const source = `
    const { installProcessGuards, recentFaults } = await import(${JSON.stringify(errorsModule)});
    installProcessGuards("guard-test");
    setTimeout(() => { throw new Error("thrown outside any promise"); }, 10);
    setTimeout(() => {
      const fault = recentFaults().find((entry) => entry.source === "uncaught exception");
      process.stdout.write(fault ? "survived: " + fault.message : "no fault");
    }, 200);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^survived: Error: thrown outside any promise/);
  assert.match(stderr, /guard-test: uncaught exception kept the server running/);
});

test("the loop watchdog records a fault after the event loop was blocked", async () => {
  const { startLoopWatchdog } = await import("./watchdog.ts");
  const { recentFaults } = await import("./errors.ts");
  const stop = await startLoopWatchdog({ thresholdMs: 300, beatMs: 50 });
  try {
    const end = Date.now() + 1200;
    while (Date.now() < end) {}
    let fault;
    for (let attempt = 0; attempt < 40 && !fault; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      fault = recentFaults(20).find((entry) => entry.source === "event loop");
    }
    assert.ok(fault, "no event loop fault");
    assert.match(fault.message, /blocked for \d+ ms/);
  } finally {
    await stop();
  }
});
