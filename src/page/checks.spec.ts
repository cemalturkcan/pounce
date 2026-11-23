import { expect, test } from "bun:test";
import {
  type Challenge,
  challengeLine,
  classifyChallenge,
  hasReturnParam,
  isSignInUrl,
  mergeWidgetFrames,
  type PageProbe,
  sameSite,
  sessionMayHaveExpired,
  widgetPending,
} from "./checks.ts";

const blank: PageProbe = {
  url: "https://shop.example/",
  title: "Shop",
  text: "",
  textLength: 0,
  frames: [],
  scripts: [],
  markers: [],
  visibleMarkers: [],
  shownWidgetContainers: [],
  hasPassword: false,
  headings: [],
};
const page = (title: string, text: string, extra: Partial<PageProbe> = {}): PageProbe => ({
  ...blank,
  title,
  text,
  textLength: text.length,
  ...extra,
});
const withFrame = (src: string, title = "", visible = true): PageProbe => ({
  ...blank,
  frames: [{ src, title, visible }],
});
const kindOf = (probed: PageProbe, status?: number) => classifyChallenge(probed, status)?.kind;
const providerOf = (probed: PageProbe, status?: number) =>
  classifyChallenge(probed, status)?.provider;
const longText = (lead: string) => `${lead} ${"lorem ipsum ".repeat(200)}`;
const noForm = { hasPassword: false, headings: [], title: "Account" };

