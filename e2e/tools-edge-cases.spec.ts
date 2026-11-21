import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sleep } from "../src/shared/async.ts";
import { edgeAuth } from "./fixture-edge.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab } = useToolsHarness("tools-edge-cases");

const SIGN_IN_NOTE = /Note: this looks like a sign-in page; the session may have expired\./;
const LEAVE_EVENT =
  "Event: the page asked to confirm leaving (unsaved changes); navigation was cancelled. Call navigate again with force: true to leave anyway.";
const PASSKEY_EVENT = "Event: the page requested a passkey or security key; use handoff";
const MIXED_TEXT = "Çağrı İstanbul’da ığdır şöförü 👩🏽‍💻 🏳️‍🌈 שלום עולם مرحبا";

describe("browser edge cases", () => {
  let tab = "";
  const authTexts: string[] = [];

  beforeAll(async () => {
    edgeAuth.username = "fixture-user";
    edgeAuth.password = TEST_SECRET;
    tab = openedTab(await ok("tab_open", { url: fixture().url }));
  });

  afterAll(async () => {
    await ok("tab_close", { tab });
  });

  test("a Basic-auth page without credentials points to http_auth", async () => {
    expect((await call("navigate", { tab, url: `${fixture().url}/auth-c/` })).text).toMatch(
      /HTTP authentication[\s\S]*use http_auth/i,
    );
  });

  test("http_auth set answers the Basic challenge for the origin", async () => {
    authTexts.push(
      await ok("http_auth", { action: "set", origin: fixture().url, secret: "fixture/site" }),
    );
    expect(await ok("navigate", { tab, url: `${fixture().url}/auth-a/` })).toMatch(/HTTP 200/);
  });

  test("subresource requests on an authorized origin are answered too", async () => {
    await ok("wait_for", { tab, text: "api auth-a" });
  });

  test("http_auth works while an intercept rule matches the same requests", async () => {
    await ok("intercept", {
      tab,
      action: "add",
      url: "/auth-b/",
      mode: "modify",
      set_headers: { "x-edge": "1" },
    });
    const text = await ok("navigate", { tab, url: `${fixture().url}/auth-b/` });
    await ok("intercept", { tab, action: "clear" });
    expect(text).toMatch(/HTTP 200/);
  });

  test("http_auth applies to other tabs of the profile", async () => {
    const other = openedTab(await ok("tab_open", { url: `${fixture().url}/auth-d/` }));
    const status = await ok("read_text", { tab: other, target: "#auth-state" });
    await ok("tab_close", { tab: other });
    expect(status).toMatch(/authorized auth-d/);
  });

  test("http_auth list names the origin and the secret", async () => {
    const text = await ok("http_auth", { action: "list" });
    authTexts.push(text);
    expect(text).toMatch(new RegExp(`${fixture().url.replace(/[.]/g, "\\.")} .*fixture/site`));
  });

  test("http_auth results never contain the credentials", async () => {
    for (const text of authTexts) {
      expect(text).not.toContain(TEST_SECRET);
      expect(text).not.toContain(edgeAuth.username);
    }
  });

  test("http_auth clear stops answering new challenges", async () => {
    await ok("http_auth", { action: "clear", origin: fixture().url });
    expect((await call("navigate", { tab, url: `${fixture().url}/auth-c/` })).text).toMatch(
      /HTTP authentication[\s\S]*use http_auth/i,
    );
  });

  test("a reCAPTCHA widget is reported after navigate", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha` })).toMatch(
      /^Challenge: reCAPTCHA on this page \(.+\)\. Use handoff to let the user complete it\.$/m,
    );
  });

  test("an invisible reCAPTCHA badge is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-invisible` }),
    ).not.toMatch(/Challenge:/);
  });

  test("an hCaptcha widget is reported after tab_open", async () => {
    const text = await ok("tab_open", { url: `${fixture().url}/challenge/hcaptcha` });
    await ok("tab_close", { tab: openedTab(text) });
    expect(text).toMatch(/^Challenge: hCaptcha on this page/m);
  });

  test("a Turnstile widget is reported", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/turnstile` })).toMatch(
      /^Challenge: Cloudflare Turnstile on this page/m,
    );
  });

  test("a Cloudflare interstitial is reported", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare` })).toMatch(
      /^Challenge: Cloudflare interstitial on this page/m,
    );
  });

  test("a 429 block page is reported", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/blocked` })).toMatch(
      /^Challenge: block page on this page \(HTTP 429/m,
    );
  });

  test("a 403 page without block wording is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/plain-error` }),
    ).not.toMatch(/Challenge:/);
  });

  test("a page without challenge markers adds no challenge line", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/start` })).not.toMatch(
      /Challenge:/,
    );
  });

  test("a widget that appears after a click is reported", async () => {
    expect(await ok("click", { tab, target: "#inject-hcaptcha" })).toMatch(
      /^Challenge: hCaptcha on this page/m,
    );
  });

  test("a click that navigates onto a challenge page reports it", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/start` });
    expect(await ok("click", { tab, target: "#to-recaptcha" })).toMatch(
      /^Challenge: reCAPTCHA on this page/m,
    );
  });

  test("permissions grant answers a notification permission prompt", async () => {
    await ok("navigate", { tab, url: fixture().url });
    await ok("permissions", { tab, action: "grant", grant: ["notifications"] });
    expect(await ok("evaluate", { tab, expression: "Notification.permission" })).toMatch(
      /granted\s*$/,
    );
  });

  test("permissions grants for one origin accumulate", async () => {
    await ok("permissions", { tab, action: "grant", grant: ["geolocation"] });
    expect(
      await ok("evaluate", {
        tab,
        expression: "navigator.permissions.query({ name: 'notifications' }).then((s) => s.state)",
      }),
    ).toMatch(/granted\s*$/);
  });

  test("permissions clear removes the grants of the origin", async () => {
    await ok("permissions", { tab, action: "clear" });
    expect(
      await ok("evaluate", {
        tab,
        expression: "navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)",
      }),
    ).not.toMatch(/granted\s*$/);
  });

  test("permissions rejects an unknown permission name", async () => {
    expect((await call("permissions", { tab, action: "grant", grant: ["teleport"] })).isError).toBe(
      true,
    );
  });

  test("leaving a page with unsaved changes is cancelled and reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/unsaved` });
    await ok("click", { tab, target: "#draft" });
    await ok("fill", { tab, target: "#draft", text: "draft text" });
    expect(await ok("navigate", { tab, url: fixture().url })).toContain(LEAVE_EVENT);
  });

  test("the tab stays on the page after a cancelled leave", async () => {
    expect(await ok("evaluate", { tab, expression: "location.pathname" })).toMatch(/\/unsaved\s*$/);
  });

  test("a click on a link away from unsaved changes reports the cancelled leave", async () => {
    expect(await ok("click", { tab, target: "#leave" })).toContain(LEAVE_EVENT);
  });

  test("navigate with force leaves a page with unsaved changes", async () => {
    expect(await ok("navigate", { tab, url: fixture().url, force: true })).toMatch(/Fixture Home/);
  });

  test("tab_close without force keeps a tab with unsaved changes", async () => {
    const draft = openedTab(await ok("tab_open", { url: `${fixture().url}/unsaved` }));
    await ok("click", { tab: draft, target: "#draft" });
    const result = await call("tab_close", { tab: draft });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unsaved changes.*force: true/s);
    await ok("tab_close", { tab: draft, force: true });
  });

  test("tab_close with force closes a tab with unsaved changes", async () => {
    const draft = openedTab(await ok("tab_open", { url: `${fixture().url}/unsaved` }));
    await ok("click", { tab: draft, target: "#draft" });
    await ok("tab_close", { tab: draft, force: true });
    expect((await call("snapshot", { tab: draft })).text).toMatch(/is not open/);
  });

  test("a passkey request is reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/passkey` });
    expect(await ok("click", { tab, target: "#passkey" })).toContain(PASSKEY_EVENT);
  });

  test("conditional passkey autofill is not reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/passkey` });
    expect(await ok("click", { tab, target: "#conditional" })).not.toContain(PASSKEY_EVENT);
  });

  test("a redirect to a sign-in page after navigate adds the note", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/app/account` });
    expect(await ok("navigate", { tab, url: `${fixture().url}/app/private` })).toMatch(
      SIGN_IN_NOTE,
    );
  });

  test("navigating to a sign-in page on purpose adds no note", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/app/account` });
    expect(await ok("navigate", { tab, url: `${fixture().url}/login` })).not.toMatch(SIGN_IN_NOTE);
  });

  test("an inline sign-in form at the requested URL adds the note", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/app/account` });
    expect(await ok("navigate", { tab, url: `${fixture().url}/app/inline` })).toMatch(SIGN_IN_NOTE);
  });

  test("a click that is redirected to a sign-in page adds the note", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/app/account` });
    expect(await ok("click", { tab, target: "#to-private" })).toMatch(SIGN_IN_NOTE);
  });

  test("a click on a plain sign-in link adds no note", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/app/account` });
    expect(await ok("click", { tab, target: "#to-login" })).not.toMatch(SIGN_IN_NOTE);
  });

  test("closing an OAuth popup is reported on the opener", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/popups` });
    const opened = await ok("click", { tab, target: "#open-popup" });
    const popup =
      /opened new tab (t\d+)/.exec(opened)?.[1] ??
      /opened new tab (t\d+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1] ??
      "";
    expect(popup).toMatch(/^t\d+$/);
    await ok("click", { tab: popup, target: "#finish" });
    await sleep(200);
    expect(await ok("press", { tab, key: "Shift" })).toMatch(
      new RegExp(
        `tab ${popup} \\(popup\\) closed, with no tool call running on ${tab}; this tab ${tab} is at ${fixture().url.replace(/[.]/g, "\\.")}/popups`,
      ),
    );
  });

  test("a popup opened by a click is not reported as blocked", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/popups` });
    const text = await ok("click", { tab, target: "#open-popup" });
    const popup = /opened new tab (t\d+)/.exec(text)?.[1];
    if (popup) await ok("tab_close", { tab: popup });
    expect(text).not.toMatch(/popup was blocked/);
  });

  test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
    "a popup opened without a user gesture is reported as blocked",
    async () => {
      expect(await ok("navigate", { tab, url: `${fixture().url}/popup-onload` })).toMatch(
        /^Event: a popup was blocked/m,
      );
    },
  );

  test("a tab navigated outside a tool call is noted on the next call", async () => {
    await ok("navigate", { tab, url: fixture().url });
    await mcp.deps.manager.getTab(tab).page.goto(`${fixture().url}/article`);
    expect(await ok("read_text", { tab, max_chars: 200 })).toStartWith(
      `Note: the tab moved to ${fixture().url}/article since your last call.`,
    );
  });

  test("the moved note is given only once", async () => {
    expect(await ok("read_text", { tab, max_chars: 200 })).not.toMatch(/the tab moved to/);
  });

  test("a navigation made by a tool is not noted as a move", async () => {
    await ok("navigate", { tab, url: fixture().url });
    expect(await ok("read_text", { tab, max_chars: 200 })).not.toMatch(/the tab moved to/);
  });

  test("a tab closed outside a tool call is named on the next call", async () => {
    const other = openedTab(await ok("tab_open", { url: fixture().url }));
    await mcp.deps.manager.getTab(other).page.close();
    const result = await call("snapshot", { tab: other });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      new RegExp(
        `^Tab ${other} is not open \\(it was at ${fixture().url}/ "Fixture Home"\\); it was closed outside this session\\.`,
      ),
    );
  });

  test("fill picks the matching option of a custom combobox", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    await ok("fill", { tab, target: "#fruit", text: "Banana" });
    expect(await ok("read_text", { tab, target: "#fruit-state" })).toMatch(/Banana/);
  });

  test("fill on a custom combobox lists the options when none matches", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    const result = await call("fill", { tab, target: "#fruit", text: "Mango" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Apple, Banana, Cherry/);
  });

  test("fill on a read-only date input fails with the steps to pick a date", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    const result = await call("fill", { tab, target: "#date", text: "2026-11-21" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Click the control, take a snapshot, then click the option/);
  });

  test("fill keeps line breaks in a contenteditable editor", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    await ok("fill", { tab, target: "#editor", text: "Line one\nLine two\nLine three" });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "JSON.stringify(document.querySelector('#editor').innerText.split('\\n').filter(Boolean))",
      }),
    ).toMatch(/\["Line one","Line two","Line three"\]/);
  });

  test("fill replaces the content of a contenteditable editor", async () => {
    await ok("fill", { tab, target: "#editor", text: "Fresh" });
    expect(
      await ok("evaluate", {
        tab,
        expression: "JSON.stringify(document.querySelector('#editor').innerText.trim())",
      }),
    ).toMatch(/"Fresh"/);
  });

  test("fill writes into an editor iframe and keeps line breaks", async () => {
    await ok("fill", { tab, target: 'iframe[title="Rich editor"]', text: "Top\nBottom" });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "JSON.stringify(document.querySelector('iframe').contentDocument.body.innerText.split('\\n').filter(Boolean))",
      }),
    ).toMatch(/\["Top","Bottom"\]/);
  });

  test("fill slowly keeps line breaks in a contenteditable editor", async () => {
    await ok("fill", { tab, target: "#editor", text: "Slow one\nSlow two", slowly: true });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "JSON.stringify(document.querySelector('#editor').innerText.split('\\n').filter(Boolean))",
      }),
    ).toMatch(/\["Slow one","Slow two"\]/);
  });

  test("fill stores Turkish, emoji and RTL text exactly", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/text` });
    await ok("fill", { tab, target: "#note", text: MIXED_TEXT });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#note').value" }),
    ).toContain(MIXED_TEXT);
  });

  test("fill slowly stores Turkish, emoji and RTL text exactly", async () => {
    await ok("fill", { tab, target: "#body", text: MIXED_TEXT, slowly: true });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#body').value" }),
    ).toContain(MIXED_TEXT);
  });

  test("fill reports no mismatch for mixed-script text", async () => {
    expect(await ok("fill", { tab, target: "#note", text: MIXED_TEXT })).not.toMatch(
      /reformatted or rejected/,
    );
  });

  test("read_text returns mixed-script text unchanged", async () => {
    expect(await ok("read_text", { tab, target: "#sample" })).toContain(MIXED_TEXT);
  });

  test("snapshot keeps mixed-script text", async () => {
    expect(await ok("snapshot", { tab })).toContain(MIXED_TEXT);
  });

  test("find matches Turkish text regardless of dotted capital I", async () => {
    expect(await ok("find", { tab, query: "çağrı istanbul" })).toMatch(/Çağrı İstanbul/);
  });

  test("find matches an emoji ZWJ sequence", async () => {
    expect(await ok("find", { tab, query: "👩🏽‍💻" })).toMatch(/^\d+ matches/m);
  });

  test("find matches RTL text", async () => {
    expect(await ok("find", { tab, query: "שלום עולם" })).toMatch(/^\d+ matches/m);
  });

  test("find matches an accessible name with an emoji", async () => {
    expect(await ok("find", { tab, query: "gönder 👍" })).toMatch(/button "Gönder 👍"/);
  });

  test("navigate to a file download reports the saved file", async () => {
    await ok("navigate", { tab, url: fixture().url });
    const text = await ok("navigate", { tab, url: `${fixture().url}/download` });
    const file = /^Downloaded .* to (\S+)$/m.exec(text)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toBe("a,b\n1,2\n");
  });

  test("navigate to a download says the tab stayed on its page", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/download` })).toMatch(
      new RegExp(`tab stays at ${fixture().url.replace(/[.]/g, "\\.")}/ `),
    );
  });

  test("tab_open on a file download reports the saved file", async () => {
    const text = await ok("tab_open", { url: `${fixture().url}/download` });
    await ok("tab_close", { tab: openedTab(text) });
    expect(text).toMatch(/^Downloaded .* to \S+report\.csv$/m);
  });
});
