import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SERVER_VERSION } from "./config/version.ts";
import { freePort, runServer, SOURCE_SERVER } from "../tests/daemon.ts";

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

async function cli(args: string[]) {
  dataDir = await mkdtemp(path.join(tmpdir(), "pounce-cli-"));
  return runServer(SOURCE_SERVER, path.join(dataDir, "data"), freePort(), args, {
    HOME: dataDir,
    XDG_CONFIG_HOME: path.join(dataDir, ".config"),
  });
}

test("--version prints the package version", async () => {
  expect((await cli(["--version"])).stdout.trim()).toBe(SERVER_VERSION);
});

test("an unknown command exits with 2", async () => {
  expect((await cli(["frobnicate"])).exitCode).toBe(2);
});

test("daemon start leaves a daemon running that daemon status reports", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "pounce-cli-"));
  const port = freePort();
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") };
  const data = path.join(home, "data");
  await runServer(SOURCE_SERVER, data, port, ["daemon", "start"], env);
  const status = await runServer(SOURCE_SERVER, data, port, ["daemon", "status"], env);
  await runServer(SOURCE_SERVER, data, port, ["daemon", "stop"], env);

  expect(JSON.parse(status.stdout).state).toBe("running");
}, 40_000);

test("the legacy --daemon-status flag still reports the daemon", async () => {
  const status = await cli(["--daemon-status"]);

  expect(JSON.parse(status.stdout).running).toBe(false);
});

async function cliWithBadConfig(args: string[]) {
  dataDir = await mkdtemp(path.join(tmpdir(), "pounce-cli-"));
  const configDir = path.join(dataDir, ".config", "pounce");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, "config.json"),
    JSON.stringify({ ask: { mode: "api-key", apiKey: "" } }),
  );
  return runServer(SOURCE_SERVER, path.join(dataDir, "data"), freePort(), args, {
    HOME: dataDir,
    XDG_CONFIG_HOME: path.join(dataDir, ".config"),
  });
}

test("daemon status answers when config.json fails the schema", async () => {
  expect((await cliWithBadConfig(["daemon", "status"])).exitCode).toBe(0);
});

test("the daemon refuses to start when config.json fails the schema", async () => {
  expect((await cliWithBadConfig(["--daemon"])).stderr).toContain("ask.apiKey");
});