test("a visible reCAPTCHA anchor frame is an interactive reCAPTCHA check", () => {
  expect(
    classifyChallenge(withFrame("https://www.google.com/recaptcha/api2/anchor?k=x&size=normal")),
  ).toMatchObject({ provider: "reCAPTCHA", kind: "interactive" });
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

const RECAPTCHA_ANCHOR = "https://www.google.com/recaptcha/api2/anchor?k=x&size=normal";
const TURNSTILE_WIDGET =
  "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2";
const solvedFrame = (src: string) => ({ src, title: "", visible: true, solved: true });

test("a solved reCAPTCHA widget is reported as solved", () => {
  expect(kindOf({ ...blank, frames: [solvedFrame(RECAPTCHA_ANCHOR)] })).toBe("solved");
});

test("a solved Turnstile widget is reported as solved", () => {
  expect(kindOf({ ...blank, frames: [solvedFrame(TURNSTILE_WIDGET)] })).toBe("solved");
});

test("an unsolved widget beside a solved one is still a check", () => {
  expect(
    classifyChallenge({
      ...blank,
      frames: [solvedFrame(RECAPTCHA_ANCHOR), { src: TURNSTILE_WIDGET, title: "", visible: true }],
    }),
  ).toMatchObject({ provider: "Cloudflare Turnstile", kind: "interactive" });
});

const RECAPTCHA_CONTAINER = ".g-recaptcha:not([data-size=invisible])";

test("a shown widget container without its frame yet is pending", () => {
  expect(
    widgetPending({
      ...blank,
      markers: [RECAPTCHA_CONTAINER],
      shownWidgetContainers: [RECAPTCHA_CONTAINER],
    }),
  ).toBe(true);
});

test("a widget container its page hides is not pending", () => {
  expect(widgetPending({ ...blank, markers: [RECAPTCHA_CONTAINER] })).toBe(false);
});

test("a widget container whose frame attached is not pending", () => {
  expect(
    widgetPending({
      ...blank,
      markers: [RECAPTCHA_CONTAINER],
      shownWidgetContainers: [RECAPTCHA_CONTAINER],
      frames: [{ src: RECAPTCHA_ANCHOR, title: "", visible: true, inShownContainer: true }],
    }),
  ).toBe(false);
});

test("a shown widget container whose widget frame inside it is still hidden is pending", () => {
  expect(
    widgetPending({
      ...blank,
      markers: [".cf-turnstile"],
      shownWidgetContainers: [".cf-turnstile"],
      frames: [{ src: TURNSTILE_WIDGET, title: "", visible: false, inShownContainer: true }],
    }),
  ).toBe(true);
});

test("a hidden widget frame outside every shown widget container is not pending", () => {
  expect(
    widgetPending({
      ...blank,
      markers: [RECAPTCHA_CONTAINER],
      shownWidgetContainers: [RECAPTCHA_CONTAINER],
      frames: [{ src: RECAPTCHA_ANCHOR, title: "", visible: false }],
    }),
  ).toBe(false);
});

test("a widget iframe in the page that the frame tree has not loaded yet still counts", () => {
  const pending = { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA", visible: true };
  expect(mergeWidgetFrames([pending], [], blank.url)).toEqual([pending]);
});

test("a widget the frame tree described replaces its iframe entry from the page", () => {
  const fromPage = { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA", visible: true };
  const fromTree = { ...fromPage, solved: true };
  expect(mergeWidgetFrames([fromPage], [fromTree], blank.url)).toEqual([fromTree]);
});

test("a widget iframe with a relative src is replaced by the frame the tree described", () => {
  const fromPage = { src: "/recaptcha/api2/anchor?k=x&size=normal", title: "", visible: true };
  const fromTree = {
    ...fromPage,
    src: "https://shop.example/recaptcha/api2/anchor?k=x&size=normal",
  };
  expect(mergeWidgetFrames([fromPage], [fromTree], blank.url)).toEqual([fromTree]);
});

test("the page's widget iframes stay when describing the frame tree ran out of time", () => {
  const fromPage = { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA", visible: true };
  expect(mergeWidgetFrames([fromPage], undefined, blank.url)).toEqual([fromPage]);
});

test("frames that are not widgets stay next to the widgets the frame tree described", () => {
  const video = { src: "https://video.example/embed", title: "Video", visible: true };
  const widget = { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA", visible: true, solved: false };
  expect(mergeWidgetFrames([video], [widget], blank.url)).toEqual([video, widget]);
});

test("a widget iframe still loading stays next to another widget the frame tree described", () => {
  const loaded = { src: RECAPTCHA_ANCHOR, title: "reCAPTCHA", visible: true, solved: false };
  const loading = { src: TURNSTILE_WIDGET, title: "Turnstile", visible: true };
  expect(
    mergeWidgetFrames([{ ...loaded, solved: undefined }, loading], [loaded], blank.url),
  ).toEqual([loading, loaded]);
});

test("a page without a widget container is not pending", () => {
  expect(widgetPending(blank)).toBe(false);
});

test("an hCaptcha frame is recognised by its title", () => {
  expect(
    providerOf(
      withFrame(
        "https://example.com/frame",
        "Widget containing checkbox for hCaptcha security challenge",
      ),
    ),
  ).toBe("hCaptcha");
});

test("a Turnstile frame is recognised by its host", () => {
  expect(
    providerOf(
      withFrame(
        "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2",
      ),
    ),
  ).toBe("Cloudflare Turnstile");
});

test("a Just a moment title answered with HTTP 503 is a Cloudflare check that clears by itself", () => {
  expect(classifyChallenge(page("Just a moment...", "Checking your browser"), 503)).toMatchObject({
    provider: "Cloudflare",
    kind: "self-clearing",
  });
});

test("a Just a moment title answered with HTTP 403 is a Cloudflare check", () => {
  expect(providerOf(page("Just a moment...", ""), 403)).toBe("Cloudflare");
});

test("a Just a moment title loading the Cloudflare challenge script is a Cloudflare check", () => {
  expect(
    providerOf(
      page("Just a moment...", "", {
        scripts: ["/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"],
      }),
    ),
  ).toBe("Cloudflare");
});

const CHALLENGE_SCRIPT = "/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1";
const translated = (title: string, extra: Partial<PageProbe> = {}) =>
  page(title, "", { scripts: [CHALLENGE_SCRIPT], ...extra });

test.each([
  ["Turkish", "Bir dakika lütfen..."],
  ["Spanish", "Un momento…"],
  ["German", "Einen Moment bitte..."],
])(
  "a %s titled 403 loading the Cloudflare challenge script is a Cloudflare check",
  (_language, title) => {
    expect(providerOf(translated(title), 403)).toBe("Cloudflare");
  },
);

test("a translated title answered with HTTP 503 and the Cloudflare challenge script clears by itself", () => {
  expect(kindOf(translated("Bir dakika lütfen..."), 503)).toBe("self-clearing");
});

test("a translated title answered with HTTP 403 and a visible Turnstile widget is interactive", () => {
  expect(
    classifyChallenge(
      page("Bir dakika lütfen...", "", {
        markers: [".cf-turnstile"],
        visibleMarkers: [".cf-turnstile"],
      }),
      403,
    ),
  ).toMatchObject({ provider: "Cloudflare", kind: "interactive" });
});

test("a translated title loading the Cloudflare challenge script with HTTP 200 is not a challenge", () => {
  expect(classifyChallenge(translated("Bir dakika lütfen..."), 200)).toBe(undefined);
});

test("a translated title answered with HTTP 403 without Cloudflare signals is not a challenge", () => {
  expect(classifyChallenge(page("Bir dakika lütfen...", ""), 403)).toBe(undefined);
});

test("a short page titled Please wait answered with HTTP 200 is not a challenge", () => {
  expect(classifyChallenge(page("Please wait", "Loading your dashboard"), 200)).toBe(undefined);
});

test("a short page titled Please wait without a status is not a challenge", () => {
  expect(classifyChallenge(page("Please wait", "Loading your dashboard"))).toBe(undefined);
});

test("a Cloudflare challenge form without a widget clears by itself", () => {
  expect(kindOf({ ...blank, markers: ["#challenge-form"] })).toBe("self-clearing");
});

test("a Cloudflare interstitial asking to complete an action is interactive", () => {
  expect(
    kindOf(
      page("Just a moment...", "Verify you are human by completing the action below.", {
        markers: ["#challenge-form"],
      }),
    ),
  ).toBe("interactive");
});

test("a Cloudflare interstitial with a visible Turnstile widget is interactive", () => {
  expect(
    kindOf(
      page("Just a moment...", "", {
        markers: [".cf-turnstile"],
        visibleMarkers: [".cf-turnstile"],
      }),
    ),
  ).toBe("interactive");
});

test("a 403 asking to verify being human is an interactive Cloudflare check", () => {
  expect(
    classifyChallenge(page("Shop", "Verify you are human by completing the action below."), 403),
  ).toMatchObject({ provider: "Cloudflare", kind: "interactive" });
});

test("a Cloudflare you have been blocked page is a block", () => {
  expect(
    classifyChallenge(
      page("Attention Required! | Cloudflare", "Sorry, you have been blocked. Cloudflare Ray ID", {
        markers: ["#cf-error-details"],
      }),
    ),
  ).toMatchObject({ provider: "Cloudflare", kind: "block" });
});

test("a PerimeterX captcha element is an interactive check", () => {
  expect(classifyChallenge({ ...blank, markers: ["#px-captcha"] })).toMatchObject({
    provider: "PerimeterX",
    kind: "interactive",
  });
});

test("a short press and hold page is a PerimeterX check", () => {
  expect(providerOf(page("Access to this page has been denied", "Press & Hold to confirm"))).toBe(
    "PerimeterX",
  );
});

const PERIMETERX_BLOCK_TEXT =
  "Please verify you are a human\nAccess to this page has been denied because we believe you are using automation tools to browse the website.\nThis may happen as a result of the following:\nJavascript is disabled or blocked by an extension (ad blockers for example)\nYour browser does not support cookies\nPlease make sure that Javascript and cookies are enabled on your browser and that you are not blocking them from loading.\nReference ID: #1a2b3c4d";
const perimeterXBlock = page("Access to this page has been denied.", PERIMETERX_BLOCK_TEXT, {
  scripts: ["/PXabc123/init.js"],
  markers: ["#px-captcha", "[id^='px-captcha']"],
  headings: ["Please verify you are a human"],
});

test("an older PerimeterX block page answered with HTTP 200 is an interactive PerimeterX check", () => {
  expect(classifyChallenge(perimeterXBlock, 200)).toMatchObject({
    provider: "PerimeterX",
    kind: "interactive",
  });
});

test("an older PerimeterX block page answered with HTTP 403 shows its captcha, so it is an interactive PerimeterX check rather than a block", () => {
  expect(classifyChallenge(perimeterXBlock, 403)).toMatchObject({
    provider: "PerimeterX",
    kind: "interactive",
  });
});

test("an older PerimeterX block page without a status is an interactive PerimeterX check", () => {
  expect(classifyChallenge(perimeterXBlock)).toMatchObject({
    provider: "PerimeterX",
    kind: "interactive",
  });
});

test("a short contact page asking to verify being human on a PerimeterX site is not a challenge", () => {
  expect(
    classifyChallenge(
      page(
        "Contact",
        `${"Write to our support team about your order. ".repeat(10)}Please verify you are a human before sending.`,
        { scripts: ["/PXabc123/init.js"] },
      ),
    ),
  ).toBe(undefined);
});

test("an article mentioning press and hold is not a challenge", () => {
  expect(classifyChallenge(page("Guide", longText("Press and hold the power button")))).toBe(
    undefined,
  );
});

test("a DataDome captcha container is an interactive check", () => {
  expect(classifyChallenge({ ...blank, markers: ["#ddv1-captcha-container"] })).toMatchObject({
    provider: "DataDome",
    kind: "interactive",
  });
});

test("a DataDome interstitial frame clears by itself", () => {
  expect(
    classifyChallenge(withFrame("https://geo.captcha-delivery.com/interstitial/?initialCid=x")),
  ).toMatchObject({ provider: "DataDome", kind: "self-clearing" });
});

test("an Akamai sensor container without a visible prompt clears by itself", () => {
  expect(classifyChallenge({ ...blank, markers: ["#sec-if-cpt-container"] })).toMatchObject({
    provider: "Akamai",
    kind: "self-clearing",
  });
});

test("an Akamai visible prompt asking to verify is interactive", () => {
  expect(
    kindOf(
      page("Shop", "Please verify you are a human", {
        markers: ["#sec-if-cpt-container", "#sec-cpt-if"],
        visibleMarkers: ["#sec-cpt-if"],
      }),
    ),
  ).toBe("interactive");
});

test("an Akamai access denied page with a reference number is a block", () => {
  expect(
    classifyChallenge(
      page(
        "Access Denied",
        `You don't have permission to access "http://shop.example/" on this server. Reference #18.6b2d1402.1700000000.1a2b3c`,
      ),
    ),
  ).toMatchObject({ provider: "Akamai", kind: "block" });
});

test("an Imperva resource script on an empty page clears by itself", () => {
  expect(
    classifyChallenge({
      ...blank,
      scripts: ["https://shop.example/_Incapsula_Resource?SWJIYLWA=x"],
    }),
  ).toMatchObject({ provider: "Imperva", kind: "self-clearing" });
});

test("an Imperva resource frame with a captcha prompt is interactive", () => {
  expect(
    kindOf(
      page("Shop", "Please complete the captcha to continue", {
        frames: [{ src: "/_Incapsula_Resource?CWUDNSAI=x", title: "", visible: true }],
      }),
    ),
  ).toBe("interactive");
});

test("an Imperva request unsuccessful page is a block", () => {
  expect(
    classifyChallenge(
      page("Shop", "Request unsuccessful. Incapsula incident ID: 123-456", {
        frames: [{ src: "/_Incapsula_Resource?CWUDNSAI=x", title: "", visible: true }],
      }),
    ),
  ).toMatchObject({ provider: "Imperva", kind: "block" });
});

test("a long page loading the Imperva resource script is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        scripts: ["/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"],
      }),
    ),
  ).toBe(undefined);
});

test("a long page loading the Imperva script and mentioning a captcha is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Support", longText("Why do I see a captcha when I sign in?"), {
        scripts: ["/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"],
      }),
    ),
  ).toBe(undefined);
});

