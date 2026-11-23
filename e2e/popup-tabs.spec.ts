import { expect, test } from "bun:test";
import { focusEvents, holdsFocus, useToolsHarness } from "./tools-harness.ts";

const { mcp, fixture, ok, openedTab, call } = useToolsHarness("popup-tabs", {
  env: { WEB_AGENT_DEFAULT_LAUNCH_ARGS: "--disable-popup-blocking" },
});

async function whileOpeningTabs<T>(work: () => Promise<T>) {
  let running = true;
  const failures: string[] = [];
  const keepOpening = async (): Promise<void> => {
    if (!running) return;
    const opened = await call("navigate", { url: "about:blank" });
    if (opened.isError) failures.push(opened.text);
    return keepOpening();
  };
  const openers = Array.from({ length: 4 }, keepOpening);
  try {
    return { result: await work(), failures };
  } finally {
    running = false;
    await Promise.all(openers);
  }
}

test("a popup that opens while other tabs keep opening is not reported as blocked", async () => {
  const tab = openedTab(await ok("navigate", { url: "about:blank" }));
  const { result } = await whileOpeningTabs(() =>
    ok("navigate", { tab, url: `${fixture().url}/popup-onload` }),
  );
  expect(result).not.toMatch(/popup was blocked/);
});

test("popups that close themselves while tabs keep opening leave those opens working", async () => {
  const tab = openedTab(await ok("navigate", { url: "about:blank" }));
  const { failures } = await whileOpeningTabs(async () => {
    await ok("navigate", { tab, url: `${fixture().url}/popup-self-close` });
    await Bun.sleep(1200);
  });
  expect(failures).toEqual([]);
});

async function userTabInFront(agent: string) {
  const user = await mcp.deps.manager.getTab(agent).page.context().newPage();
  await user.goto(`${fixture().url}/article`);
  await user.bringToFront();
  return user;
}

test("a popup an agent tab opens never brings another tab of the user to the front", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/popups` }));
  const user = await userTabInFront(agent);
  await user.goto(`${fixture().url}/frames`);
  await user.frameLocator("iframe").locator("#inner").focus();
  const other = await user.context().newPage();
  await other.goto(`${fixture().url}/doc`);
  const focuses = await focusEvents(other);
  await other.bringToFront();
  await Bun.sleep(300);
  await user.bringToFront();
  const before = await focuses();
  await ok("click", { tab: agent, target: "#open-tab" });
  await Bun.sleep(500);
  const count = (await focuses()) - before;
  await other.close();
  await user.close();
  expect(count).toBe(0);
});

test("a popup an agent tab opens is listed as that agent's tab", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/popups` }));
  await userTabInFront(agent);
  const clicked = await ok("click", { tab: agent, target: "#open-tab" });
  const popup = /opened new tab (t\d+)/.exec(clicked)?.[1] ?? "";
  expect(await ok("tabs", {})).toMatch(new RegExp(`^${popup} \\[yours\\] \\S+/popup-child`, "m"));
});

test("a popup the user's own tab opens takes the focus", async () => {
  const agent = openedTab(await ok("navigate", { url: "about:blank" }));
  const user = await userTabInFront(agent);
  await user.goto(`${fixture().url}/`);
  const [popup] = await Promise.all([user.waitForEvent("popup"), user.click("#popup")]);
  await popup.waitForLoadState();
  await Bun.sleep(500);
  expect(await holdsFocus(popup)).toBe(true);
});

test("a plain click on a link that opens a new tab reports the new tab", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/` }));
  expect(await ok("click", { tab: agent, target: "#popup" })).toMatch(/opened new tab t\d+/);
});

test("a plain click on a button that calls window.open reports the new tab", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/popups` }));
  expect(await ok("click", { tab: agent, target: "#open-tab" })).toMatch(/opened new tab t\d+/);
});

test("a plain click on a button that opens a popup window reports the new tab", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/popups` }));
  expect(await ok("click", { tab: agent, target: "#open-popup" })).toMatch(/opened new tab t\d+/);
});

test("a plain click that opens a slow page in a new tab reports the new tab", async () => {
  const agent = openedTab(await ok("navigate", { url: `${fixture().url}/popups` }));
  expect(await ok("click", { tab: agent, target: "#open-slow" })).toMatch(
    /opened new tab for \S+\/popup-slow/,
  );
});
