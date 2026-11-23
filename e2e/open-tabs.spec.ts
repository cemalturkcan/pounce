import { expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { z } from "zod";
import { repeatUntil, sleep } from "../src/shared/async.ts";
import type { CallResult } from "../tests/mcpHarness.ts";
import { focusEvents, holdsFocus, useToolsHarness } from "./tools-harness.ts";

const { mcp, fixture, ok, openedTab } = useToolsHarness("open-tabs");

test("tabs opened concurrently right after launch each load their own page", async () => {
  const routes = ["/counter", "/frames", "/article", "/doc", "/media"];
  const results = await Promise.all(
    routes.map((route) => mcp.call("navigate", { url: `${fixture().url}${route}` })),
  );
  const texts = results.map((result) => result.text);
  const ids = texts.map((text) => /Opened (t\d+)/.exec(text)?.[1]);
  expect(new Set(ids).size).toBe(routes.length);
  for (const [index, route] of routes.entries()) {
    expect(texts[index] ?? "").toMatch(new RegExp(`Opened t\\d+: \\S+${route} .*\\(HTTP 200\\)`));
  }
});

const pageErrors = (structured: CallResult["structured"]) =>
  z
    .array(z.object({ url: z.string(), error: z.string().optional() }))
    .parse(structured?.pages)
    .filter((page) => page.error !== undefined);

test("concurrent save_pages calls each load every one of their pages", async () => {
  const batches = [["/article", "/doc"], ["/counter"], ["/frames", "/media", "/consent"]];
  const results = await Promise.all(
    batches.map((routes) =>
      mcp.call("save_pages", {
        urls: routes.map((route) => fixture().url + route),
        settle_ms: 0,
      }),
    ),
  );
  expect(results.flatMap((result) => pageErrors(result.structured))).toEqual([]);
});

test("ask_pages with urls loads its pages while save_pages runs next to it", async () => {
  const [, asked] = await Promise.all([
    ok("save_pages", {
      urls: ["/article", "/counter", "/frames", "/media"].map((route) => fixture().url + route),
      settle_ms: 0,
    }),
    ok("ask_pages", {
      question: "What does this page show?",
      urls: [`${fixture().url}/doc`, `${fixture().url}/consent`],
      browse: "off",
    }),
  ]);
  expect(asked).not.toMatch(/Not loaded/);
});

test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
  "a blocked popup is still reported when tabs open next to it",
  async () => {
    const tab = openedTab(await ok("navigate", { url: "about:blank" }));
    const [navigated] = await Promise.all([
      ok("navigate", { tab, url: `${fixture().url}/popup-onload` }),
      ...["/article", "/doc", "/counter"].map((route) =>
        ok("navigate", { url: fixture().url + route }),
      ),
    ]);
    expect(navigated).toMatch(/^Event: a popup was blocked/m);
  },
);

test("a tab the agent opens stays behind the tab the user is on", async () => {
  const first =
    /Opened (t\d+)/.exec((await mcp.call("navigate", { url: "about:blank" })).text)?.[1] ?? "";
  const user = await mcp.deps.manager.getTab(first).page.context().newPage();
  await user.goto(`${fixture().url}/article`);
  await user.bringToFront();
  await mcp.call("navigate", { url: `${fixture().url}/counter` });
  expect(await holdsFocus(user)).toBe(true);
});

const userTabHoldingFocus = async () => {
  const first = openedTab(await ok("navigate", { url: "about:blank" }));
  const user = await mcp.deps.manager.getTab(first).page.context().newPage();
  await ok("tabs", { close: [first] });
  await user.goto(`${fixture().url}/article`);
  await user.bringToFront();
  expect(await holdsFocus(user)).toBe(true);
  return user;
};

const userTabWatchedForBlur = async () => {
  const user = await userTabHoldingFocus();
  await user.evaluate(() => {
    const root = document.documentElement;
    root.dataset.blurs = "0";
    addEventListener("blur", () => (root.dataset.blurs = String(Number(root.dataset.blurs) + 1)));
  });
  return {
    user,
    blurs: () => user.evaluate(() => Number(document.documentElement.dataset.blurs)),
  };
};

