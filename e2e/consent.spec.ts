import { afterAll, beforeAll, expect, test } from "bun:test";
import { repeatUntil, sleep } from "../src/shared/async.ts";
import { startFixture, type Fixture } from "./fixture.ts";
import { type McpHarness, startMcpHarness } from "../tests/mcpHarness.ts";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

async function withServer(mode: string | undefined, run: (server: McpHarness) => Promise<void>) {
  const server = await startMcpHarness({ name: "consent", env: { WEB_AGENT_AUTO_CONSENT: mode } });
  try {
    await run(server);
  } finally {
    await server.close();
  }
}

const opened = (text: string) => /Opened (t\d+)/.exec(text)?.[1] ?? "";

async function stateOf(server: McpHarness, tab: string, id = "consent-state") {
  return (
    await server.ok("evaluate", {
      tab,
      expression: `document.getElementById(${JSON.stringify(id)}).textContent`,
    })
  )
    .split("\n")
    .at(-1);
}

async function eventually(read: () => Promise<string | undefined>, expected: string) {
  let value: string | undefined;
  await repeatUntil(
    async () => {
      value = await read();
      return value === expected ? true : undefined;
    },
    { delayMs: () => 100, giveUp: (attempts) => attempts >= 40 },
  );
  expect(value).toBe(expected);
}

test("cookie banners are accepted automatically by default", async () => {
  await withServer(undefined, async (server) => {
    const english = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    expect(english).toMatch(/^Event: accepted the cookie banner \(Accept all\)$/m);
    await eventually(() => stateOf(server, opened(english)), "accepted");

    const turkish = await server.ok("tab_open", { url: `${fixture.url}/consent/tr` });
    await eventually(() => stateOf(server, opened(turkish)), "accepted");

    const framed = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/frame` }));
    await eventually(() => stateOf(server, framed), "accepted");

    const delayed = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/delayed` }));
    await eventually(() => stateOf(server, delayed), "accepted");
    expect(await server.ok("scroll", { tab: delayed, direction: "down" })).toMatch(
      /Earlier event .*: accepted the cookie banner \(OK\)/,
    );

    const navigated = await server.ok("navigate", {
      tab: framed,
      url: `${fixture.url}/consent/en`,
    });
    expect(navigated).toMatch(/^Event: accepted the cookie banner \(Accept all\)$/m);

    const collected = await server.ok("collect_pages", {
      urls: [`${fixture.url}/consent/tr`],
      include: ["text"],
    });
    expect(collected).toMatch(/accepted/);
  });
});

test("automatic consent never commits an order and leaves other dialogs alone", async () => {
  await withServer(undefined, async (server) => {
    const tab = opened(await server.ok("tab_open", { url: `${fixture.url}/checkout` }));
    await sleep(1800);
    expect(await stateOf(server, tab, "order-state")).toBe("pending");
    const text = await server.ok("dismiss_overlays", { tab });
    expect(text).toMatch(/closed by clicking "Vazgeç" \(cancel\)/);
    expect(text).not.toMatch(/onayla|payment/i);
    expect(await stateOf(server, tab, "order-state")).toBe("dialog dismissed");
  });
});

test("WEB_AGENT_AUTO_CONSENT=reject rejects and off leaves the banner", async () => {
  await withServer("reject", async (server) => {
    const text = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    expect(text).toMatch(/^Event: rejected the cookie banner \(Reject all\)$/m);
    await eventually(() => stateOf(server, opened(text)), "rejected");
  });
  await withServer("off", async (server) => {
    const text = await server.ok("tab_open", { url: `${fixture.url}/consent/en` });
    const tab = opened(text);
    expect(text).not.toMatch(/cookie banner/);
    await sleep(1800);
    expect(await stateOf(server, tab)).toBe("pending");
    expect(await server.ok("dismiss_overlays", { tab, consent: "reject" })).toMatch(
      /Clicked "Reject all" \(reject\)/,
    );
    const again = opened(await server.ok("tab_open", { url: `${fixture.url}/consent/tr` }));
    expect(await server.ok("dismiss_overlays", { tab: again })).toMatch(
      /Clicked "Tümünü kabul et" \(accept\)/,
    );
    expect(await stateOf(server, again)).toBe("accepted");
  });
});

test("automatic consent never acts on a tab the session does not own", async () => {
  await withServer(undefined, async (server) => {
    const context = await server.deps.manager.ensureContext();
    const page = await context.newPage();
    const tab = server.deps.manager.tabOf(page)?.id ?? "";
    await server.ok("navigate", { tab, url: `${fixture.url}/consent/en` });
    await sleep(1800);
    expect(await stateOf(server, tab)).toBe("pending");
  });
});
