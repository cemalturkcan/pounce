import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startFixture, type Fixture } from "./fixture.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import { sleep } from "../src/shared/async.ts";

let fixture: Fixture;
const mcp = useMcpHarness({ name: "network-console" });

async function openTab(path: string) {
  return (
    /Opened (t\d+)/.exec(await mcp.ok("navigate", { url: `${fixture.url}${path}` }))?.[1] ?? ""
  );
}

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

describe("logs with new_only", () => {
  let first: string;
  let second: string;
  let full: string;

  beforeAll(async () => {
    const tab = await openTab("/console-cursor");
    await sleep(500);
    first = await mcp.ok("logs", { source: "page", tab, new_only: true });
    await mcp.ok("evaluate", { tab, expression: "window.logMore()" });
    second = await mcp.ok("logs", { source: "page", tab, new_only: true });
    full = await mcp.ok("logs", { source: "page", tab });
  });

  test("the first read returns what the page logged at load", () => {
    expect(first).toMatch(/first entry/);
  });

  test("the next read returns the entry logged since", () => {
    expect(second).toMatch(/second entry/);
  });

  test("the next read leaves out entries already read", () => {
    expect(second).not.toMatch(/first entry/);
  });

  test("a read without new_only still returns earlier entries", () => {
    expect(full).toMatch(/first entry/);
  });

  test("a console error names the script line it came from", () => {
    expect(first).toMatch(/located error \(at \S+\/files\/console-source\.js:2:\d+\)/);
  });

  test("an uncaught error names the script line it came from", () => {
    expect(first).toMatch(/located throw[\s\S]*?\(?at \S+\/files\/console-source\.js:3:\d+\)?/);
  });
});

describe("network with a request that never answers", () => {
  let list: string;
  let detail: string;

  beforeAll(async () => {
    const tab = await openTab("/pending-request");
    await sleep(1200);
    list = await mcp.ok("network", { tab });
    const id = Number(/#(\d+) GET fetch \S+\/api\/pending/.exec(list)?.[1]);
    detail = await mcp.ok("network", { tab, id });
  });

  test("the request is listed as still waiting with its id and how long it has waited", () => {
    expect(list).toMatch(
      /Still waiting for a response:\n#\d+ GET fetch \S+\/api\/pending \(waiting \d+\.\d s\)/,
    );
  });

  test("the id of a waiting request shows its request headers", () => {
    expect(detail).toMatch(/Request headers:\n[\s\S]*referer: \S+\/pending-request/i);
  });

  test("the id of a waiting request says it is still waiting", () => {
    expect(detail).toMatch(/Still waiting for a response after \d+\.\d s\./);
  });

  test("an answered request is not listed as waiting", () => {
    expect(list.split("Still waiting for a response:")[1]).not.toMatch(/pending-request/);
  });
});

describe("network output is raw", () => {
  let detail: string;
  let requested: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    await mcp.ok("evaluate", {
      tab,
      expression:
        "fetch('/api/session', { headers: { authorization: 'Bearer raw-token', 'x-api-key': 'raw-key' } }).then((response) => response.status)",
    });
    const list = await mcp.ok("network", { tab, pattern: "/api/session" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    detail = await mcp.ok("network", { tab, id });
    requested = await mcp.ok("request", { url: `${fixture.url}/api/session` });
    await mcp.ok("tabs", { close: [tab] });
  });

  test("a request's authorization header is shown as sent", () => {
    expect(detail).toMatch(/authorization: Bearer raw-token/);
  });

  test("a request's x-api-key header is shown as sent", () => {
    expect(detail).toMatch(/x-api-key: raw-key/);
  });

  test("a response's set-cookie header is shown as received", () => {
    expect(detail).toMatch(/set-cookie: fixture_session=raw-session-value/);
  });

  test("request shows the set-cookie header it received", () => {
    expect(requested).toMatch(/set-cookie: fixture_session=raw-session-value/);
  });
});