test("a tab's first navigate never takes the front from the user's tab", async () => {
  const { user, blurs } = await userTabWatchedForBlur();
  const tab = openedTab(await ok("navigate", { url: "about:blank" }));
  await ok("navigate", { tab, url: `${fixture().url}/animate` });
  const count = await blurs();
  await ok("tabs", { close: [tab] });
  await user.close();
  expect(count).toBe(0);
});

test("recording start and stop on a tab behind never take the front from the user's tab", async () => {
  const { user, blurs } = await userTabWatchedForBlur();
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/animate` }));
  await ok("recording", { action: "start", tab });
  await sleep(500);
  await ok("recording", { action: "stop", tab });
  const count = await blurs();
  await ok("tabs", { close: [tab] });
  await user.close();
  expect(count).toBe(0);
});

test("actions on a tab behind never take the front from the user's tab", async () => {
  const { user, blurs } = await userTabWatchedForBlur();
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
  await ok("click", { tab, target: "h1", human: true });
  await ok("scroll", { tab, direction: "down" });
  await ok("press", { tab, key: "Tab" });
  await ok("screenshot", { tab });
  const count = await blurs();
  await ok("tabs", { close: [tab] });
  await user.close();
  expect(count).toBe(0);
});

test("closing an agent tab that is in front never brings the user's tab back", async () => {
  const user = await userTabHoldingFocus();
  const focuses = await focusEvents(user);
  const front = openedTab(await ok("navigate", { url: `${fixture().url}/counter` }));
  const beside = openedTab(await ok("navigate", { url: `${fixture().url}/counter` }));
  await mcp.deps.manager.getTab(front).page.bringToFront();
  await ok("tabs", { close: [front] });
  const count = await focuses();
  await ok("tabs", { close: [beside] });
  await user.close();
  expect(count).toBe(0);
});

const agentTabInFrontAfter = async (
  prepare: (behind: string) => Promise<string>,
  route: string,
) => {
  const user = await userTabHoldingFocus();
  const behind = openedTab(await ok("navigate", { url: fixture().url + route }));
  await prepare(behind);
  const front = mcp.deps.manager.getTab(
    openedTab(await ok("navigate", { url: `${fixture().url}/counter` })),
  ).page;
  await front.bringToFront();
  await ok("tabs", { close: [behind] });
  const kept = await holdsFocus(front);
  await front.close();
  await user.close();
  return kept;
};

test("closing an agent tab behind after a hover on it leaves the tab in front where it is", async () => {
  const kept = await agentTabInFrontAfter(
    (behind) => ok("hover", { tab: behind, target: "#menu-label" }),
    "/hover-menu",
  );
  expect(kept).toBe(true);
});

test("closing an agent tab behind after accepting a dialog it opened on a click leaves the tab in front where it is", async () => {
  const kept = await agentTabInFrontAfter(async (behind) => {
    await ok("click", { tab: behind, target: "#confirm" });
    return ok("dialog", { tab: behind, action: "accept" });
  }, "/dialogs");
  expect(kept).toBe(true);
});

test("closing an agent tab behind whose navigate accepted a cookie banner leaves the tab in front where it is", async () => {
  const kept = await agentTabInFrontAfter(async () => "", "/consent");
  expect(kept).toBe(true);
});

test("closing an agent tab behind after a scroll on it leaves the tab in front where it is", async () => {
  const kept = await agentTabInFrontAfter(
    (behind) => ok("scroll", { tab: behind, direction: "down" }),
    "/article",
  );
  expect(kept).toBe(true);
});

test("closing an agent tab behind that a script hovered leaves the tab in front where it is", async () => {
  const kept = await agentTabInFrontAfter(
    () =>
      ok("run_script", {
        code: `const page = context.pages().find((candidate) => candidate.url().endsWith("/hover-menu")); await page.hover("#menu-label");`,
      }),
    "/hover-menu",
  );
  expect(kept).toBe(true);
});

test("closing an agent tab in front that opened after the user's tab left the front does not bring that tab back", async () => {
  const user = await userTabHoldingFocus();
  const elsewhere = mcp.deps.manager.getTab(
    openedTab(await ok("navigate", { url: `${fixture().url}/doc` })),
  ).page;
  await elsewhere.bringToFront();
  const focuses = await focusEvents(user);
  const later = openedTab(await ok("navigate", { url: `${fixture().url}/counter` }));
  await mcp.deps.manager.getTab(later).page.bringToFront();
  await ok("tabs", { close: [later] });
  const count = await focuses();
  await elsewhere.close();
  await user.close();
  expect(count).toBe(0);
});

test("closing the tabs save_pages opens leaves the tab in front where it is", async () => {
  const user = await userTabHoldingFocus();
  const front = mcp.deps.manager.getTab(
    openedTab(await ok("navigate", { url: `${fixture().url}/counter` })),
  ).page;
  await front.bringToFront();
  await ok("save_pages", {
    urls: [`${fixture().url}/article`, `${fixture().url}/doc`],
    settle_ms: 0,
  });
  const kept = await holdsFocus(front);
  await front.close();
  await user.close();
  expect(kept).toBe(true);
});

const keepBusy = (page: Page, ms: number) => {
  void page
    .evaluate((until) => {
      while (Date.now() < until) Math.random();
    }, Date.now() + ms)
    .catch(() => undefined);
  return sleep(300);
};

const busyAgentTab = async () => {
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/counter` }));
  await keepBusy(mcp.deps.manager.getTab(tab).page, 60_000);
  return tab;
};

