import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const EXIT_WAIT_MS = 4000;

let dataDir = "";

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("the stdio server exits when its client closes stdin", async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "web-agent-stdio-"));
  const child = spawn(process.execPath, [new URL("./server.ts", import.meta.url).pathname], {
    stdio: ["pipe", "ignore", "pipe"],
    env: { ...process.env, WEB_AGENT_DATA_DIR: dataDir, WEB_AGENT_DAEMON_DATA_DIR: dataDir },
  });
  const exit = await new Promise<string>((resolve) => {
    let killer: NodeJS.Timeout | undefined;
    child.stderr.on("data", (chunk: Buffer) => {
      if (killer || !chunk.toString().includes("running on stdio")) return;
      killer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("still running");
      }, EXIT_WAIT_MS);
      child.stdin.end();
    });
    child.once("exit", (code) => {
      clearTimeout(killer);
      resolve(`exited with ${code}`);
    });
  });
  expect(exit).toBe("exited with 0");
});
