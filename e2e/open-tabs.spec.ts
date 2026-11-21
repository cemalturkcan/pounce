import { afterAll, beforeAll, expect, test } from "bun:test";
import { startFixture, type Fixture } from "./fixture.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";

let fixture: Fixture;
const mcp = useMcpHarness({ name: "open-tabs" });

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

test("tabs opened concurrently right after launch each load their own page", async () => {
  const routes = ["/counter", "/frames", "/article", "/doc", "/media"];
  const results = await Promise.all(
    routes.map((route) => mcp.call("tab_open", { url: `${fixture.url}${route}` })),
  );
  const texts = results.map((result) => result.text);
  const ids = texts.map((text) => /Opened (t\d+)/.exec(text)?.[1]);
  expect(new Set(ids).size).toBe(routes.length);
  for (const [index, route] of routes.entries()) {
    expect(texts[index] ?? "").toMatch(new RegExp(`Opened t\\d+: \\S+${route} .*\\(HTTP 200\\)`));
  }
});