const timed = async (work: Promise<unknown>) => {
  const started = Date.now();
  await work;
  return Date.now() - started;
};

test("closing an agent tab whose page is busy returns while the user's tab is in front", async () => {
  const user = await userTabHoldingFocus();
  const busy = await busyAgentTab();
  const took = await timed(mcp.call("tabs", { close: [busy], force: true }));
  await user.close();
  expect(took).toBeLessThan(5000);
});

test("a close queued behind the close of a busy agent tab returns", async () => {
  const user = await userTabHoldingFocus();
  const idle = openedTab(await ok("navigate", { url: `${fixture().url}/counter` }));
  const busy = await busyAgentTab();
  const first = mcp.call("tabs", { close: [busy], force: true });
  const took = await timed(mcp.call("tabs", { close: [idle], force: true }));
  await first;
  await user.close();
  expect(took).toBeLessThan(5000);
});

const unsavedAgentTab = async () => {
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/unsaved` }));
  await ok("click", { tab, target: "#draft" });
  return tab;
};

test("an agent tab that refused to close still has focus in its page once the user is back on their tab", async () => {
  const user = await userTabHoldingFocus();
  const draft = await unsavedAgentTab();
  await mcp.call("tabs", { close: [draft] });
  await user.bringToFront();
  const page = mcp.deps.manager.getTab(draft).page;
  const focused = await page.evaluate(() => document.hasFocus());
  await ok("tabs", { close: [draft], force: true });
  await user.close();
  expect(focused).toBe(true);
});

test("an agent tab in front that refused to close keeps the front", async () => {
  const user = await userTabHoldingFocus();
  const draft = await unsavedAgentTab();
  const page = mcp.deps.manager.getTab(draft).page;
  await page.bringToFront();
  await mcp.call("tabs", { close: [draft] });
  const kept = await holdsFocus(page);
  await ok("tabs", { close: [draft], force: true });
  await user.close();
  expect(kept).toBe(true);
});

test("a blank tab the user is on stays theirs when the agent opens a tab", async () => {
  const first =
    /Opened (t\d+)/.exec((await mcp.call("navigate", { url: "about:blank" })).text)?.[1] ?? "";
  const user = await mcp.deps.manager.getTab(first).page.context().newPage();
  await user.bringToFront();
  expect(await holdsFocus(user)).toBe(true);
  await mcp.call("navigate", { url: `${fixture().url}/counter` });
  expect(user.url()).toBe("about:blank");
});

test("a blank tab the user sees in an unfocused window stays theirs when the agent opens a tab", async () => {
  const first =
    /Opened (t\d+)/.exec((await mcp.call("navigate", { url: "about:blank" })).text)?.[1] ?? "";
  const context = mcp.deps.manager.getTab(first).page.context();
  const user = await context.newPage();
  const elsewhere = await context.newPage();
  await elsewhere.goto(`${fixture().url}/article`);
  await elsewhere.bringToFront();
  expect(await user.evaluate(() => document.visibilityState)).toBe("visible");
  expect(await holdsFocus(user)).toBe(false);
  await mcp.call("navigate", { url: `${fixture().url}/counter` });
  expect(user.url()).toBe("about:blank");
});

const FRAMES_IN_A_SECOND = `new Promise((resolve) => {
  let count = 0;
  const tick = () => {
    count += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setTimeout(() => resolve(count), 1000);
})`;

const framesAfterRelease = async (page: Page | undefined) => {
  let frames = Number.POSITIVE_INFINITY;
  await repeatUntil(
    async () => {
      frames = Number(await page?.evaluate(FRAMES_IN_A_SECOND));
      return frames < 10 ? true : undefined;
    },
    { giveUp: (attempts) => attempts >= 3 },
  );
  return frames;
};

const openedBehind = async (route: string) =>
  /Opened (t\d+)/.exec((await mcp.call("navigate", { url: fixture().url + route })).text)?.[1] ??
  "";

test("a tab the agent opens behind the user's tab keeps rendering frames while a call scrolls it", async () => {
  const id = await openedBehind("/feed");
  const result = await ok("run_script", {
    tab: id,
    code: `await page.evaluate(() => { document.body.style.minHeight = "5000px"; });
for (const top of [250, 0, 2000, 500]) {
  await page.evaluate((y) => window.scrollTo(0, y), top);
  await page.waitForTimeout(1000);
}
return await page.evaluate(${JSON.stringify(FRAMES_IN_A_SECOND)});`,
  });
  await ok("tabs", { close: [id] });
  expect(Number(/\d+/.exec(result)?.[0])).toBeGreaterThan(20);
});

test("a tab the agent opened behind the user's tab stops rendering frames once its call ended", async () => {
  const page = mcp.deps.manager.getTab(await openedBehind("/animate")).page;
  const frames = await framesAfterRelease(page);
  await page.close();
  expect(frames).toBeLessThan(10);
});

const framesReturned = (result: string) => Number(/\d+/.exec(result)?.[0]);

test("a popup a script reaches through the Playwright API keeps rendering frames while the script runs", async () => {
  const id = await openedBehind("/counter");
  const result = await ok("run_script", {
    tab: id,
    code: `const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  page.evaluate((url) => { window.open(url); }, ${JSON.stringify(`${fixture().url}/animate`)}),
]);
await popup.waitForLoadState("domcontentloaded");
await page.bringToFront();
await popup.waitForTimeout(500);
const frames = await popup.evaluate(${JSON.stringify(FRAMES_IN_A_SECOND)});
await popup.close();
return frames;`,
  });
  expect(framesReturned(result)).toBeGreaterThan(20);
});

test("a page a script opens with context.newPage keeps rendering frames while the script runs", async () => {
  const id = await openedBehind("/counter");
  const result = await ok("run_script", {
    tab: id,
    code: `const opened = await context.newPage();
