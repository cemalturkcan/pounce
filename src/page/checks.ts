import type { Frame, Locator, Page } from "playwright-core";
import { repeatUntil, sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { checkpoint } from "../shared/call-scope.ts";
import type { Point, Tab } from "../browser/tab.ts";
import { registrableDomain } from "./sites.ts";

const PROBE_TIMEOUT_MS = 1500;
const TEXT_SCAN_LIMIT = 20_000;
const SHORT_PAGE_CHARS = 1500;
const NEAR_EMPTY_CHARS = 300;
const CHALLENGE_WAIT_MS = 15_000;
const CHALLENGE_POLL_MS = 1000;
const WIDGET_WAIT_MS = 3000;
const WIDGET_POLL_MS = 100;
const SOLVE_WAIT_MS = 3000;
const SOLVE_POLL_MS = 200;
const WIDGET_CONTAINERS = [
  ".g-recaptcha:not([data-size=invisible])",
  ".h-captcha:not([data-size=invisible])",
  ".cf-turnstile",
];

const MARKERS = [
  "#challenge-form",
  "#challenge-stage",
  "#challenge-running",
  "#cf-challenge-running",
  ".cf-browser-verification",
  "#cf-please-wait",
  ".cf-turnstile",
  "#cf-error-details",
  "#px-captcha",
  "#px-captcha-wrapper",
  "[id^='px-captcha']",
  "#ddv1-captcha-container",
  "#sec-if-cpt-container",
  "#sec-cpt-if",
  "#sec-text-if",
  "awswaf-captcha",
  "#challenge-container",
  ...WIDGET_CONTAINERS.filter((selector) => selector !== ".cf-turnstile"),
];
const CLOUDFLARE_MARKERS = [
  "#challenge-form",
  "#challenge-stage",
  "#challenge-running",
  "#cf-challenge-running",
  ".cf-browser-verification",
  "#cf-please-wait",
];
const PERIMETERX_MARKERS = ["#px-captcha", "#px-captcha-wrapper", "[id^='px-captcha']"];
const AKAMAI_MARKERS = ["#sec-if-cpt-container", "#sec-cpt-if", "#sec-text-if"];

type ProbeFrame = {
  src: string;
  title: string;
  visible: boolean;
  solved?: boolean;
  inShownContainer?: boolean;
};

export type PageProbe = {
  url: string;
  title: string;
  text: string;
  textLength: number;
  frames: ProbeFrame[];
  scripts: string[];
  markers: string[];
  visibleMarkers: string[];
  shownWidgetContainers: string[];
  hasPassword: boolean;
  headings: string[];
};

export type Challenge = {
  provider: string;
  kind: "self-clearing" | "interactive" | "block" | "solved";
  detail: string;
};

type ProbeOptions = { textScanLimit: number; markers: string[]; widgetContainers: string[] };

function probePage({ textScanLimit, markers, widgetContainers }: ProbeOptions): PageProbe {
  const layout = {
    visible(element: Element) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none"
      );
    },
    shown: (element: Element) => element.checkVisibility({ visibilityProperty: true }),
  };
  const containers = widgetContainers.join(", ");
  const body = document.body;
  const fullLength = body ? (body.textContent ?? "").length : 0;
  const small = fullLength <= textScanLimit;
  const innerText = small && body ? body.innerText : "";
  const present = markers.filter((selector) => document.querySelector(selector) !== null);
  return {
    url: location.href,
    title: document.title.slice(0, 200),
    text: innerText.slice(0, 3000),
    textLength: small ? innerText.length : fullLength,
    frames: [...document.querySelectorAll("iframe")].slice(0, 40).map((frame) => ({
      src: (frame.getAttribute("src") ?? "").slice(0, 400),
      title: (frame.getAttribute("title") ?? "").slice(0, 200),
      visible: layout.visible(frame),
      inShownContainer: [frame.closest(containers)].some(
        (container) => container !== null && layout.shown(container),
      ),
    })),
    scripts: [...document.querySelectorAll("script[src]")]
      .slice(0, 60)
      .map((script) => (script.getAttribute("src") ?? "").slice(0, 400)),
    markers: present,
    visibleMarkers: present.filter((selector) =>
      [...document.querySelectorAll(selector)].some((element) => layout.visible(element)),
    ),
    shownWidgetContainers: widgetContainers.filter((selector) =>
      [...document.querySelectorAll(selector)].some((element) => layout.shown(element)),
    ),
    hasPassword: [...document.querySelectorAll("input[type=password]")].some((input) =>
      layout.visible(input),
    ),
    headings: [...document.querySelectorAll("h1, h2, [role=heading]")]
      .slice(0, 12)
      .map((heading) =>
        heading instanceof HTMLElement ? heading.innerText.trim().slice(0, 120) : "",
      ),
  };
}

