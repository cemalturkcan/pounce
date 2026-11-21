import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { inSequence, sleep } from "../src/shared/async.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, askPrompts, openedTab, refOf, dismissIn, counter } =
  useToolsHarness("tools-regressions");

describe("review regressions", () => {
  test("cancelling a background job stops it clicking in its bound tab", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/counter` }));
    const started = await ok("run_script", {
      tab,
      background: true,
      code: "for (;;) { await page.click('#count'); }",
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    await sleep(600);
    expect(await counter(tab)).toBeGreaterThan(0);
    expect(await ok("jobs", { action: "cancel", id })).toMatch(/ cancelled /);
    await sleep(200);
    const afterCancel = await counter(tab);
    await sleep(800);
    expect(await counter(tab)).toBe(afterCancel);
    await ok("tab_close", { tab });
  });

  test("a foreground timeout stops the script clicking", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/counter` }));
    const result = await call("run_script", {
      tab,
      timeout_ms: 1000,
      code: "for (;;) { try { await page.click('#count'); } catch {} }",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/timed out after 1000 ms/);
    await sleep(200);
    const afterTimeout = await counter(tab);
    expect(afterTimeout).toBeGreaterThan(0);
    await sleep(800);
    expect(await counter(tab)).toBe(afterTimeout);
    expect(await ok("tabs_list")).toMatch(new RegExp(`${tab} \\[yours\\]`));
    await ok("tab_close", { tab });
  });

  test("routes, listeners, bindings and init scripts of a script end with it", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    const registered = await ok("run_script", {
      tab,
      code: [
        `await context.route("**/*", (route) => route.abort());`,
        `await page.route("**/*", (route) => route.abort());`,
        `await context.addInitScript(() => { window.__scriptLeak = "init script"; });`,
        `await context.exposeBinding("scriptLeakBinding", () => "binding");`,
        `page.on("request", () => log("listener still attached"));`,
        `return "registered";`,
      ].join("\n"),
    });
    expect(registered).toMatch(/Returned: registered/);
    const other = openedTab(await ok("tab_open", { url: `${fixture().url}/article` }));
    expect(await ok("read_text", { tab: other })).toMatch(/Paragraph 7 of/);
    expect(
      await ok("evaluate", {
        tab: other,
        expression: "typeof window.__scriptLeak + ' ' + typeof window.scriptLeakBinding",
      }).then((text) => text.split("\n").pop()),
    ).toBe("undefined undefined");
    expect(await ok("navigate", { tab, url: `${fixture().url}/article` })).toMatch(/HTTP 200/);
    const timedOut = await call("run_script", {
      tab,
      timeout_ms: 1000,
      code: `await page.route("**/*", (route) => route.abort()); await sleep(5000);`,
    });
    expect(timedOut.text).toMatch(/timed out/);
    expect(await ok("navigate", { tab, url: fixture().url })).toMatch(/HTTP 200/);
    await ok("tab_close", { tab: other });
    await ok("tab_close", { tab });
  });

  test("a synchronous loop before the first await is stopped by timeout_ms", async () => {
    const startedAt = Date.now();
    const busy = await call("run_script", {
      timeout_ms: 1000,
      code: "const end = Date.now() + 6000; while (Date.now() < end) {} return 'finished';",
    });
    const elapsed = Date.now() - startedAt;
    expect(busy.isError).toBe(true);
    expect(busy.text).toMatch(/timed out after 1000 ms/);
    expect(elapsed).toBeLessThan(2500);
  });

  test("run_script save() defaults to .txt", async () => {
    const text = await ok("run_script", { code: "return await save('report', 'plain text');" });
    expect(text).toMatch(/-report\.txt$/m);
  });

  test("dismiss_overlays never clicks commit buttons", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/checkout` }));
    const text = await ok("dismiss_overlays", { tab, allow_accept: true });
    expect(text).toMatch(
      /^Modal \[role=dialog\] in main frame: closed by clicking "Vazgeç" \(cancel\)\.$/m,
    );
    expect(text).not.toMatch(/onayla|payment/i);
    expect(await ok("read_text", { tab, target: "#order-state" })).toMatch(/dialog dismissed/);
    const again = await ok("dismiss_overlays", { tab, allow_accept: true });
    expect(again).not.toMatch(/Clicked|closed by/);
    expect(await ok("read_text", { tab, target: "#order-state" })).toMatch(/dialog dismissed/);
    await ok("tab_close", { tab });
  });

  test("dismiss_overlays closes a modal whose close control is plain text", async () => {
    const { text, state } = await dismissIn("/modal/text-close");
    expect(text).toMatch(/^Modal \.modal in main frame: closed by clicking "Close" \(close\)\.$/m);
    expect(state).toMatch(/closed by footer/);
  });

  test("dismiss_overlays closes a modal without a close control by pressing Escape", async () => {
    const { text, state } = await dismissIn("/modal/escape");
    expect(text).toMatch(/^Modal #promo in main frame: closed by pressing Escape\.$/m);
    expect(state).toMatch(/closed by escape/);
  });

  test("dismiss_overlays closes a modal by clicking its backdrop when Escape does nothing", async () => {
    const { text, state } = await dismissIn("/modal/backdrop");
    expect(text).toMatch(/^Modal \.popup-box in main frame: closed by a click outside it\.$/m);
    expect(state).toMatch(/closed by backdrop/);
  });

  test("dismiss_overlays says when a modal is found but nothing closes it, and leaves its order button alone", async () => {
    const { text, state } = await dismissIn("/modal/stuck");
    expect(text).toMatch(
      /^Modal \[role=dialog\] in main frame: found, but no close control worked \(tried Escape\)\.$/m,
    );
    expect(state).toMatch(/^open/m);
  });

  test("a click that only changes an iframe reports a change", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/frames` }));
    const snapshot = await ok("snapshot", { tab });
    const text = await ok("click", { tab, target: refOf(snapshot, 'button "Inner only"') });
    expect(text).toMatch(/The page changed/);
    expect(await ok("scroll", { tab, direction: "down", amount: 10 })).toMatch(
      /No DOM change after the action|The page changed/,
    );
    await ok("navigate", { tab, url: fixture().url });
    const filled = await ok("fill", { tab, target: "#email", text: "quiet@example.test" });
    expect(filled).not.toMatch(/No change detected|No DOM change/);
    await ok("tab_close", { tab });
  });

  test("secrets stay masked in overflow files and usernames are not masked", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    await ok("fill", { tab, target: "#password", secret: "fixture/site" });
    await ok("fill", { tab, target: "#email", secret: "fixture/site", secret_field: "username" });
    const text = await ok("evaluate", {
      tab,
      max_chars: 200,
      expression:
        "({ pad: 'x'.repeat(400), raw: document.querySelector('#password').value, json: JSON.stringify({ p: document.querySelector('#password').value + '\"' }), url: encodeURIComponent(document.querySelector('#password').value + ' &'), user: document.querySelector('#email').value })",
    });
    const file = /saved to (\S+)\.\]/.exec(text)?.[1] ?? "";
    const saved = await readFile(file, "utf8");
    expect(saved).not.toContain(TEST_SECRET);
    expect(saved).not.toContain(encodeURIComponent(TEST_SECRET));
    expect(saved).toMatch(/fixture-user/);
    expect(saved).toMatch(/<secret:fixture\/site:password>/);
    await ok("tab_close", { tab });
  });

  test("collected files and ask_pages prompts mask stored secrets", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    await ok("fill", { tab, target: "#password", secret: "fixture/site" });
    await ok("tab_close", { tab });
    const page = `data:text/html,<title>Account</title><main><h1>Account</h1><p>Your key is ${TEST_SECRET}</p><table><tr><td>password</td><td>${TEST_SECRET}</td></tr></table><a href="/x?k=${TEST_SECRET}">link</a></main>`;
    const collected = await ok("collect_pages", {
      urls: [page],
      include: ["text", "markdown", "snapshot", "structured", "links"],
    });
    const dir = /into (\S+)/.exec(collected)?.[1] ?? "";
    const contents = await Promise.all(
      (await readdir(dir)).map((name) => readFile(path.join(dir, name), "utf8")),
    );
    for (const content of contents) expect(content).not.toContain(TEST_SECRET);
    askPrompts.length = 0;
    await ok("ask_pages", { question: "What is the key?", dir });
    expect(askPrompts.length).toBeGreaterThan(0);
    expect(askPrompts.filter((prompt) => prompt.includes(TEST_SECRET))).toStrictEqual([]);
  });

  test("evaluate runs code once and reports runtime errors", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    const before = fixture().hits();
    const result = await call("evaluate", {
      tab,
      expression: "fetch('/api/hit', { method: 'POST' }).then(() => JSON.parse('{'))",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/SyntaxError|JSON/);
    expect(fixture().hits()).toBe(before + 1);
    const local = await call("evaluate", {
      tab,
      expression: "(window.__runs = (window.__runs || 0) + 1, JSON.parse('{'))",
    });
    expect(local.isError).toBe(true);
    expect(await ok("evaluate", { tab, expression: "window.__runs" })).toMatch(/\b1\s*$/);
    const syntax = await call("evaluate", { tab, expression: "return (" });
    expect(syntax.isError).toBe(true);
    expect(syntax.text).toMatch(/does not parse/);
    await ok("tab_close", { tab });
  });

  test("a hung tab does not block tabs_list or collect_pages", async () => {
    const tab = openedTab(await ok("tab_open", {}));
    await ok("evaluate", { tab, expression: "setTimeout(() => { for (;;) {} }, 50); 'armed'" });
    await sleep(300);
    const started = Date.now();
    expect(await ok("tabs_list")).toMatch(
      new RegExp(`${tab} \\[yours\\] about:blank \\(unresponsive\\)`),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    await ok("tab_close", { tab });
    const before = mcp.deps.manager.listTabs().length;
    const collectStart = Date.now();
    const collected = await ok("collect_pages", {
      urls: [`${fixture().url}/hang`],
      include: ["text"],
      settle_ms: 600,
      timeout_ms: 1500,
    });
    expect(collected).toMatch(/01 FAILED .*timed out/);
    expect(Date.now() - collectStart).toBeLessThan(15_000);
    await sleep(300);
    expect(mcp.deps.manager.listTabs().length).toBe(before);
  });

  test("page reads on a hung tab fail instead of waiting forever", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    await ok("evaluate", { tab, expression: "setTimeout(() => { for (;;) {} }, 50); 'armed'" });
    await sleep(300);
    const started = Date.now();
    const results = await Promise.all([
      call("read_text", { tab }),
      call("extract", { tab }),
      call("storage", { tab, action: "list", area: "local" }),
      call("scroll", { tab, direction: "bottom" }),
    ]);
    expect(Date.now() - started).toBeLessThan(40_000);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/did not finish within \d+ s/);
    }
    await ok("tab_close", { tab, force: true });
  });

  test("request from_request does not ask for an encoding it cannot decode", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/zstd` }));
    const list = await ok("network_requests", { tab, pattern: "/zstd" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    expect(id, list).toBeGreaterThan(0);
    const replay = await ok("request", { tab, from_request: id });
    expect(replay).toMatch(/"item-19"/);
    await ok("tab_close", { tab });
  });

  test("streaming responses do not hang network tools", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/sse` }));
    await ok("wait_for", { tab, text: "streamed hello" });
    const list = await ok("network_requests", { tab, pattern: "/events" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    const started = Date.now();
    expect(await ok("network_requests", { tab, id })).toMatch(/streaming response/);
    expect(await ok("network_export", { tab })).toMatch(/Exported/);
    expect(Date.now() - started).toBeLessThan(10_000);
    await ok("tab_close", { tab });
  });

  test("a scoped snapshot keeps refs outside the subtree valid", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    const full = await ok("snapshot", { tab });
    const outside = refOf(full, 'button "Change status"');
    const scoped = await ok("snapshot", { tab, target: "#signup2" });
    expect(scoped).toMatch(/textbox "Name"/);
    expect(scoped).not.toMatch(/Change status/);
    const byRef = await ok("snapshot", { tab, target: refOf(full, 'button "Register"') });
    expect(byRef).toMatch(/button "Register"/);
    expect(await ok("click", { tab, target: outside })).toMatch(/The page changed/);
    await ok("tab_close", { tab });
  });

  test("patch_response patches JSON and leaves images intact", async () => {
    const tab = openedTab(await ok("tab_open", {}));
    await ok("intercept", {
      tab,
      action: "add",
      url: fixture().url,
      mode: "patch_response",
      replacements: [{ find: "loaded from api", replace: "patched by rule" }],
    });
    await ok("navigate", { tab, url: `${fixture().url}/media`, wait_until: "load" });
    expect(
      await ok("evaluate", { tab, expression: "document.getElementById('pixel').naturalWidth" }),
    ).toMatch(/\b1\s*$/);
    await ok("click", { tab, target: "#media-load" });
    await ok("wait_for", { tab, text: "patched by rule" });
    expect(await ok("intercept", { tab, action: "list" })).not.toMatch(/failed/);
    await ok("tab_close", { tab });
  });

  test("emulate keeps client-hint brands for locale-only overrides", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    const brands = async () =>
      (await ok("evaluate", { tab, expression: "JSON.stringify(navigator.userAgentData.brands)" }))
        .split("\n")
        .slice(1)
        .join("\n");
    const before = await brands();
    expect(JSON.parse(before).length).toBeGreaterThan(0);
    await ok("emulate", { tab, locale: "de-DE" });
    expect(await brands()).toBe(before);
    await ok("emulate", { tab, user_agent: "FixtureAgent/2.0" });
    expect(JSON.parse(await brands()).length).toBe(JSON.parse(before).length);
    await ok("emulate", { tab, user_agent: "", locale: "" });
    expect(await brands()).toBe(before);
    await ok("emulate", { tab, reset: true });
    expect(await brands()).toBe(before);
    await ok("tab_close", { tab });
  });

  test("cookie delete matches the domain exactly or by subdomain", async () => {
    await ok("cookies", { action: "set", domain: ".netflix.com", name: "keep_me", value: "1" });
    await ok("cookies", { action: "set", domain: ".x.com", name: "drop_me", value: "1" });
    expect(await ok("cookies", { action: "delete", domain: "x.com" })).toMatch(/Deleted 1 cookies/);
    expect(await ok("cookies", { action: "list", domain: "netflix" })).toMatch(/keep_me/);
    expect(await ok("cookies", { action: "delete", domain: "netflix.com" })).toMatch(
      /Deleted 1 cookies/,
    );
  });

  test("events from before an action are reported as earlier", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    await ok("evaluate", { tab, expression: "setTimeout(() => alert('from before'), 0); 1" });
    await sleep(300);
    const text = await ok("click", { tab, target: "#noop" });
    expect(text).toMatch(/Earlier event .*"from before"/);
    await ok("tab_close", { tab });
  });

  test("a failed tab_open names the tab it opened and keeps it", async () => {
    const failed = await call("tab_open", { url: "http://127.0.0.1:9/" });
    expect(failed.isError).toBe(true);
    const tab = /Tab (t\d+) was opened/.exec(failed.text)?.[1] ?? "";
    expect(tab, failed.text).toMatch(/^t\d+$/);
    expect(await ok("tabs_list")).toMatch(new RegExp(`^${tab} \\[yours\\]`, "m"));
    await ok("tab_close", { tab });
  });

  test("orphaned tabs close after 30 idle minutes", async () => {
    const tab = openedTab(await ok("tab_open", { url: fixture().url }));
    const kept = openedTab(await ok("tab_open", { url: fixture().url }));
    expect(mcp.deps.manager.orphanTabsOf("stdio")).toBeGreaterThanOrEqual(2);
    for (const other of mcp.deps.manager.listTabs())
      if (other.id !== tab) mcp.deps.manager.claimIfOrphaned(other.id, "stdio");
    expect(await mcp.deps.manager.closeIdleOrphans(Date.now() + 10 * 60_000)).toBe(0);
    expect(await mcp.deps.manager.closeIdleOrphans(Date.now() + 31 * 60_000)).toBe(1);
    expect(await ok("tabs_list")).not.toMatch(new RegExp(`^${tab} `, "m"));
    expect(await ok("tabs_list")).toMatch(new RegExp(`^${kept} \\[yours\\]`, "m"));
    await ok("tab_close", { tab: kept });
  });

  test("a session whose tabs were orphaned while it was idle keeps the tab its later job opens", async () => {
    mcp.deps.manager.orphanTabsOf("stdio");
    const started = await ok("run_script", {
      background: true,
      code: `const opened = await openTab(${JSON.stringify(`${fixture().url}/doc`)}); log("opened " + tabId(opened));`,
    });
    const id = /background job (j\d+)/.exec(started)?.[1] ?? "";
    await mcp.deps.jobs.get(id).finished;
    const tab = /opened (t\d+)/.exec(await ok("jobs", { action: "status", id }))?.[1] ?? "";
    expect(await ok("tabs_list")).toMatch(new RegExp(`^${tab} \\[yours\\]`, "m"));
    await ok("tab_close", { tab });
  });

  test("response bodies of a user tab are fetched only after a network tool asked for it", async () => {
    const context = await mcp.deps.manager.ensureContext();
    const page = await context.newPage();
    try {
      await page.goto(fixture().url);
      await page.click("#load");
      await sleep(600);
      const tab = mcp.deps.manager.tabOf(page);
      expect(tab?.network.length).toBeGreaterThan(0);
      expect(tab?.network.filter((entry) => entry.body).length).toBe(0);
      expect(await ok("network_requests", { tab: tab?.id })).toMatch(/GET 200/);
      await page.reload();
      await sleep(600);
      expect(tab?.network.filter((entry) => entry.body).length).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });

  test("tab_open does not take over an unclaimed popup", async () => {
    const context = await mcp.deps.manager.ensureContext();
    const parent = await context.newPage();
    await parent.goto(fixture().url);
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      parent.evaluate(() => void window.open("about:blank")),
    ]);
    await sleep(200);
    const popupTab = mcp.deps.manager.tabOf(popup);
    expect(popupTab).toBeDefined();
    const opened = openedTab(await ok("tab_open", {}));
    expect(opened).not.toBe(popupTab?.id);
    await ok("tab_close", { tab: opened });
    await popup.close();
    await parent.close();
  });

  test("concurrent closes never leave the browser without a page", async () => {
    await inSequence([0, 1, 2], () => ok("tab_open", {}));
    const ids = mcp.deps.manager.listTabs().map((tab) => tab.id);
    const results = await Promise.all(ids.map((id) => call("tab_close", { tab: id })));
    expect(results.filter((result) => result.isError)).toStrictEqual([]);
    const context = await mcp.deps.manager.ensureContext();
    expect(context.pages().length).toBeGreaterThanOrEqual(1);
    expect(await ok("tabs_list")).toMatch(/Browser running/);
    openedTab(await ok("tab_open", { url: fixture().url }));
  });
});