await opened.goto(${JSON.stringify(`${fixture().url}/animate`)});
await page.bringToFront();
await opened.waitForTimeout(500);
const frames = await opened.evaluate(${JSON.stringify(FRAMES_IN_A_SECOND)});
await opened.close();
return frames;`,
  });
  expect(framesReturned(result)).toBeGreaterThan(20);
});

test("a popup a script reached through the Playwright API stops rendering frames once the script ended", async () => {
  const id = await openedBehind("/counter");
  const popupId = await ok("run_script", {
    tab: id,
    code: `const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  page.evaluate((url) => { window.open(url); }, ${JSON.stringify(`${fixture().url}/animate`)}),
]);
await popup.waitForLoadState("domcontentloaded");
await page.bringToFront();
return tabId(popup);`,
  });
  const popup = mcp.deps.manager.getTab(/t\d+/.exec(popupId)?.[0] ?? "").page;
  const frames = await framesAfterRelease(popup);
  await popup.close();
  expect(frames).toBeLessThan(10);
});

const popupThenWait = (url: string) => `const [popup] = await Promise.all([
  page.waitForEvent("popup"),
  page.evaluate((url) => { window.open(url); }, ${JSON.stringify(url)}),
]);
await popup.waitForLoadState("domcontentloaded");
await page.bringToFront();
await page.waitForTimeout(30000);`;

const popupOf = async (opener: string) => {
  const found = await repeatUntil(
    async () => mcp.deps.manager.listTabs().find((candidate) => candidate.openerId === opener),
    { delayMs: () => 100, giveUp: (attempts) => attempts > 50 },
  );
  expect(found).toBeDefined();
  return found?.page;
};

test("a popup a script reached stops rendering frames once the script timed out", async () => {
  const id = await openedBehind("/counter");
  const code = popupThenWait(`${fixture().url}/animate`);
  expect((await mcp.call("run_script", { tab: id, code, timeout_ms: 2500 })).text).toMatch(
    /timed out/,
  );
  const popup = await popupOf(id);
  const frames = await framesAfterRelease(popup);
  await popup?.close();
  expect(frames).toBeLessThan(10);
});

test("a popup a script reached stops rendering frames once the script was cancelled", async () => {
  const id = await openedBehind("/counter");
  const code = popupThenWait(`${fixture().url}/animate`);
  const started = await ok("run_script", { tab: id, background: true, code });
  const popup = await popupOf(id);
  await sleep(500);
  await ok("run_script", { job: /job (j\d+)/.exec(started)?.[1] ?? "", cancel: true });
  const frames = await framesAfterRelease(popup);
  await popup?.close();
  expect(frames).toBeLessThan(10);
});

const framesWhileScriptListsPages = async (id: string, watched: Page) => {
  await repeatUntil(
    async () => (Number(await watched.evaluate(FRAMES_IN_A_SECOND)) < 10 ? true : undefined),
    { delayMs: () => 0, giveUp: (attempts) => attempts > 5 },
  );
  const running = ok("run_script", {
    tab: id,
    code: "const count = context.pages().length; await page.waitForTimeout(2500); return count;",
  });
  await sleep(700);
  const frames: unknown = await watched.evaluate(FRAMES_IN_A_SECOND);
  await running;
  return Number(frames);
};

const userTabInFront = async (route: string) => {
  const page = await mcp.deps.manager.ensureContext().then((context) => context.newPage());
  await page.goto(fixture().url + route);
  return page;
};

test("a user's tab behind another that a script lists through context.pages() is not kept rendering", async () => {
  const user = await userTabInFront("/animate");
  const front = await userTabInFront("/counter");
  const id = await openedBehind("/counter");
  const frames = await framesWhileScriptListsPages(id, user);
  await Promise.all([user.close(), front.close()]);
  expect(frames).toBeLessThan(10);
});

test("a tab of another session that a script lists through context.pages() is not kept rendering", async () => {
  const front = await userTabInFront("/counter");
  const id = await openedBehind("/counter");
  const other = mcp.deps.manager.getTab(await openedBehind("/animate"));
  other.owner = "another-session";
  const frames = await framesWhileScriptListsPages(id, other.page);
  await Promise.all([other.page.close(), front.close()]);
  expect(frames).toBeLessThan(10);
});

test("a tab of the script's own session that the script lists through context.pages() is kept rendering", async () => {
  const front = await userTabInFront("/counter");
  const id = await openedBehind("/counter");
  const own = mcp.deps.manager.getTab(await openedBehind("/animate"));
  const frames = await framesWhileScriptListsPages(id, own.page);
  await Promise.all([own.page.close(), front.close()]);
  expect(frames).toBeGreaterThan(20);
});