test("a long page with a hidden Imperva resource frame is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        frames: [{ src: "/_Incapsula_Resource?SWKMTFSR=1&e=0.1", title: "", visible: false }],
      }),
    ),
  ).toBe(undefined);
});

test("an Imperva main frame interstitial with no text clears by itself", () => {
  expect(
    classifyChallenge(
      page("", "", {
        frames: [{ src: "/_Incapsula_Resource?SWUDNSAI=31&xinfo=1-2-0", title: "", visible: true }],
      }),
    ),
  ).toMatchObject({ provider: "Imperva", kind: "self-clearing" });
});

const shortPages: [string, PageProbe][] = [
  [
    "a sign-in form",
    page("Sign in", "Sign in to your account\nEmail\nPassword\nForgot password?\nSign in", {
      hasPassword: true,
      headings: ["Sign in to your account"],
    }),
  ],
  [
    "a 404 page",
    page("Page not found", "Page not found\nThe page you asked for is not here.\nGo home", {
      headings: ["Page not found"],
    }),
  ],
  ["an SPA shell", page("Shop", "", { scripts: ["/assets/index-4f2a9c.js"] })],
];
const providerTags: [string, Partial<PageProbe>][] = [
  ["Cloudflare", { scripts: ["/cdn-cgi/challenge-platform/scripts/jsd/main.js"] }],
  [
    "PerimeterX",
    { scripts: ["/PXabc123/init.js"], markers: ["#px-captcha", "[id^='px-captcha']"] },
  ],
  [
    "DataDome",
    {
      scripts: ["https://js.datadome.co/tags.js"],
      frames: [
        {
          src: "https://geo.captcha-delivery.com/captcha/?initialCid=x",
          title: "",
          visible: false,
        },
      ],
    },
  ],
  ["Akamai", { scripts: ["/akam/13/7f3a2b1c"] }],
  ["Imperva", { scripts: ["/_Incapsula_Resource?SWJIYLWA=719d34d31c8e3a6e6fffd425f7e032f3"] }],
  ["AWS WAF", { scripts: ["https://abc.token.awswaf.com/abc/challenge.js"] }],
];

