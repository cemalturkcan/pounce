import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config/config.ts";
import type { DaemonRegistry } from "../server/daemon.ts";
import { openBrowser, type OpenDeps } from "./open.ts";

type Exchange = { bodies: string[]; launched: string[][]; notes: string[] };

const servers: ReturnType<typeof Bun.serve>[] = [];

afterAll(() => {
  for (const server of servers) void server.stop(true);
});

async function fakeDaemon(reply: () => Response) {
  const exchange: Exchange = { bodies: [], launched: [], notes: [] };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      exchange.bodies.push(await request.text());
      return reply();
    },
  });
  servers.push(server);
  const dataDir = await mkdtemp(path.join(tmpdir(), "pounce-open-"));
  const config = loadConfig({
    HOME: dataDir,
    WEB_AGENT_DAEMON_DATA_DIR: dataDir,
    WEB_AGENT_DAEMON_PORT: String(server.port),
    WEB_AGENT_CHROME_EXECUTABLE: "/opt/test/chrome",
  });
  const registry: DaemonRegistry = {
    pid: process.pid,
    endpoint: config.endpoint,
    port: server.port ?? 0,
    dataDir,
    profileDir: path.join(dataDir, "profile"),
    startedAt: new Date().toISOString(),
    version: config.serverVersion,
  };
  const deps: OpenDeps = {
    ensure: async () => registry,
    launch: (command) => exchange.launched.push([...command]),
    notify: async (_title, body) => {
      exchange.notes.push(body);
      return undefined;
    },
  };
  return { config, deps, exchange, registry };
}

describe("open when the daemon opens a tab itself", () => {
  test("sends the URL to the daemon", async () => {
    const { config, deps, exchange } = await fakeDaemon(() =>
      Response.json({ launched: true, running: false }),
    );
    await openBrowser(config, ["https://example.com/"], deps);

    expect(exchange.bodies).toStrictEqual([JSON.stringify({ url: "https://example.com/" })]);
  });

  test("starts no Chrome of its own", async () => {
    const { config, deps, exchange } = await fakeDaemon(() =>
      Response.json({ launched: true, running: false }),
    );
    await openBrowser(config, [], deps);

    expect(exchange.launched).toStrictEqual([]);
  });

  test("sends an empty object without a URL", async () => {
    const { config, deps, exchange } = await fakeDaemon(() =>
      Response.json({ launched: true, running: false }),
    );
    await openBrowser(config, [], deps);

    expect(exchange.bodies).toStrictEqual(["{}"]);
  });
});

describe("open when the daemon says its browser is still starting", () => {
  test("hands the URL to Chrome on the daemon's profile", async () => {
    const { config, deps, exchange, registry } = await fakeDaemon(() =>
      Response.json({ launched: false, running: true }),
    );
    await openBrowser(config, ["https://example.com/"], deps);

    expect(exchange.launched).toStrictEqual([
      [
        "/opt/test/chrome",
        `--user-data-dir=${registry.profileDir}`,
        "--test-type",
        "https://example.com/",
      ],
    ]);
  });
});

describe("open when the daemon refuses", () => {
  test("exits with 1", async () => {
    const { config, deps } = await fakeDaemon(() =>
      Response.json({ error: "boom" }, { status: 500 }),
    );

    expect(await openBrowser(config, [], deps)).toBe(1);
  });

  test("tells the user what the daemon said", async () => {
    const { config, deps, exchange } = await fakeDaemon(() =>
      Response.json({ error: "boom" }, { status: 500 }),
    );
    await openBrowser(config, [], deps);

    expect(exchange.notes).toStrictEqual([
      'The pounce daemon could not open the browser: {"error":"boom"}',
    ]);
  });
});

describe("open when the daemon cannot start", () => {
  test("names the reason", async () => {
    const { config, deps, exchange } = await fakeDaemon(() => Response.json({}));
    await openBrowser(config, [], {
      ...deps,
      ensure: () => Promise.reject(new Error("port taken")),
    });

    expect(exchange.notes).toStrictEqual([
      "The pounce daemon is not running and could not be started: port taken",
    ]);
  });
});

const URLS = ["https://example.com/a", "https://example.com/b", "https://example.com/c"];

describe("open with several URLs", () => {
  test("sends the first to the daemon", async () => {
    const { config, deps, exchange } = await fakeDaemon(() =>
      Response.json({ launched: true, running: false }),
    );
    await openBrowser(config, URLS, deps);

    expect(exchange.bodies).toStrictEqual([JSON.stringify({ url: URLS[0] })]);
  });

  test("hands the rest to Chrome on the daemon's profile once the daemon opened the first", async () => {
    const { config, deps, exchange, registry } = await fakeDaemon(() =>
      Response.json({ launched: true, running: false }),
    );
    await openBrowser(config, URLS, deps);

    expect(exchange.launched).toStrictEqual([
      [
        "/opt/test/chrome",
        `--user-data-dir=${registry.profileDir}`,
        "--test-type",
        "https://example.com/b",
        "https://example.com/c",
      ],
    ]);
  });

  test("hands them all to Chrome when the daemon's browser is still starting", async () => {
    const { config, deps, exchange, registry } = await fakeDaemon(() =>
      Response.json({ launched: false, running: true }),
    );
    await openBrowser(config, URLS, deps);

    expect(exchange.launched).toStrictEqual([
      ["/opt/test/chrome", `--user-data-dir=${registry.profileDir}`, "--test-type", ...URLS],
    ]);
  });
});