const RECAPTCHA_FRAME =
  /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|recaptcha\.net\/recaptcha/i;
const HCAPTCHA_FRAME = /hcaptcha/i;
const TURNSTILE_FRAME =
  /challenges\.cloudflare\.com|\/challenge-platform\/.*turnstile|\/turnstile\//i;
const WIDGET_FRAMES = [RECAPTCHA_FRAME, HCAPTCHA_FRAME, TURNSTILE_FRAME];

const WIDGET_CHALLENGE_FRAME = /\/bframe\b|[#&]frame=challenge\b/i;

const isWidgetFrame = (src: string) => WIDGET_FRAMES.some((pattern) => pattern.test(src));
const isWidgetCheckbox = (src: string) => isWidgetFrame(src) && !WIDGET_CHALLENGE_FRAME.test(src);

function widgetState(frameElement: Element, widgetContainers: string[]) {
  const fields =
    "textarea[name='g-recaptcha-response'], textarea[name='h-captcha-response'], input[name='cf-turnstile-response']";
  const box = frameElement.getBoundingClientRect();
  const style = getComputedStyle(frameElement);
  let solved = false;
  let node: Element | null = frameElement;
  while (node) {
    const root: ParentNode | null = node.parentNode;
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    const field = node?.querySelector(fields);
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      solved = field.value !== "";
      break;
    }
  }
  let container: Element | null = null;
  node = frameElement;
  while (node && !container) {
    container = node.closest(widgetContainers.join(", "));
    const root: Node = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return {
    title: (frameElement.getAttribute("title") ?? "").slice(0, 200),
    visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden",
    solved,
    inShownContainer: container?.checkVisibility({ visibilityProperty: true }) ?? false,
  };
}

async function describeWidget(frame: Frame): Promise<ProbeFrame | undefined> {
  const element = await frame.frameElement().catch(() => undefined);
  if (!element) return undefined;
  const state = await element.evaluate(widgetState, WIDGET_CONTAINERS).catch(() => undefined);
  void element.dispose().catch(() => undefined);
  return state && { src: frame.url().slice(0, 400), ...state };
}

const widgetFrameList = (page: Page) =>
  page.frames().filter((frame) => frame !== page.mainFrame() && isWidgetFrame(frame.url()));

async function describeWidgets(page: Page) {
  const described = await withDeadline(
    Promise.all(widgetFrameList(page).map(describeWidget)),
    PROBE_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  if (described === TIMED_OUT) return undefined;
  return described.filter((frame): frame is ProbeFrame => frame !== undefined);
}

function resolvedSrc(src: string, pageUrl: string) {
  try {
    return new URL(src, pageUrl).href.slice(0, 400);
  } catch {
    return src;
  }
}

export function mergeWidgetFrames(
  pageFrames: ProbeFrame[],
  treeWidgets: ProbeFrame[] | undefined,
  pageUrl: string,
) {
  if (!treeWidgets?.length) return pageFrames;
  const described = new Set(treeWidgets.map((frame) => frame.src));
  return [
    ...pageFrames.filter((frame) => !described.has(resolvedSrc(frame.src, pageUrl))),
    ...treeWidgets,
  ];
}

async function probe(page: Page): Promise<PageProbe | undefined> {
  const [probed, widgets] = await Promise.all([
    withDeadline(
      page.evaluate(probePage, {
        textScanLimit: TEXT_SCAN_LIMIT,
        markers: MARKERS,
        widgetContainers: WIDGET_CONTAINERS,
      }),
      PROBE_TIMEOUT_MS,
    ).catch((): typeof TIMED_OUT => TIMED_OUT),
    describeWidgets(page),
  ]);
  if (probed === TIMED_OUT) return undefined;
  return { ...probed, frames: mergeWidgetFrames(probed.frames, widgets, probed.url) };
}

const widgetLoaded = (frames: ProbeFrame[]) =>
  frames.some((frame) => isWidgetFrame(frame.src) && (frame.visible || !frame.inShownContainer));

export function widgetPending(probed: PageProbe) {
  return probed.shownWidgetContainers.length > 0 && !widgetLoaded(probed.frames);
}

export async function probeLanding(
  tab: Tab,
  waitMs = WIDGET_WAIT_MS,
): Promise<PageProbe | undefined> {
  const { page } = tab;
  const first = await probe(page);
  if (!first || !widgetPending(first) || tab.widgetWaitRoute === tab.routes) return first;
  tab.widgetWaitRoute = tab.routes;
  const until = Date.now() + Math.min(waitMs, WIDGET_WAIT_MS);
  const shown = await repeatUntil(
    async () => {
      checkpoint();
      return widgetLoaded((await describeWidgets(page)) ?? []) ? true : undefined;
    },
    {
      delayMs: () => WIDGET_POLL_MS,
      giveUp: () => page.isClosed() || Date.now() >= until,
    },
  );
  if (!shown || page.isClosed()) return first;
  return (await probe(page)) ?? first;
}
export async function inWidgetCheckbox(locator: Locator) {
  const url = await locator
    .evaluate(() => location.href, undefined, { timeout: PROBE_TIMEOUT_MS })
    .catch(() => "");
  return isWidgetCheckbox(url);
}

async function frameBox(frame: Frame) {
  const element = await frame.frameElement().catch(() => undefined);
  const box = await element?.boundingBox().catch(() => null);
  void element?.dispose().catch(() => undefined);
  return box ?? undefined;
}

export async function widgetCheckboxAt(page: Page, point: Point) {
  const boxes = await Promise.all(
    widgetFrameList(page)
      .filter((frame) => isWidgetCheckbox(frame.url()))
      .map(frameBox),
  );
  return boxes.some(
    (box) =>
      box !== undefined &&
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height,
  );
}

export async function awaitWidgetSolve(page: Page, probed: PageProbe) {
  const startedAt = Date.now();
  const settled = await repeatUntil(
    async () => {
      await sleep(SOLVE_POLL_MS);
      checkpoint();
      if (page.isClosed()) return probed;
      const next = await probe(page);
      return next && classifyChallenge(next)?.kind !== "interactive" ? next : undefined;
    },
    { giveUp: () => page.isClosed() || Date.now() - startedAt >= SOLVE_WAIT_MS },
  );
  return settled ?? probed;
}

const CLOUDFLARE_TITLE =
  /^(just a moment|attention required|please wait|checking your browser|un instant|einen moment)\b/i;
const CLOUDFLARE_ACTION = /verify you are human|click to verify|confirm you are human/i;
const CLOUDFLARE_CHECKING =
  /checking (if the site connection is secure|your browser before accessing)/i;
const CLOUDFLARE_BLOCKED = /sorry, you have been blocked/i;
const CLOUDFLARE_SCRIPT = /\/cdn-cgi\/challenge-platform\//i;
const PRESS_AND_HOLD = /press (&|and) hold/i;
const DATADOME_FRAME = /captcha-delivery\.com/i;
const DATADOME_SCRIPT = /datadome|captcha-delivery\.com/i;
const PERIMETERX_SCRIPT = /perimeterx|px-cdn|px-cloud|\/PX\w+\/(init|main\.min|captcha)\.js/i;
const AKAMAI_SCRIPT = /\/akam\/|\/_sec\/|akamai/i;
const AKAMAI_PROMPT = /verify|press|slide|captcha/i;
const AKAMAI_DENIED = /you don't have permission to access/i;
const AKAMAI_REFERENCE = /reference #?\d/i;
const INCAPSULA = /_Incapsula_Resource/i;
const INCAPSULA_CAPTCHA = /captcha|verify you are human|i am human/i;
const INCAPSULA_BLOCK = /request unsuccessful|incapsula incident id/i;
const AWS_WAF_SCRIPT = /\.awswaf\.com\//i;
const GOOGLE_HOST = /^www\.google\./i;
const BLOCK_TITLE = /^(access denied|blocked|request blocked|you have been blocked)$/i;
const BLOCK_TEXT = /^(access to this page has been denied|access denied)\b/i;
const VERIFY_HUMAN =
  /verify (that )?you are (a )?human|confirm you are (a )?human|are you a robot\?|pardon our interruption/i;
const DENIED_WORDS =
  /access denied|blocked|too many requests|rate.?limit|request (was|has been) (denied|rejected)/i;
const ROBOT_WORDS =
  /unusual (traffic|activity)|automated (queries|requests|traffic)|are you a (robot|human)|bot detection|security check|captcha/i;

function frameLabel(src: string) {
  try {
    const url = new URL(src, "http://relative.invalid");
    return url.host === "relative.invalid" ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    return src;
  }
}

function hostAndPath(url: string) {
  try {
    const parsed = new URL(url);
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: "", path: "" };
  }
}

type Signals = {
  probed: PageProbe;
  status?: number;
  short: boolean;
  nearEmpty: boolean;
  has: (...selectors: string[]) => boolean;
  shown: (selector: string) => boolean;
  frame: (pattern: RegExp) => string | undefined;
  script: (pattern: RegExp) => string | undefined;
  visibleFrame: (matches: (frame: ProbeFrame) => boolean) => ProbeFrame | undefined;
  interstitial: (provider: RegExp) => boolean;
  takesOver: (selectors: string[], provider: RegExp) => boolean;
};

type Rule = (signals: Signals) => Challenge | undefined;

const titled = (probed: PageProbe) => `title ${JSON.stringify(probed.title.trim())}`;

const cloudflare: Rule = ({ probed, status, short, has, shown, script, visibleFrame }) => {
  if (
    CLOUDFLARE_BLOCKED.test(probed.text) &&
    (has("#cf-error-details") || /cloudflare/i.test(probed.text))
  )
    return { provider: "Cloudflare", kind: "block", detail: 'text "Sorry, you have been blocked"' };
  const statusDetail = status ? `, HTTP ${status}` : "";
  const widget =
    shown(".cf-turnstile") ||
    visibleFrame((frame) => TURNSTILE_FRAME.test(frame.src)) !== undefined ||
    CLOUDFLARE_ACTION.test(probed.text);
  const challengeSignal = widget || script(CLOUDFLARE_SCRIPT) !== undefined;
  const refused = status === 403 || status === 503;
  const titledCheck =
    CLOUDFLARE_TITLE.test(probed.title.trim()) &&
    (challengeSignal || refused || CLOUDFLARE_CHECKING.test(probed.text));
  if (short && (titledCheck || (refused && challengeSignal) || has(...CLOUDFLARE_MARKERS)))
    return {
      provider: "Cloudflare",
      kind: widget ? "interactive" : "self-clearing",
      detail: `${titled(probed)}${statusDetail}`,
    };
  if (!refused) return undefined;
  if (CLOUDFLARE_ACTION.test(probed.text))
    return {
      provider: "Cloudflare",
      kind: "interactive",
      detail: `${titled(probed)}${statusDetail}`,
    };
  if (CLOUDFLARE_CHECKING.test(probed.text))
    return {
      provider: "Cloudflare",
      kind: "self-clearing",
      detail: `${titled(probed)}${statusDetail}`,
    };
  return undefined;
};

const perimeterX: Rule = ({ probed, short, has, takesOver }) => {
  if (has(...PERIMETERX_MARKERS) && takesOver(PERIMETERX_MARKERS, PERIMETERX_SCRIPT))
    return { provider: "PerimeterX", kind: "interactive", detail: "element #px-captcha" };
  const asked = short && has(...PERIMETERX_MARKERS) ? VERIFY_HUMAN.exec(probed.text) : null;
  if (asked)
    return {
      provider: "PerimeterX",
      kind: "interactive",
      detail: `text ${JSON.stringify(asked[0])}`,
    };
  if (short && PRESS_AND_HOLD.test(probed.text))
    return { provider: "PerimeterX", kind: "interactive", detail: 'text "Press & Hold"' };
  return undefined;
};

const dataDome: Rule = ({ frame, has, takesOver, visibleFrame, interstitial }) => {
  const src =
    visibleFrame((candidate) => DATADOME_FRAME.test(candidate.src))?.src ??
    (interstitial(DATADOME_SCRIPT) ? frame(DATADOME_FRAME) : undefined);
  if (src)
    return {
      provider: "DataDome",
      kind: src.includes("/interstitial/") ? "self-clearing" : "interactive",
      detail: `frame ${frameLabel(src)}`,
    };
  if (has("#ddv1-captcha-container") && takesOver(["#ddv1-captcha-container"], DATADOME_SCRIPT))
    return {
      provider: "DataDome",
      kind: "interactive",
      detail: "element #ddv1-captcha-container",
    };
  return undefined;
};

const akamai: Rule = ({ probed, has, shown, takesOver }) => {
  if (has(...AKAMAI_MARKERS) && takesOver(AKAMAI_MARKERS, AKAMAI_SCRIPT)) {
    const prompt = shown("#sec-cpt-if") && AKAMAI_PROMPT.test(probed.text);
    return {
      provider: "Akamai",
      kind: prompt ? "interactive" : "self-clearing",
      detail: "element #sec-if-cpt-container",
    };
  }
  if (
    /^access denied$/i.test(probed.title.trim()) &&
    AKAMAI_DENIED.test(probed.text) &&
    AKAMAI_REFERENCE.test(probed.text)
  )
    return { provider: "Akamai", kind: "block", detail: titled(probed) };
  return undefined;
};

const imperva: Rule = ({ probed, short, frame, script, visibleFrame, interstitial }) => {
  if (!short) return undefined;
  const shownFrame = visibleFrame((candidate) => INCAPSULA.test(candidate.src))?.src;
  const resource = shownFrame ?? frame(INCAPSULA) ?? script(INCAPSULA);
  if (resource) {
    const captcha =
      INCAPSULA_CAPTCHA.test(probed.text) ||
      visibleFrame((candidate) => /hcaptcha|recaptcha/i.test(candidate.src)) !== undefined;
    const detail = `resource ${frameLabel(resource)}`;
    if (captcha) return { provider: "Imperva", kind: "interactive", detail };
    if (INCAPSULA_BLOCK.test(probed.text)) return { provider: "Imperva", kind: "block", detail };
    if (shownFrame || interstitial(INCAPSULA))
      return { provider: "Imperva", kind: "self-clearing", detail };
  }
  if (/incapsula incident id/i.test(probed.text))
    return { provider: "Imperva", kind: "block", detail: 'text "Incapsula incident ID"' };
  return undefined;
};

const awsWaf: Rule = ({ short, has, shown, script, interstitial }) => {
  if (has("awswaf-captcha"))
    return { provider: "AWS WAF", kind: "interactive", detail: "element awswaf-captcha" };
  const src = script(AWS_WAF_SCRIPT);
  if (src && short && (shown("#challenge-container") || interstitial(AWS_WAF_SCRIPT)))
    return { provider: "AWS WAF", kind: "self-clearing", detail: `script ${frameLabel(src)}` };
  return undefined;
};

const googleSorry: Rule = ({ probed }) => {
  const { host, path } = hostAndPath(probed.url);
  return GOOGLE_HOST.test(host) && path.startsWith("/sorry/")
    ? { provider: "Google", kind: "interactive", detail: "url google.com/sorry" }
    : undefined;
};

const WIDGET_KINDS: [string, (frame: ProbeFrame) => boolean][] = [
  ["reCAPTCHA", (frame) => RECAPTCHA_FRAME.test(frame.src)],
  ["hCaptcha", (frame) => HCAPTCHA_FRAME.test(frame.src) || HCAPTCHA_FRAME.test(frame.title)],
  ["Cloudflare Turnstile", (frame) => TURNSTILE_FRAME.test(frame.src)],
];

function widgetIn(visibleFrame: Signals["visibleFrame"], solved: boolean): Challenge | undefined {
  for (const [provider, matches] of WIDGET_KINDS) {
    const frame = visibleFrame(
      (candidate) => matches(candidate) && (candidate.solved === true) === solved,
    );
    if (frame)
      return {
        provider,
        kind: solved ? "solved" : "interactive",
        detail: `widget frame ${frameLabel(frame.src)}`,
      };
  }
  return undefined;
}

export function standsInForPage(challenge: Challenge) {
  return (
    challenge.kind !== "solved" &&
    !WIDGET_KINDS.some(([provider]) => provider === challenge.provider)
  );
}

const widgets: Rule = ({ visibleFrame }) =>
  widgetIn(visibleFrame, false) ?? widgetIn(visibleFrame, true);

const statusBlock: Rule = ({ probed, status }) => {
  const detail = `HTTP ${status}, ${titled(probed)}`;
  if (status === 429) return { provider: "", kind: "block", detail };
  if (status !== 403) return undefined;
  const words = `${probed.title}\n${probed.text}`;
  if (DENIED_WORDS.test(words)) return { provider: "", kind: "block", detail };
  if (ROBOT_WORDS.test(words)) return { provider: "bot", kind: "interactive", detail };
  return undefined;
};

const shortPage: Rule = ({ probed, short, nearEmpty }) => {
  if (!short) return undefined;
  const title = probed.title.trim();
  const text = probed.text.trim();
  if (BLOCK_TITLE.test(title) || BLOCK_TEXT.test(text))
    return {
      provider: "",
      kind: "block",
      detail: title ? titled(probed) : `text ${JSON.stringify(text.slice(0, 60))}`,
    };
  const found = VERIFY_HUMAN.exec(title) ?? (nearEmpty ? VERIFY_HUMAN.exec(text) : null);
  if (found)
    return { provider: "bot", kind: "interactive", detail: `text ${JSON.stringify(found[0])}` };
  return undefined;
};

const RULES: Rule[] = [
  cloudflare,
  perimeterX,
  dataDome,
  akamai,
  imperva,
  awsWaf,
  googleSorry,
  widgets,
  statusBlock,
  shortPage,
];

export function classifyChallenge(probed: PageProbe, status?: number): Challenge | undefined {
  const frames = probed.frames.filter((frame) => !/[?&#]size=invisible\b/i.test(frame.src));
  const short = probed.textLength < SHORT_PAGE_CHARS;
  const nearEmpty = probed.textLength < NEAR_EMPTY_CHARS;
  const interstitial = (provider: RegExp) =>
    nearEmpty &&
    !probed.hasPassword &&
    !probed.headings.some(Boolean) &&
    probed.scripts.every((src) => provider.test(src));
  const signals: Signals = {
    probed,
    status,
    short,
    nearEmpty,
    has: (...selectors) => selectors.some((selector) => probed.markers.includes(selector)),
    shown: (selector) => probed.visibleMarkers.includes(selector),
    frame: (pattern) => frames.find((frame) => pattern.test(frame.src))?.src,
    script: (pattern) => probed.scripts.find((src) => pattern.test(src)),
    visibleFrame: (matches) => frames.find((frame) => frame.visible && matches(frame)),
    interstitial,
    takesOver: (selectors, provider) =>
      selectors.some((selector) => probed.visibleMarkers.includes(selector)) ||
      interstitial(provider),
  };
  for (const rule of RULES) {
    const found = rule(signals);
    if (found) return found;
  }
  return undefined;
}

export type ChallengeOutcome = {
  probed: PageProbe;
  challenge?: Challenge;
  cleared?: Challenge;
  waitedMs: number;
};

export async function settleChallenge(
  page: Page,
  first: PageProbe,
  status?: number,
  waitMs = CHALLENGE_WAIT_MS,
): Promise<ChallengeOutcome> {
  const initial = classifyChallenge(first, status);
  const startedAt = Date.now();
  const until = startedAt + Math.min(waitMs, CHALLENGE_WAIT_MS);
  const left = () => until - Date.now();
  if (initial?.kind !== "self-clearing" || left() <= 0)
    return { probed: first, challenge: initial, waitedMs: 0 };
  let latest: ChallengeOutcome = { probed: first, challenge: initial, waitedMs: 0 };
  const settled = await repeatUntil(
    async () => {
      await sleep(Math.min(CHALLENGE_POLL_MS, left()));
      checkpoint();
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: Math.max(1, Math.min(CHALLENGE_POLL_MS, left())),
        })
        .catch(() => undefined);
      const waitedMs = Date.now() - startedAt;
      if (page.isClosed()) return { ...latest, waitedMs };
      const next = await probe(page);
      if (!next) return undefined;
      const found = classifyChallenge(next, next.url === first.url ? status : undefined);
      if (!found) return { probed: next, cleared: latest.challenge, waitedMs };
      latest = { probed: next, challenge: found, waitedMs };
      return found.kind === "self-clearing" ? undefined : latest;
    },
    { giveUp: () => left() <= 0 },
  );
  return settled ?? { ...latest, waitedMs: Date.now() - startedAt };
}

const seconds = (ms: number) => Math.round(ms / 1000);

export function challengeLine(challenge: Challenge, waitedMs = 0) {
  if (challenge.kind === "solved")
    return `Challenge solved: the ${challenge.provider} check on this page (${challenge.detail}) shows as solved; carry on with the page.`;
  if (challenge.kind === "block") {
    const source = challenge.provider ? `${challenge.provider}, ` : "";
    return `Blocked: the site refused the visit (${source}${challenge.detail}). Stop and tell the user; do not retry or reload, which makes the block worse for the user's IP and account.`;
  }
  const still = waitedMs > 0 ? `, still there after ${seconds(waitedMs)} s` : "";
  return `Challenge: ${challenge.provider} check on this page (${challenge.detail}${still}). Try it yourself first: click its checkbox or follow its prompt with human: true, then wait for it to clear; if it does not clear, use handoff to let the user complete it.`;
}

export function clearedLine(challenge: Challenge, waitedMs: number, now: string) {
  return `Challenge cleared: the ${challenge.provider} check (${challenge.detail}) passed by itself after ${seconds(waitedMs)} s; the tab is now at ${now}.`;
}

const SIGN_IN_SEGMENTS = new Set([
  "login",
  "log-in",
  "log_in",
  "signin",
  "sign-in",
  "sign_in",
  "auth",
  "oturum-ac",
  "oturum-aç",
  "giris",
  "giriş",
]);
const SIGN_IN_HEADING =
  /\b(sign[ -]?in|log[ -]?in)\b|oturum aç|giriş yap|^giriş$|anmelden|connexion|iniciar sesión/i;
const RETURN_PARAMS = new Set([
  "next",
  "return",
  "returnto",
  "return_to",
  "returnurl",
  "return_url",
  "redirect",
  "redirect_uri",
  "redirect_url",
  "redirectto",
  "continue",
  "from",
  "goto",
  "callback",
  "backurl",
  "back_url",
  "destination",
  "dest",
  "ret",
]);

function parse(url: string) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function decodedPath(url: URL) {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

export function isSignInUrl(url: string) {
  const parsed = parse(url);
  if (!parsed) return false;
  return decodedPath(parsed)
    .toLowerCase()
    .replace(/\u0307/g, "")
    .split("/")
    .some((segment) => SIGN_IN_SEGMENTS.has(segment.replace(/\.[a-z]{2,5}$/, "")));
}

export function hasReturnParam(url: string) {
  const parsed = parse(url);
  return parsed
    ? [...parsed.searchParams.keys()].some((key) => RETURN_PARAMS.has(key.toLowerCase()))
    : false;
}

export function sameSite(left: string, right: string) {
  const a = parse(left);
  const b = parse(right);
  return (
    a !== undefined &&
    b !== undefined &&
    registrableDomain(a.hostname) === registrableDomain(b.hostname)
  );
}

function looksLikeSignInPage(
  url: string,
  page: Pick<PageProbe, "hasPassword" | "headings" | "title">,
) {
  if (isSignInUrl(url)) return true;
  return (
    page.hasPassword && [page.title, ...page.headings].some((text) => SIGN_IN_HEADING.test(text))
  );
}

type SessionCheck = {
  previousUrl: string;
  finalUrl: string;
  requestedUrl?: string;
  redirected?: boolean;
  page: Pick<PageProbe, "hasPassword" | "headings" | "title">;
};

export function sessionMayHaveExpired(check: SessionCheck) {
  if (!sameSite(check.previousUrl, check.finalUrl) || isSignInUrl(check.previousUrl)) return false;
  if (check.requestedUrl !== undefined)
    return !isSignInUrl(check.requestedUrl) && looksLikeSignInPage(check.finalUrl, check.page);
  if (check.finalUrl === check.previousUrl || !isSignInUrl(check.finalUrl)) return false;
  return check.redirected === true || hasReturnParam(check.finalUrl);
}

export const SIGN_IN_NOTE = "Note: this looks like a sign-in page; the session may have expired.";
