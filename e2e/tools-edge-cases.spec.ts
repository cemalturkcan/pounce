import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sleep } from "../src/shared/async.ts";
import { edgeAuth } from "./fixture-edge.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab, refOf } = useToolsHarness("tools-edge-cases");

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
    tab = openedTab(await ok("navigate", { url: fixture().url }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("a Basic-auth page without credentials points to site with http_auth", async () => {
    expect((await call("navigate", { tab, url: `${fixture().url}/auth-c/` })).text).toMatch(
      /HTTP authentication[\s\S]*use site with http_auth/i,
    );
  });

  test("site http_auth set answers the Basic challenge for the origin", async () => {
    authTexts.push(await ok("site", { site: fixture().url, http_auth: "fixture/site" }));
    expect(await ok("navigate", { tab, url: `${fixture().url}/auth-a/` })).toMatch(/HTTP 200/);
  });

  test("subresource requests on an authorized origin are answered too", async () => {
    await ok("wait_for", { tab, text: "api auth-a" });
  });

  test("site http_auth works while an intercept rule matches the same requests", async () => {
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

  test("site http_auth applies to other tabs of the profile", async () => {
    const other = openedTab(await ok("navigate", { url: `${fixture().url}/auth-d/` }));
    const status = await ok("read_page", { tab: other, target: "#auth-state" });
    await ok("tabs", { close: [other] });
    expect(status).toMatch(/authorized auth-d/);
  });

  test("site http_auth list names the origin and the secret", async () => {
    const text = await ok("site", {});
    authTexts.push(text);
    expect(text).toMatch(
      new RegExp(`${fixture().url.replace(/[.]/g, "\\.")}: HTTP authentication with fixture/site`),
    );
  });

  test("site http_auth results never contain the credentials", async () => {
    for (const text of authTexts) {
      expect(text).not.toContain(TEST_SECRET);
      expect(text).not.toContain(edgeAuth.username);
    }
  });

  test("site http_auth clear stops answering new challenges", async () => {
    await ok("site", { site: fixture().url, clear: true });
    expect((await call("navigate", { tab, url: `${fixture().url}/auth-c/` })).text).toMatch(
      /HTTP authentication[\s\S]*use site with http_auth/i,
    );
  });

  test("a reCAPTCHA widget is reported after navigate", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha` })).toMatch(
      /^Challenge: reCAPTCHA check on this page \(.+\)\. Try it yourself first: click its checkbox or follow its prompt with human: true, then wait for it to clear; if it does not clear, use handoff to let the user complete it\.$/m,
    );
  });

  test("an invisible reCAPTCHA badge is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-invisible` }),
    ).not.toMatch(/Challenge:/);
  });

  test("an hCaptcha widget is reported after navigate", async () => {
    const text = await ok("navigate", { url: `${fixture().url}/challenge/hcaptcha` });
    await ok("tabs", { close: [openedTab(text)] });
    expect(text).toMatch(/^Challenge: hCaptcha check on this page/m);
  });

  test("a Turnstile widget is reported", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/turnstile` })).toMatch(
      /^Challenge: Cloudflare Turnstile check on this page/m,
    );
  });

  test("a reCAPTCHA widget that renders after the page loaded is reported", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-late` })).toMatch(
      /^Challenge: reCAPTCHA check on this page/m,
    );
  });

  test("a late widget on a page loaded again at the same path is reported again", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-late` });
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-late` })).toMatch(
      /^Challenge: reCAPTCHA check on this page/m,
    );
  });

  test("an action on a page whose widget container never renders answers without waiting for it", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-hidden` });
    const startedAt = Date.now();
    await ok("click", { tab, target: "#buy" });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test("a link to a fragment on a page whose widget container never renders answers without waiting for it", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-hidden` });
    const startedAt = Date.now();
    await ok("click", { tab, target: "#to-details" });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test("a replaceState URL change on a page whose widget container never renders answers without waiting for it", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-hidden` });
    const startedAt = Date.now();
    await ok("click", { tab, target: "#sort" });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test("a page whose button-bound reCAPTCHA keeps its badge hidden answers without waiting for it", async () => {
    const startedAt = Date.now();
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-badge-hidden` });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test("a page whose loaded widget sits in a closed dialog answers without waiting for it", async () => {
    const startedAt = Date.now();
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-modal` });
    expect(Date.now() - startedAt).toBeLessThan(2500);
  });

  test("a widget that renders late after a client-side route change is reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-route` });
    expect(await ok("click", { tab, target: "#to-login" })).toMatch(
      /^Challenge: reCAPTCHA check on this page/m,
    );
  });

  test("a Turnstile widget inside a closed shadow root is reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/turnstile-shadow` }),
    ).toMatch(/^Challenge: Cloudflare Turnstile check on this page/m);
  });

  test("a Turnstile widget that shows a while after the page loaded is reported by navigate", async () => {
    const text = await ok("navigate", { url: `${fixture().url}/challenge/turnstile-late` });
    await ok("tabs", { close: [openedTab(text)] });
    expect(text).toMatch(/^Challenge: Cloudflare Turnstile check on this page/m);
  });

  test("a Turnstile widget that shows a while after a reload is reported by navigate", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/turnstile-late` });
    expect(await ok("navigate", { tab, url: "reload", wait_until: "load" })).toMatch(
      /^Challenge: Cloudflare Turnstile check on this page/m,
    );
  });

  test("a solved Turnstile widget inside a closed shadow root is reported as solved", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/turnstile-shadow-solved` }),
    ).toMatch(
      /^Challenge solved: the Cloudflare Turnstile check on this page \(.+\) shows as solved; carry on with the page\.$/m,
    );
  });

  test("a click that solves a reCAPTCHA widget reports it solved", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-solve` });
    expect(await ok("click", { tab, target: "#solve" })).toMatch(
      /^Challenge solved: the reCAPTCHA check on this page/m,
    );
  });

  test("a click on a widget's checkbox that solves it a moment later reports it solved", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-checkbox` });
    const target = refOf(await ok("snapshot", { tab }), "not a robot");
    expect(await ok("click", { tab, target })).toMatch(
      /^Challenge solved: the reCAPTCHA check on this page/m,
    );
  });

  test("an action after a solve reports only the action, not the solved widget again", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/recaptcha-solve` });
    await ok("click", { tab, target: "#solve" });
    expect(await ok("click", { tab, target: "[name=user]" })).toMatch(
      /^Clicked textbox \((?:f\d+)?e\d+, from \[name=user\]\)\.\nNo change detected on the page\.$/,
    );
  });

  test("a Cloudflare interstitial asking for an action is reported at once", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare` })).toMatch(
      /^Challenge: Cloudflare check on this page \(title "Just a moment\.\.\.", HTTP 403\)\./m,
    );
  });

  test("a Cloudflare interstitial that clears by itself is reported cleared", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare-wait` }),
    ).toMatch(
      /^Challenge cleared: the Cloudflare check \(.+\) passed by itself after \d+ s; the tab is now at \S+\/challenge\/cleared "Shop Home"\.$/m,
    );
  });

  test("a Cloudflare interstitial with a translated title is reported cleared", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare-translated` }),
    ).toMatch(
      /^Challenge cleared: the Cloudflare check \(title "Bir dakika lütfen\.\.\.", HTTP 503\) passed by itself after \d+ s; the tab is now at \S+\/challenge\/cleared "Shop Home"\.$/m,
    );
  });

  test("a cleared Cloudflare interstitial adds no challenge line", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare-wait` }),
    ).not.toMatch(/^Challenge:/m);
  });

  test("a Cloudflare interstitial that does not clear is reported to try and then hand off after waiting", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/cloudflare-stuck` }),
    ).toMatch(
      /^Challenge: Cloudflare check on this page \(.+, still there after 1[5-7] s\)\. Try it yourself first: .*use handoff/m,
    );
  });

  test("a 429 block page says to stop", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/blocked` })).toMatch(
      /^Blocked: the site refused the visit \(HTTP 429, .+\)\. Stop and tell the user/m,
    );
  });

  test("a PerimeterX press and hold page is reported to try and then hand off", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/perimeterx` })).toMatch(
      /^Challenge: PerimeterX check on this page \(element #px-captcha\)\. Try it yourself first: .*use handoff/m,
    );
  });

  test("an older PerimeterX block page answered with HTTP 200 is reported to try and then hand off", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/perimeterx-old` })).toMatch(
      /^Challenge: PerimeterX check on this page \(text "verify you are a human"\)\. Try it yourself first: .*use handoff/m,
    );
  });

  test("a DataDome captcha page is handed off", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/datadome` })).toMatch(
      /^Challenge: DataDome check on this page/m,
    );
  });

  test("an Akamai access denied page says to stop", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/akamai` })).toMatch(
      /^Blocked: the site refused the visit \(Akamai, title "Access Denied"\)\./m,
    );
  });

  test("an Imperva request unsuccessful page says to stop", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/imperva` })).toMatch(
      /^Blocked: the site refused the visit \(Imperva, resource \/_Incapsula_Resource\)\./m,
    );
  });

  test("an AWS WAF captcha page is handed off", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/aws-waf` })).toMatch(
      /^Challenge: AWS WAF check on this page \(element awswaf-captcha\)\./m,
    );
  });

  test("a short page asking to verify being human is handed off", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/verify` })).toMatch(
      /^Challenge: bot check on this page \(text "verify you are a human"\)\./m,
    );
  });

  test("a 403 page without block wording is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/plain-error` }),
    ).not.toMatch(/Challenge:/);
  });

  test("a short article about bot detection is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/bot-article` }),
    ).not.toMatch(/Challenge:/);
  });

  test("a short page titled Please wait is not reported", async () => {
    expect(
      await ok("navigate", { tab, url: `${fixture().url}/challenge/please-wait` }),
    ).not.toMatch(/Challenge:/);
  });

  test("a 403 Forbidden page without other block signals is not reported as blocked", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/forbidden` })).not.toMatch(
      /Blocked:/,
    );
  });

  test("a page without challenge markers adds no challenge line", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/challenge/start` })).not.toMatch(
      /Challenge:/,
    );
  });

  test("a widget that appears after a click is reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/start` });
    expect(await ok("click", { tab, target: "#inject-hcaptcha" })).toMatch(
      /^Challenge: hCaptcha check on this page/m,
    );
  });

  test("a click that navigates onto a challenge page reports it", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/challenge/start` });
    expect(await ok("click", { tab, target: "#to-recaptcha" })).toMatch(
      /^Challenge: reCAPTCHA check on this page/m,
    );
  });

  test("site grant grant answers a notification permission prompt", async () => {
    await ok("navigate", { tab, url: fixture().url });
    await ok("site", { tab, grant: ["notifications"] });
    expect(await ok("evaluate", { tab, expression: "Notification.permission" })).toMatch(
      /granted\s*$/,
    );
  });

  test("site grant grants for one origin accumulate", async () => {
    await ok("site", { tab, grant: ["geolocation"] });
    expect(
      await ok("evaluate", {
        tab,
        expression: "navigator.permissions.query({ name: 'notifications' }).then((s) => s.state)",
      }),
    ).toMatch(/granted\s*$/);
  });

  test("site grant clear removes the grants of the origin", async () => {
    await ok("site", { tab, clear: true });
    expect(
      await ok("evaluate", {
        tab,
        expression: "navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)",
      }),
    ).not.toMatch(/granted\s*$/);
  });

  test("site grant rejects an unknown permission name", async () => {
    expect((await call("site", { tab, grant: ["teleport"] })).isError).toBe(true);
  });

  test("leaving a page with unsaved changes is cancelled and reported", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/unsaved` });
    await ok("click", { tab, target: "#draft" });
    await ok("fill", { tab, target: "#draft", value: "draft text" });
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

  test("tabs close without force keeps a tab with unsaved changes", async () => {
    const draft = openedTab(await ok("navigate", { url: `${fixture().url}/unsaved` }));
    await ok("click", { tab: draft, target: "#draft" });
    const result = await call("tabs", { close: [draft] });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/unsaved changes.*force: true/s);
    await ok("tabs", { close: [draft], force: true });
  });

  test("tabs close with force closes a tab with unsaved changes", async () => {
    const draft = openedTab(await ok("navigate", { url: `${fixture().url}/unsaved` }));
    await ok("click", { tab: draft, target: "#draft" });
    await ok("tabs", { close: [draft], force: true });
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

  async function openedPopup(button: string) {
    await ok("navigate", { tab, url: `${fixture().url}/popups` });
    const opened = await ok("click", { tab, target: button });
    return (
      /opened new tab (t\d+)/.exec(opened)?.[1] ??
      /opened new tab (t\d+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1] ??
      ""
    );
  }

  test("closing an OAuth popup is reported on the opener", async () => {
    const popup = await openedPopup("#open-popup");
    expect(popup).toMatch(/^t\d+$/);
    await ok("click", { tab: popup, target: "#finish" });
    await sleep(200);
    expect(await ok("press", { tab, key: "Shift" })).toMatch(
      new RegExp(
        `tab ${popup} \\(popup\\) closed, with no tool call running on ${tab}; this tab ${tab} is at ${fixture().url.replace(/[.]/g, "\\.")}/popups`,
      ),
    );
  });

  const TAB_CLOSED = /\nThe tab closed\.(?:\n|$)/;

  test("a click whose page closes on the press reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(
      await ok("click", { tab: popup, target: "#close-on-press", modifiers: ["Shift"] }),
    ).toMatch(TAB_CLOSED);
  });

  test("a human click whose page closes on the press reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(await ok("click", { tab: popup, target: "#close-on-press", human: true })).toMatch(
      TAB_CLOSED,
    );
  });

  test("a click at a point whose page closes on the press reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    const [, x, y] =
      /(\d+) (\d+)/.exec(
        await ok("evaluate", {
          tab: popup,
          expression: `(() => { const box = document.querySelector("#close-on-press").getBoundingClientRect(); return Math.round(box.x + box.width / 2) + " " + Math.round(box.y + box.height / 2); })()`,
        }),
      ) ?? [];
    expect(
      await ok("click", { tab: popup, x: Number(x), y: Number(y), modifiers: ["Shift"] }),
    ).toMatch(TAB_CLOSED);
  });

  test("a key press whose page closes on the key down reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(await ok("press", { tab: popup, target: "#close-on-key", key: "a" })).toMatch(
      TAB_CLOSED,
    );
  });

  test("a human key press whose page closes on the key down reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(
      await ok("press", { tab: popup, target: "#close-on-key", key: "a", human: true }),
    ).toMatch(TAB_CLOSED);
  });

  test("a human hover whose page closes on mouse over reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing-hover");
    expect(await ok("hover", { tab: popup, target: "#close-on-hover", human: true })).toMatch(
      TAB_CLOSED,
    );
  });

  test("a fill submitted with Enter that closes the page reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(
      await ok("fill", { tab: popup, target: "#close-on-key", value: "done", submit: true }),
    ).toMatch(TAB_CLOSED);
  });

  test("a human click whose page closes during the mouse travel reports the tab closed before the input", async () => {
    const popup = await openedPopup("#open-closing-soon");
    expect((await call("click", { tab: popup, target: "#far", human: true })).text).toMatch(
      /^The tab closed before the input was sent\./,
    );
  });

  test("a fill on a checkbox whose click closes the page reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(await ok("fill", { tab: popup, target: "#close-on-check", value: "true" })).toMatch(
      TAB_CLOSED,
    );
  });

  test("a slow fill whose typing closes the page reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(
      await ok("fill", { tab: popup, target: "#close-on-input", value: "done", slowly: true }),
    ).toMatch(TAB_CLOSED);
  });

  test("a human fill whose typing closes the page reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    expect(
      await ok("fill", { tab: popup, target: "#close-on-input", value: "done", human: true }),
    ).toMatch(TAB_CLOSED);
  });

  test("a human scroll whose wheel closes the page reports the tab closed", async () => {
    const popup = await openedPopup("#open-closing");
    await ok("hover", { tab: popup, target: "#close-on-wheel" });
    expect(await ok("scroll", { tab: popup, direction: "down", amount: 200, human: true })).toMatch(
      TAB_CLOSED,
    );
  });

  test("a popup opened by a click is not reported as blocked", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/popups` });
    const text = await ok("click", { tab, target: "#open-popup" });
    const popup = /opened new tab (t\d+)/.exec(text)?.[1];
    if (popup) await ok("tabs", { close: [popup] });
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
    expect(await ok("read_page", { tab, max_chars: 200 })).toStartWith(
      `Note: the tab moved to ${fixture().url}/article since your last call.`,
    );
  });

  test("the moved note is given only once", async () => {
    expect(await ok("read_page", { tab, max_chars: 200 })).not.toMatch(/the tab moved to/);
  });

  test("a navigation made by a tool is not noted as a move", async () => {
    await ok("navigate", { tab, url: fixture().url });
    expect(await ok("read_page", { tab, max_chars: 200 })).not.toMatch(/the tab moved to/);
  });

  test("a tab closed outside a tool call is named on the next call", async () => {
    const other = openedTab(await ok("navigate", { url: fixture().url }));
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
    await ok("fill", { tab, target: "#fruit", value: "Banana" });
    expect(await ok("read_page", { tab, target: "#fruit-state" })).toMatch(/Banana/);
  });

  test("fill on a custom combobox lists the options when none matches", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    const result = await call("fill", { tab, target: "#fruit", value: "Mango" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Apple, Banana, Cherry/);
  });

  test("fill on a read-only date input fails with the steps to pick a date", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    const result = await call("fill", { tab, target: "#date", value: "2026-11-21" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Click the control, take a snapshot, then click the option/);
  });

  test("fill keeps line breaks in a contenteditable editor", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/widgets` });
    await ok("fill", { tab, target: "#editor", value: "Line one\nLine two\nLine three" });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "JSON.stringify(document.querySelector('#editor').innerText.split('\\n').filter(Boolean))",
      }),
    ).toMatch(/\["Line one","Line two","Line three"\]/);
  });

  test("fill replaces the content of a contenteditable editor", async () => {
    await ok("fill", { tab, target: "#editor", value: "Fresh" });
    expect(
      await ok("evaluate", {
        tab,
        expression: "JSON.stringify(document.querySelector('#editor').innerText.trim())",
      }),
    ).toMatch(/"Fresh"/);
  });

  test("fill writes into an editor iframe and keeps line breaks", async () => {
    await ok("fill", { tab, target: 'iframe[title="Rich editor"]', value: "Top\nBottom" });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "JSON.stringify(document.querySelector('iframe').contentDocument.body.innerText.split('\\n').filter(Boolean))",
      }),
    ).toMatch(/\["Top","Bottom"\]/);
  });

  test("fill slowly keeps line breaks in a contenteditable editor", async () => {
    await ok("fill", { tab, target: "#editor", value: "Slow one\nSlow two", slowly: true });
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
    await ok("fill", { tab, target: "#note", value: MIXED_TEXT });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#note').value" }),
    ).toContain(MIXED_TEXT);
  });

  test("fill slowly stores Turkish, emoji and RTL text exactly", async () => {
    await ok("fill", { tab, target: "#body", value: MIXED_TEXT, slowly: true });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#body').value" }),
    ).toContain(MIXED_TEXT);
  });

  test("fill reports no mismatch for mixed-script text", async () => {
    expect(await ok("fill", { tab, target: "#note", value: MIXED_TEXT })).not.toMatch(
      /reformatted or rejected/,
    );
  });

  test("read_page returns mixed-script text unchanged", async () => {
    expect(await ok("read_page", { tab, target: "#sample" })).toContain(MIXED_TEXT);
  });

  test("snapshot keeps mixed-script text", async () => {
    expect(await ok("snapshot", { tab })).toContain(MIXED_TEXT);
  });

  test("find matches Turkish text regardless of dotted capital I", async () => {
    expect(await ok("snapshot", { tab, query: "çağrı istanbul" })).toMatch(/Çağrı İstanbul/);
  });

  test("find matches an emoji ZWJ sequence", async () => {
    expect(await ok("snapshot", { tab, query: "👩🏽‍💻" })).toMatch(/^\d+ matches/m);
  });

  test("find matches RTL text", async () => {
    expect(await ok("snapshot", { tab, query: "שלום עולם" })).toMatch(/^\d+ matches/m);
  });

  test("find matches an accessible name with an emoji", async () => {
    expect(await ok("snapshot", { tab, query: "gönder 👍" })).toMatch(/button "Gönder 👍"/);
  });

  test("navigate to a file download reports the saved file", async () => {
    await ok("navigate", { tab, url: fixture().url });
    const text = await ok("navigate", { tab, url: `${fixture().url}/download` });
    const file = /^Downloaded .* to (.+)$/m.exec(text)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toBe("a,b\n1,2\n");
  });

  test("navigate to a file download names the saved file once", async () => {
    const text = await ok("navigate", { tab, url: `${fixture().url}/download` });
    const file = /^Downloaded .* to (.+)$/m.exec(text)?.[1] ?? "";
    expect(text.split(file).length - 1).toBe(1);
  });

  test("navigate to a download says the tab stayed on its page", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/download` })).toMatch(
      new RegExp(`tab stays at ${fixture().url.replace(/[.]/g, "\\.")}/ `),
    );
  });

  test("navigate on a file download reports the saved file", async () => {
    const text = await ok("navigate", { url: `${fixture().url}/download` });
    await ok("tabs", { close: [openedTab(text)] });
    expect(text).toMatch(/^Downloaded .* to .+report( \(\d+\))?\.csv$/m);
  });
});