test.each(
  shortPages.flatMap(([pageName, probed]) =>
    providerTags.map(([provider, tag]): [string, string, PageProbe] => [
      pageName,
      provider,
      {
        ...probed,
        ...tag,
        scripts: [...probed.scripts, ...(tag.scripts ?? [])],
      },
    ]),
  ),
)("%s carrying the %s tag is not a challenge", (_pageName, _provider, probed) => {
  expect(classifyChallenge(probed)).toBe(undefined);
});

test("a long page with a hidden PerimeterX captcha placeholder is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        scripts: ["/PXabc123/init.js"],
        markers: ["#px-captcha", "[id^='px-captcha']"],
      }),
    ),
  ).toBe(undefined);
});

test("a visible PerimeterX press and hold modal over a long page is interactive", () => {
  expect(
    kindOf(
      page("Shop", longText("Welcome to our shop"), {
        markers: ["#px-captcha", "[id^='px-captcha']"],
        visibleMarkers: ["#px-captcha", "[id^='px-captcha']"],
      }),
    ),
  ).toBe("interactive");
});

test("a long page loading the DataDome tag with a hidden frame is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        scripts: ["https://js.datadome.co/tags.js"],
        frames: [
          {
            src: "https://geo.captcha-delivery.com/captcha/?initialCid=x",
            title: "",
            visible: false,
          },
        ],
      }),
    ),
  ).toBe(undefined);
});

