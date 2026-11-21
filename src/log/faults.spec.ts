import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

test("an uncaught exception is recorded as a fault and the process keeps serving", async () => {
  const faultsModule = new URL("./faults.ts", import.meta.url).href;
  const source = `
    const { installProcessGuards, recentFaults } = await import(${JSON.stringify(faultsModule)});
    installProcessGuards("guard-test");
    setTimeout(() => { throw new Error("thrown outside any promise"); }, 10);
    setTimeout(() => {
      const fault = recentFaults().find((entry) => entry.source === "uncaught exception");
      process.stdout.write(fault ? "survived: " + fault.message : "no fault");
    }, 200);
  `;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(0);
  expect(stdout).toMatch(/^survived: Error: thrown outside any promise/);
  expect(stderr).toMatch(/guard-test: uncaught exception kept the server running/);
});
