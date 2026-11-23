import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createImage } from "../src/visual/pixels.ts";
import { encodePng } from "../src/visual/png.ts";
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab } = useToolsHarness("tools-tabs");

const IPHONE_AGENT = /iPhone; CPU iPhone OS/;

async function value(tab: string, expression: string) {
  return (await ok("evaluate", { tab, expression })).split("\n").slice(1).join("\n").trim();
}

async function json(tab: string, expression: string) {
  return JSON.parse(await value(tab, `JSON.stringify(${expression})`));
}

async function echoedHeaders(tab: string): Promise<Record<string, string>> {
  return json(tab, "await (await fetch('/api/echo')).json()");
}

const permissionState = (tab: string, name: string) =>
  value(tab, `(await navigator.permissions.query({ name: '${name}' })).state`);

describe("tabs", () => {
  test("tabs lists a tab with its owner and the output directory", async () => {
    const tab = openedTab(await ok("navigate", { url: fixture().url }));
    const listed = await call("tabs");
    expect(listed.text).toMatch(new RegExp(`${tab} \\[yours\\] ${fixture().url}/ "Fixture Home"`));
    expect(listed.structured?.outputDir).toBe(mcp.deps.store.root);
    await ok("tabs", { close: [tab] });
  });

  test("tabs closes several tabs in order and lists what is left", async () => {
    const first = openedTab(await ok("navigate", { url: fixture().url }));
    const second = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const result = await call("tabs", { close: [first, second] });
    expect(result.text).toMatch(new RegExp(`^Closed ${first}\\.\\nClosed ${second}\\.\\n`));
    expect(result.text).not.toMatch(new RegExp(`${first} \\[`));
    expect(result.structured?.closed).toEqual([first, second]);
  });

  test("tabs with close lists the tabs that are left", async () => {
    const kept = openedTab(await ok("navigate", { url: fixture().url }));
    const gone = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const result = await ok("tabs", { close: [gone] });
    await ok("tabs", { close: [kept] });
    expect(result).toMatch(new RegExp(`\\n${kept} \\[yours\\] ${fixture().url}/ "Fixture Home"`));
  });

  test("tabs closing an unknown id lists the open tabs once", async () => {
    const kept = openedTab(await ok("navigate", { url: fixture().url }));
    const result = await call("tabs", { close: ["t1"] });
    await ok("tabs", { close: [kept] });
    expect(result.text.split(kept).length - 1).toBe(1);
  });

  test("tabs closing an unknown id says it is not open", async () => {
    const result = await call("tabs", { close: ["t1"] });
    expect(result.text).toStartWith("t1: Tab t1 is not open.\n");
  });

  test("tabs with close leaves out the server state", async () => {
    const tab = openedTab(await ok("navigate", { url: fixture().url }));
    expect(await ok("tabs", { close: [tab] })).not.toMatch(/Profile:|Output files:|Secret store:/);
  });

  test("tabs keeps a tab with unsaved changes open, closes the others and fails", async () => {
    const draft = openedTab(await ok("navigate", { url: `${fixture().url}/unsaved` }));
    const plain = openedTab(await ok("navigate", { url: fixture().url }));
    await ok("click", { tab: draft, target: "#draft" });
    const result = await call("tabs", { close: [draft, plain] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(new RegExp(`${draft}: Tab ${draft} was not closed`));
    expect(result.text).toMatch(new RegExp(`Closed ${plain}\\.`));
    expect(result.text).toMatch(new RegExp(`${draft} \\[yours\\]`));
    expect(result.structured?.closed).toEqual([plain]);
  });

  test("tabs with force closes a tab with unsaved changes", async () => {
    const draft = openedTab(await ok("navigate", { url: `${fixture().url}/unsaved` }));
    await ok("click", { tab: draft, target: "#draft" });
    expect(await ok("tabs", { close: [draft], force: true })).toMatch(`Closed ${draft}.`);
  });

  test("tabs closes a tab while a dialog waits on it", async () => {
    const tab = openedTab(await ok("navigate", { url: fixture().url }));
    await ok("evaluate", { tab, expression: "setTimeout(() => alert('Hold on'), 50)" });
    await Bun.sleep(300);
    expect(await ok("tabs", { close: [tab] })).toMatch(`Closed ${tab}.`);
  });

  test("tabs notes a closed tab that belonged to another session", async () => {
    const tab = openedTab(await ok("navigate", { url: fixture().url }));
    mcp.deps.manager.getTab(tab).owner = "another-session";
    expect(await ok("tabs", { close: [tab] })).toMatch(
      `Note: ${tab} belongs to another session.\nClosed ${tab}.`,
    );
  });

  test("tabs refuses force without close", async () => {
    expect((await call("tabs", { force: true })).text).toMatch(/force only applies with close/);
  });
});

describe("navigate", () => {
  let tab = "";

  afterAll(async () => {
    if (tab) await ok("tabs", { close: [tab], force: true });
  });

  test("navigate without a tab opens one and returns its id", async () => {
    const result = await call("navigate", { url: fixture().url });
    tab = openedTab(result.text);
    expect(result.structured).toMatchObject({
      tab,
      url: `${fixture().url}/`,
      title: "Fixture Home",
      status: 200,
    });
  });

  test("navigate with about:blank opens a blank tab", async () => {
    const blank = openedTab(await ok("navigate", { url: "about:blank" }));
    expect(await ok("tabs", { close: [blank] })).toMatch(`Closed ${blank}.`);
  });

  test("navigate loads a URL in a tab it was given", async () => {
    const result = await call("navigate", { tab, url: `${fixture().url}/article` });
    expect(result.structured).toMatchObject({ tab, url: `${fixture().url}/article`, status: 200 });
  });

  test("navigate goes back in a tab", async () => {
    await ok("navigate", { tab, url: "back" });
    expect(await value(tab, "location.pathname")).toBe("/");
  });

  test("navigate goes forward in a tab", async () => {
    await ok("navigate", { tab, url: "forward" });
    expect(await value(tab, "location.pathname")).toBe("/article");
  });

  test("navigate reloads a tab", async () => {
    await ok("evaluate", { tab, expression: "window.marked = 1" });
    await ok("navigate", { tab, url: "reload" });
    expect(await value(tab, "typeof window.marked")).toBe("undefined");
  });

  test("navigate refuses back without a tab", async () => {
    expect((await call("navigate", { url: "back" })).text).toMatch(/back needs a tab/);
  });

  test("navigate with an empty url fails", async () => {
    expect((await call("navigate", { url: " " })).isError).toBe(true);
  });

  test("navigate with an empty url opens no tab", async () => {
    const before = mcp.deps.manager.listTabs().length;
    await call("navigate", { url: "" });
    expect(mcp.deps.manager.listTabs().length).toBe(before);
  });

  test("navigate refuses force without a tab", async () => {
    expect((await call("navigate", { url: fixture().url, force: true })).text).toMatch(
      /force needs a tab/,
    );
  });

  test("navigate applies timeout_ms when it opens a tab", async () => {
    const result = await call("navigate", {
      url: `${fixture().url}/api/pending`,
      timeout_ms: 1000,
    });
    const opened = openedTab(result.text);
    expect(result.text).toMatch(/Still loading .*\/api\/pending after 1 s/);
    await ok("tabs", { close: [opened] });
  });

  test("navigate keeps a new tab open on its error page and names it", async () => {
    const result = await call("navigate", { url: "http://127.0.0.1:1/" });
    const failed = String(result.structured?.tab);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(new RegExp(`Tab ${failed} was opened and stays open`));
    await ok("tabs", { close: [failed] });
  });

  test("navigate saves a download instead of opening it", async () => {
    const result = await call("navigate", { url: `${fixture().url}/download` });
    const opened = openedTab(result.text);
    expect(result.text).toMatch(/Downloaded report\.csv/);
    await ok("tabs", { close: [opened] });
  });

  test("navigate points an HTTP login dialog to http_auth", async () => {
    expect((await call("navigate", { tab, url: `${fixture().url}/auth-c/` })).text).toMatch(
      /HTTP authentication[\s\S]*http_auth/,
    );
  });

  test("navigate with force leaves a page with unsaved changes", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/unsaved` });
    await ok("click", { tab, target: "#draft" });
    expect(await ok("navigate", { tab, url: fixture().url })).toMatch(/Still at/);
    expect(await ok("navigate", { tab, url: fixture().url, force: true })).toMatch(/Fixture Home/);
  });
});

describe("emulate", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: fixture().url }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("a viewport size alone keeps the desktop user agent and no touch", async () => {
    const agent = await value(tab, "navigator.userAgent");
    await ok("emulate", { tab, viewport: { width: 900, height: 700 } });
    expect(
      await json(tab, "[innerWidth, innerHeight, navigator.userAgent, navigator.maxTouchPoints]"),
    ).toEqual([900, 700, agent, 0]);
    await ok("emulate", { tab, reset: true });
  });

  test("reset restores the size the tab had before emulate", async () => {
    const before = await json(tab, "[innerWidth, innerHeight]");
    await ok("emulate", { tab, viewport: { width: 900, height: 700 } });
    const reset = await ok("emulate", { tab, reset: true });
    expect(await json(tab, "[innerWidth, innerHeight]")).toEqual(before);
    expect(reset).toMatch(new RegExp(`viewport is back to ${before[0]}x${before[1]}`));
  });

  test("viewport with mobile turns on mobile mode and touch", async () => {
    await ok("emulate", { tab, viewport: { width: 500, height: 800, mobile: true } });
    expect(await json(tab, "[screen.width, navigator.maxTouchPoints > 0]")).toEqual([500, true]);
    await ok("emulate", { tab, reset: true });
  });

  test("an iPhone device presents an iPhone without client hints", async () => {
    await ok("emulate", { tab, device: "iPhone 15" });
    await ok("navigate", { tab, url: "reload" });
    const seen = await json(
      tab,
      "({ agent: navigator.userAgent, platform: navigator.platform, hints: 'userAgentData' in navigator, touch: navigator.maxTouchPoints > 0, width: screen.width, ratio: devicePixelRatio })",
    );
    expect(seen).toMatchObject({
      platform: "iPhone",
      hints: false,
      touch: true,
      width: 393,
      ratio: 3,
    });
    expect(seen.agent).toMatch(IPHONE_AGENT);
  });

  test("an iPhone device sends no client hint headers", async () => {
    const headers = await echoedHeaders(tab);
    expect([headers["user-agent"], headers["sec-ch-ua"]]).toEqual([
      expect.stringMatching(IPHONE_AGENT),
      undefined,
    ]);
  });

  test("x and y are checked against the emulated device viewport", async () => {
    const result = await call("click", { tab, x: 500, y: 10 });
    expect(result.text).toMatch(/outside the viewport of 393x659/);
  });

  test("an Android device sends matching client hints", async () => {
    await ok("emulate", { tab, device: "Pixel 8" });
    await ok("navigate", { tab, url: "reload" });
    const headers = await echoedHeaders(tab);
    expect([headers["sec-ch-ua-mobile"], headers["sec-ch-ua-platform"]]).toEqual([
      "?1",
      '"Android"',
    ]);
  });

  test("an Android device reports its model through navigator.userAgentData", async () => {
    expect(
      await value(tab, "(await navigator.userAgentData.getHighEntropyValues(['model'])).model"),
    ).toBe("Pixel 8");
  });

  test("an empty device removes the device identity", async () => {
    const result = await ok("emulate", { tab, device: "" });
    await ok("navigate", { tab, url: "reload" });
    expect(result).toMatch(/No emulation is active/);
    expect(await value(tab, "navigator.userAgent")).not.toMatch(/Android/);
  });

  test("a Windows Chrome user agent gets Windows client hints", async () => {
    await ok("emulate", {
      tab,
      user_agent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    });
    expect((await echoedHeaders(tab))["sec-ch-ua-platform"]).toBe('"Windows"');
  });

  test("a user agent that is not Chromium sends no client hint headers", async () => {
    await ok("emulate", { tab, user_agent: "FixtureAgent/2.0" });
    expect((await echoedHeaders(tab))["sec-ch-ua"]).toBeUndefined();
    await ok("emulate", { tab, reset: true });
  });

  test("reset keeps permission grants that emulate did not make", async () => {
    const page = mcp.deps.manager.getTab(tab).page;
    await mcp.deps.manager.profile.grant(page.context(), fixture().url, ["notifications"]);
    await ok("emulate", { tab, geolocation: { latitude: 41.01, longitude: 28.97 } });
    await ok("emulate", { tab, reset: true });
    expect(await permissionState(tab, "notifications")).toBe("granted");
  });

  test("reset removes the geolocation permission emulate granted", async () => {
    const before = await permissionState(tab, "geolocation");
    await ok("emulate", { tab, geolocation: { latitude: 41.01, longitude: 28.97 } });
    const during = await permissionState(tab, "geolocation");
    await ok("emulate", { tab, reset: true });
    expect([before, during, await permissionState(tab, "geolocation")]).toEqual([
      before,
      "granted",
      before,
    ]);
  });

  test("conditions combine, apply to the page and reset to what the tab had", async () => {
    const probe =
      "({ dark: matchMedia('(prefers-color-scheme: dark)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, online: navigator.onLine })";
    const before = await json(tab, probe);
    const set = await ok("emulate", {
      tab,
      color_scheme: "dark",
      reduced_motion: "reduce",
      timezone: "Asia/Tokyo",
      locale: "de-DE",
      geolocation: { latitude: 41.01, longitude: 28.97 },
    });
    expect(set).toMatch(/permission granted to http:\/\/127\.0\.0\.1/);
    expect(await json(tab, probe)).toMatchObject({ dark: true, reduced: true, zone: "Asia/Tokyo" });
    expect(await value(tab, "new Intl.NumberFormat().format(1234.5)")).toBe("1.234,5");
    expect((await echoedHeaders(tab))["accept-language"]).toMatch(/^de-DE/);
    expect(
      await value(
        tab,
        "await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition((p) => resolve(p.coords.latitude), reject, { timeout: 5000 }))",
      ),
    ).toBe("41.01");
    await ok("emulate", { tab, network: "fast3g" });
    const started = Number(await value(tab, "performance.now()"));
    await value(tab, "await fetch('/api/data?slow=' + Math.random()).then(() => 1)");
    expect(Number(await value(tab, "performance.now()")) - started).toBeGreaterThan(400);
    expect(await ok("emulate", { tab, offline: true, network: "none" })).toMatch(/offline yes/);
    expect(await value(tab, "navigator.onLine")).toBe("false");
    const reset = await ok("emulate", { tab, reset: true });
    expect(reset).toMatch(/Cleared: .*offline/);
    expect(await json(tab, probe)).toEqual(before);
  });
});

test("the emulate description says how to see the valid device names", async () => {
  const { tools } = await mcp.client.listTools();
  const emulate = tools.find((tool) => tool.name === "emulate");
  expect(JSON.stringify(emulate?.inputSchema)).toContain(
    "An unknown name returns the list of valid names.",
  );
});

describe("an emulated offline slow network", () => {
  const probe = "[navigator.onLine, navigator.connection.rtt, navigator.connection.downlink]";
  let tab = "";
  let emulated: unknown;

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: fixture().url }));
  });

  beforeEach(async () => {
    await ok("emulate", { tab, offline: true, network: "slow3g" });
    emulated = await json(tab, probe);
  });

  afterAll(async () => {
    await ok("emulate", { tab, reset: true });
    await ok("tabs", { close: [tab] });
  });

  test("shows as offline in the page", async () => {
    expect(await value(tab, "navigator.onLine")).toBe("false");
  });

  test.each<[string, () => Promise<string>]>([
    ["a screenshot", () => ok("screenshot", { tab })],
    [
      "save_pages as mhtml",
      () => ok("save_pages", { tabs: [tab], include: ["mhtml"], settle_ms: 0 }),
    ],
    ["an IndexedDB listing", () => ok("storage", { tab, area: "indexeddb", action: "list" })],
    ["an isolated evaluate", () => ok("evaluate", { tab, expression: "1", world: "isolated" })],
    [
      "compare_design",
      async () => {
        const reference = path.join(mcp.workDir, "offline-reference.png");
        await writeFile(reference, await encodePng(createImage(400, 300, [255, 255, 255, 255])));
        return ok("compare_design", { tab, reference, model: "none" });
      },
    ],
    [
      "a recording",
      async () => {
        await ok("recording", { action: "start", tab });
        return ok("recording", { action: "stop", tab });
      },
    ],
  ])("stays emulated after %s", async (_, run) => {
    await run();
    expect(await json(tab, probe)).toEqual(emulated);
  });

  test("a navigation that fails says the tab is emulating offline", async () => {
    const failed = await call("navigate", { tab, url: `${fixture().url}/article` });
    expect(failed.text).toContain(
      `The tab is emulating offline, so it loads nothing from the network; turn that off with emulate offline: false, then navigate again.`,
    );
  });
});
