import { type ChildProcess, spawn } from "node:child_process";
import { PACKAGE_DIR } from "../src/config/version.ts";
import { repeatUntil, sleep } from "../src/shared/async.ts";

const START_POLL_MS = 100;
const START_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 15_000;

export function freePort() {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

export async function healthy(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
  return response?.ok === true;
}

export type SpawnedDaemon = {
  process: ChildProcess;
  port: number;
  endpoint: URL;
  stderr: () => string;
  stop: () => Promise<void>;
};

export async function spawnDaemon(
  dataDir: string,
  env: NodeJS.ProcessEnv = {},
  serverDir = PACKAGE_DIR,
): Promise<SpawnedDaemon> {
  const port = freePort();
  let stderr = "";
  const child = spawn(process.execPath, ["src/server.ts", "--daemon"], {
    cwd: serverDir,
    env: {
      ...process.env,
      WEB_AGENT_DAEMON_DATA_DIR: dataDir,
      WEB_AGENT_DAEMON_PORT: String(port),
      WEB_AGENT_HEADLESS: "true",
      WEB_AGENT_PASSWORD_STORE: "basic",
      WEB_AGENT_SECRETS: "none",
      ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await repeatUntil(
    async () => ((await healthy(port)) || child.exitCode !== null ? true : undefined),
    { delayMs: () => START_POLL_MS, giveUp: (made) => made * START_POLL_MS >= START_TIMEOUT_MS },
  );
  return {
    process: child,
    port,
    endpoint: new URL(`http://127.0.0.1:${port}/mcp`),
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(STOP_GRACE_MS)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}