test("a visible DataDome captcha frame over a long page is interactive", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        frames: [
          {
            src: "https://geo.captcha-delivery.com/captcha/?initialCid=x",
            title: "",
            visible: true,
          },
        ],
      }),
    ),
  ).toMatchObject({ provider: "DataDome", kind: "interactive" });
});

test("a long page with a hidden DataDome captcha container is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), { markers: ["#ddv1-captcha-container"] }),
    ),
  ).toBe(undefined);
});

test("a long page with hidden Akamai sensor containers is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome to our shop"), {
        scripts: ["/akam/13/7a2b3c4d"],
        markers: ["#sec-if-cpt-container"],
      }),
    ),
  ).toBe(undefined);
});

test("a long page whose own form uses a challenge-form id is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Weekly coding challenge", longText("Submit your solution"), {
        markers: ["#challenge-form"],
      }),
    ),
  ).toBe(undefined);
});

test("a long page titled Please wait is not a challenge", () => {
  expect(classifyChallenge(page("Please wait for the sale", longText("Big sale soon")))).toBe(
    undefined,
  );
});

test("a long page loading the AWS WAF script with a challenge-container element is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome"), {
        scripts: ["https://abc.token.awswaf.com/abc/challenge.js"],
        markers: ["#challenge-container"],
      }),
    ),
  ).toBe(undefined);
});

test("an AWS WAF captcha element is an interactive check", () => {
  expect(classifyChallenge({ ...blank, markers: ["awswaf-captcha"] })).toMatchObject({
    provider: "AWS WAF",
    kind: "interactive",
  });
});

test("an AWS WAF challenge script on an empty page clears by itself", () => {
  expect(
    classifyChallenge({
      ...blank,
      scripts: ["https://abc.token.awswaf.com/abc/challenge.js"],
      markers: ["#challenge-container"],
    }),
  ).toMatchObject({ provider: "AWS WAF", kind: "self-clearing" });
});

test("an AWS WAF script on a full page is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Shop", longText("Welcome"), {
        scripts: ["https://abc.token.awswaf.com/abc/challenge.js"],
      }),
    ),
  ).toBe(undefined);
});

test("Google's sorry page is an interactive Google check", () => {
  expect(
    classifyChallenge(
      page("https://www.google.com/search", "Our systems have detected unusual traffic", {
        url: "https://www.google.com/sorry/index?continue=x",
      }),
    ),
  ).toMatchObject({ provider: "Google", kind: "interactive" });
});

test("a short access denied page is a block", () => {
  expect(kindOf(page("Access Denied", "You do not have access."))).toBe("block");
});

test("a short page asking to verify being human is an interactive bot check", () => {
  expect(classifyChallenge(page("Check", "Please verify you are a human"))).toMatchObject({
    provider: "bot",
    kind: "interactive",
  });
});

