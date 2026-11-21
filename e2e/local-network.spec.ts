import { afterAll, beforeAll, expect, test } from "bun:test";
import { useMcpHarness } from "../tests/mcpHarness.ts";

let api: Bun.Server<undefined>;
let app: Bun.Server<undefined>;
let tab = "";
const mcp = useMcpHarness({ name: "local-network" });
const text = mcp.ok;

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

beforeAll(async () => {
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      html(new URL(request.url).pathname === "/frame" ? "<p>api frame loaded</p>" : "ok"),
  });
  const apiPort = api.url.port;
  app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      html(
        `<title>Local App</title><iframe title="API frame" src="http://localhost:${apiPort}/frame"></iframe><script>window.apiReach = fetch("http://127.0.0.1:${apiPort}/ping", { mode: "no-cors" }).then(() => "reached", () => "blocked");</script>`,
      ),
  });
  tab =
    /Opened (t\d+)/.exec(await text("tab_open", { url: app.url.href, wait_until: "load" }))?.[1] ??
    "";
});

afterAll(async () => {
  await api?.stop(true);
  await app?.stop(true);
});

test("a local page can frame another loopback origin", async () => {
  const frame = mcp.deps.manager
    .getTab(tab)
    .page.frames()
    .find((candidate) => candidate.url().includes("/frame"));
  expect(frame, "no frame").toBeDefined();
  expect(await frame?.evaluate(() => document.body.innerText)).toMatch(/api frame loaded/);
});

test("a local page can fetch from another loopback origin", async () => {
  expect(await text("evaluate", { tab, expression: "window.apiReach" })).toMatch(/reached\s*$/);
});
