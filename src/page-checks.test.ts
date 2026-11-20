import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChallenge, hasReturnParam, isSignInUrl, type PageProbe, sameSite, sessionMayHaveExpired } from "./page-checks.ts";

const blank: PageProbe = { title: "Shop", text: "", frames: [], cloudflareMarker: false, hasPassword: false, headings: [] };
const withFrame = (src: string, title = "", visible = true): PageProbe => ({ ...blank, frames: [{ src, title, visible }] });
const noForm = { hasPassword: false, headings: [], title: "Account" };

test("a visible reCAPTCHA anchor frame is a reCAPTCHA challenge", () => {
  assert.equal(classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"))?.kind, "reCAPTCHA");
});

test("an invisible reCAPTCHA frame is not a challenge", () => {
  assert.equal(classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible")), undefined);
});

test("a hidden reCAPTCHA challenge frame is not a challenge", () => {
  assert.equal(classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/bframe?k=x", "", false)), undefined);
});

test("an hCaptcha frame is recognised by its title", () => {
  assert.equal(classifyChallenge(withFrame("https://example.com/frame", "Widget containing checkbox for hCaptcha security challenge"))?.kind, "hCaptcha");
});

test("a Turnstile frame is recognised by its host", () => {
  assert.equal(classifyChallenge(withFrame("https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2"))?.kind, "Cloudflare Turnstile");
});

test("a Cloudflare challenge form is an interstitial", () => {
  assert.equal(classifyChallenge({ ...blank, cloudflareMarker: true })?.kind, "Cloudflare interstitial");
});

test("a Just a moment title is an interstitial", () => {
  assert.equal(classifyChallenge({ ...blank, title: "Just a moment..." })?.kind, "Cloudflare interstitial");
});

test("a 403 asking to verify being human is an interstitial", () => {
  assert.equal(classifyChallenge({ ...blank, text: "Verify you are human by completing the action below." }, 403)?.kind, "Cloudflare interstitial");
});

test("a 429 document is a block page", () => {
  assert.equal(classifyChallenge(blank, 429)?.kind, "block page");
});

test("a 403 saying access denied is a block page", () => {
  assert.equal(classifyChallenge({ ...blank, title: "Access Denied" }, 403)?.kind, "block page");
});

test("a 403 without block wording is not a challenge", () => {
  assert.equal(classifyChallenge({ ...blank, text: "Your plan does not include this report." }, 403), undefined);
});

test("block wording on a 200 page is not a challenge", () => {
  assert.equal(classifyChallenge({ ...blank, text: "Your card was blocked; call the bank." }, 200), undefined);
});

test("sign-in paths are recognised by whole segments", () => {
  for (const url of ["https://a.test/login", "https://a.test/account/signin.php", "https://a.test/tr/giriş", "https://a.test/oturum-ac", "https://a.test/u/LOGIN", "https://a.test/auth?x=1"]) {
    assert.equal(isSignInUrl(url), true, url);
  }
});

test("paths that only contain sign-in words are not sign-in paths", () => {
  for (const url of ["https://a.test/auth-a/", "https://a.test/oauth2/authorize", "https://a.test/blog/login-tips", "https://a.test/catalog"]) {
    assert.equal(isSignInUrl(url), false, url);
  }
});

test("return-to parameters are recognised", () => {
  assert.equal(hasReturnParam("https://a.test/login?next=%2Fapp"), true);
  assert.equal(hasReturnParam("https://a.test/login?lang=tr"), false);
});

test("subdomains of one registrable domain are the same site", () => {
  assert.equal(sameSite("https://www.example.com/a", "https://accounts.example.com/b"), true);
});

test("two domains under a public second-level suffix are different sites", () => {
  assert.equal(sameSite("https://shop.co.uk/a", "https://other.co.uk/b"), false);
});

test("a subdomain under com.tr is the same site as its parent", () => {
  assert.equal(sameSite("https://www.example.com.tr/a", "https://example.com.tr/b"), true);
});

test("navigate redirected to a sign-in page may mean an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", requestedUrl: "https://a.test/app/orders", finalUrl: "https://a.test/login?next=/app/orders", page: noForm }), true);
});

test("navigate to a sign-in page on purpose is not an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", requestedUrl: "https://a.test/login", finalUrl: "https://a.test/login", page: noForm }), false);
});

test("arriving from another site is not an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://b.test/home", requestedUrl: "https://a.test/app", finalUrl: "https://a.test/login", page: noForm }), false);
});

test("leaving a sign-in page for another is not an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/login", requestedUrl: "https://a.test/app", finalUrl: "https://a.test/login?next=/app", page: noForm }), false);
});

test("an inline password form with a sign-in heading may mean an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", requestedUrl: "https://a.test/app/report", finalUrl: "https://a.test/app/report", page: { hasPassword: true, headings: ["Oturum aç"], title: "Report" } }), true);
});

test("a password field without a sign-in heading is not a sign-in page", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", requestedUrl: "https://a.test/app/settings", finalUrl: "https://a.test/app/settings", page: { hasPassword: true, headings: ["Change password"], title: "Settings" } }), false);
});

test("an action landing on a plain sign-in link is not an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", finalUrl: "https://a.test/login", page: noForm }), false);
});

test("an action landing on a sign-in page with a return parameter may mean an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", finalUrl: "https://a.test/login?returnUrl=%2Fapp", page: noForm }), true);
});

test("an action redirected to a sign-in page may mean an expired session", () => {
  assert.equal(sessionMayHaveExpired({ previousUrl: "https://a.test/app", finalUrl: "https://a.test/signin", redirected: true, page: noForm }), true);
});