test("a short page titled as a human check is an interactive bot check", () => {
  expect(
    kindOf(page("Pardon Our Interruption", longText("As you were browsing").slice(0, 900))),
  ).toBe("interactive");
});

test("a short article about bot detection is not a challenge", () => {
  expect(
    classifyChallenge(
      page("Bot detection 101", "Bot detection explained\nHow sites tell bots from people."),
    ),
  ).toBe(undefined);
});

test("a short page about a bot check is not a challenge", () => {
  expect(classifyChallenge(page("Help", "Why did I see a bot check?"))).toBe(undefined);
});

test("a short form page asking to verify being human beside its content is not a challenge", () => {
  expect(
    classifyChallenge(
      page(
        "Contact",
        `${"Write to our support team about your order. ".repeat(10)}Please verify you are a human before sending.`,
      ),
    ),
  ).toBe(undefined);
});

test("a long article asking to verify being human is not a challenge", () => {
  expect(classifyChallenge(page("News", longText("verify you are human")))).toBe(undefined);
});

test("a short page about a robot check product is not a challenge", () => {
  expect(classifyChallenge(page("Robot check", "Robot checks are our new product"))).toBe(
    undefined,
  );
});

test("a 429 document is a block", () => {
  expect(kindOf(blank, 429)).toBe("block");
});

test("a long 403 saying access denied is a block", () => {
  expect(kindOf(page("Access Denied", longText("Access denied")), 403)).toBe("block");
});

test("a long 403 asking whether you are a robot is interactive", () => {
  expect(kindOf(page("Shop", longText("Are you a robot?")), 403)).toBe("interactive");
});

test("a 403 without block wording is not a challenge", () => {
  expect(classifyChallenge(page("Members", "Your plan does not include this report."), 403)).toBe(
    undefined,
  );
});

test("a 403 titled Forbidden without other block signals is not a challenge", () => {
  expect(
    classifyChallenge(
      page("403 Forbidden", "Forbidden\nYou don't have access to this repository."),
      403,
    ),
  ).toBe(undefined);
});

test("a short page titled Forbidden is not a challenge", () => {
  expect(classifyChallenge(page("Forbidden", "You don't have access to this repository."))).toBe(
    undefined,
  );
});

test("block wording on a long 200 page is not a challenge", () => {
  expect(classifyChallenge(page("Bank", longText("Your card was blocked; call the bank.")))).toBe(
    undefined,
  );
});

const interactive: Challenge = {
  provider: "reCAPTCHA",
  kind: "interactive",
  detail: "widget frame /recaptcha/api2/anchor",
};

test("an interactive challenge line says to try it first and then hand it off", () => {
  expect(challengeLine(interactive)).toBe(
    "Challenge: reCAPTCHA check on this page (widget frame /recaptcha/api2/anchor). Try it yourself first: click its checkbox or follow its prompt with human: true, then wait for it to clear; if it does not clear, use handoff to let the user complete it.",
  );
});

test("a solved widget line says to carry on", () => {
  expect(
    challengeLine({
      provider: "reCAPTCHA",
      kind: "solved",
      detail: "widget frame /recaptcha/api2/anchor",
    }),
  ).toBe(
    "Challenge solved: the reCAPTCHA check on this page (widget frame /recaptcha/api2/anchor) shows as solved; carry on with the page.",
  );
});

test("a challenge still there after waiting says how long it waited", () => {
  expect(
    challengeLine(
      { provider: "Cloudflare", kind: "self-clearing", detail: 'title "Just a moment..."' },
      15_000,
    ),
  ).toBe(
    'Challenge: Cloudflare check on this page (title "Just a moment...", still there after 15 s). Try it yourself first: click its checkbox or follow its prompt with human: true, then wait for it to clear; if it does not clear, use handoff to let the user complete it.',
  );
});

test("a block line says to stop", () => {
  expect(
    challengeLine({ provider: "Akamai", kind: "block", detail: 'title "Access Denied"' }),
  ).toBe(
    'Blocked: the site refused the visit (Akamai, title "Access Denied"). Stop and tell the user; do not retry or reload, which makes the block worse for the user\'s IP and account.',
  );
});

test("a generic block line names no provider", () => {
  expect(challengeLine({ provider: "", kind: "block", detail: "HTTP 429" })).toBe(
    "Blocked: the site refused the visit (HTTP 429). Stop and tell the user; do not retry or reload, which makes the block worse for the user's IP and account.",
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
