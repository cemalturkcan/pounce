import { expect, test } from "bun:test";
import {
  classifyChallenge,
  hasReturnParam,
  isSignInUrl,
  type PageProbe,
  sameSite,
  sessionMayHaveExpired,
} from "./checks.ts";

const blank: PageProbe = {
  title: "Shop",
  text: "",
  frames: [],
  cloudflareMarker: false,
  hasPassword: false,
  headings: [],
};
const withFrame = (src: string, title = "", visible = true): PageProbe => ({
  ...blank,
  frames: [{ src, title, visible }],
});
const noForm = { hasPassword: false, headings: [], title: "Account" };

test("a visible reCAPTCHA anchor frame is a reCAPTCHA challenge", () => {
  expect(
    classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/anchor?k=x&size=normal"))
      ?.kind,
  ).toBe("reCAPTCHA");
});

test("an invisible reCAPTCHA frame is not a challenge", () => {
  expect(
    classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible")),
  ).toBe(undefined);
});

test("a hidden reCAPTCHA challenge frame is not a challenge", () => {
  expect(
    classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/bframe?k=x", "", false)),
  ).toBe(undefined);
});

test("an hCaptcha frame is recognised by its title", () => {
  expect(
    classifyChallenge(
      withFrame(
        "https://example.com/frame",
        "Widget containing checkbox for hCaptcha security challenge",
      ),
    )?.kind,
  ).toBe("hCaptcha");
});

test("a Turnstile frame is recognised by its host", () => {
  expect(
    classifyChallenge(
      withFrame(
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2",
      ),
    )?.kind,
  ).toBe("Cloudflare Turnstile");
});

test("a Cloudflare challenge form is an interstitial", () => {
  expect(classifyChallenge({ ...blank, cloudflareMarker: true })?.kind).toBe(
    "Cloudflare interstitial",
  );
});

test("a Just a moment title is an interstitial", () => {
  expect(classifyChallenge({ ...blank, title: "Just a moment..." })?.kind).toBe(
    "Cloudflare interstitial",
  );
});

test("a 403 asking to verify being human is an interstitial", () => {
  expect(
    classifyChallenge(
      { ...blank, text: "Verify you are human by completing the action below." },
      403,
    )?.kind,
  ).toBe("Cloudflare interstitial");
});

test("a 429 document is a block page", () => {
  expect(classifyChallenge(blank, 429)?.kind).toBe("block page");
});

test("a 403 saying access denied is a block page", () => {
  expect(classifyChallenge({ ...blank, title: "Access Denied" }, 403)?.kind).toBe("block page");
});

test("a 403 without block wording is not a challenge", () => {
  expect(
    classifyChallenge({ ...blank, text: "Your plan does not include this report." }, 403),
  ).toBe(undefined);
});

test("block wording on a 200 page is not a challenge", () => {
  expect(classifyChallenge({ ...blank, text: "Your card was blocked; call the bank." }, 200)).toBe(
    undefined,
  );
});

test("sign-in paths are recognised by whole segments", () => {
  for (const url of [
    "https://a.test/login",
    "https://a.test/account/signin.php",
    "https://a.test/tr/giriş",
    "https://a.test/oturum-ac",
    "https://a.test/u/LOGIN",
    "https://a.test/auth?x=1",
  ]) {
    expect(isSignInUrl(url)).toBe(true);
  }
});

test("paths that only contain sign-in words are not sign-in paths", () => {
  for (const url of [
    "https://a.test/auth-a/",
    "https://a.test/oauth2/authorize",
    "https://a.test/blog/login-tips",
    "https://a.test/catalog",
  ]) {
    expect(isSignInUrl(url)).toBe(false);
  }
});

test("return-to parameters are recognised", () => {
  expect(hasReturnParam("https://a.test/login?next=%2Fapp")).toBe(true);
  expect(hasReturnParam("https://a.test/login?lang=tr")).toBe(false);
});

test("subdomains of one registrable domain are the same site", () => {
  expect(sameSite("https://www.example.com/a", "https://accounts.example.com/b")).toBe(true);
});

test("two domains under a public second-level suffix are different sites", () => {
  expect(sameSite("https://shop.co.uk/a", "https://other.co.uk/b")).toBe(false);
});

test("a subdomain under com.tr is the same site as its parent", () => {
  expect(sameSite("https://www.example.com.tr/a", "https://example.com.tr/b")).toBe(true);
});

test("navigate redirected to a sign-in page may mean an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      requestedUrl: "https://a.test/app/orders",
      finalUrl: "https://a.test/login?next=/app/orders",
      page: noForm,
    }),
  ).toBe(true);
});

test("navigate to a sign-in page on purpose is not an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      requestedUrl: "https://a.test/login",
      finalUrl: "https://a.test/login",
      page: noForm,
    }),
  ).toBe(false);
});

test("arriving from another site is not an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://b.test/home",
      requestedUrl: "https://a.test/app",
      finalUrl: "https://a.test/login",
      page: noForm,
    }),
  ).toBe(false);
});

test("leaving a sign-in page for another is not an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/login",
      requestedUrl: "https://a.test/app",
      finalUrl: "https://a.test/login?next=/app",
      page: noForm,
    }),
  ).toBe(false);
});

test("an inline password form with a sign-in heading may mean an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      requestedUrl: "https://a.test/app/report",
      finalUrl: "https://a.test/app/report",
      page: { hasPassword: true, headings: ["Oturum aç"], title: "Report" },
    }),
  ).toBe(true);
});

test("a password field without a sign-in heading is not a sign-in page", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      requestedUrl: "https://a.test/app/settings",
      finalUrl: "https://a.test/app/settings",
      page: { hasPassword: true, headings: ["Change password"], title: "Settings" },
    }),
  ).toBe(false);
});

test("an action landing on a plain sign-in link is not an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      finalUrl: "https://a.test/login",
      page: noForm,
    }),
  ).toBe(false);
});

test("an action landing on a sign-in page with a return parameter may mean an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      finalUrl: "https://a.test/login?returnUrl=%2Fapp",
      page: noForm,
    }),
  ).toBe(true);
});

test("an action redirected to a sign-in page may mean an expired session", () => {
  expect(
    sessionMayHaveExpired({
      previousUrl: "https://a.test/app",
      finalUrl: "https://a.test/signin",
      redirected: true,
      page: noForm,
    }),
  ).toBe(true);
});
