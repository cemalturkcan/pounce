import type { Page } from "playwright-core";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";

const PROBE_TIMEOUT_MS = 1500;
const TEXT_SCAN_LIMIT = 20_000;

type ProbeFrame = { src: string; title: string; visible: boolean };

export type PageProbe = {
  title: string;
  text: string;
  frames: ProbeFrame[];
  cloudflareMarker: boolean;
  hasPassword: boolean;
  headings: string[];
};

export type Challenge = { kind: string; detail: string };

function probePage(textScanLimit: number): PageProbe {
  const layout = {
    visible(element: Element) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 1 && box.height > 1 && style.visibility !== "hidden" && style.display !== "none"
      );
    },
  };
  const body = document.body;
  const small = body ? (body.textContent ?? "").length <= textScanLimit : false;
  return {
    title: document.title.slice(0, 200),
    text: small && body ? body.innerText.slice(0, 3000) : "",
    frames: [...document.querySelectorAll("iframe")].slice(0, 40).map((frame) => ({
      src: (frame.getAttribute("src") ?? "").slice(0, 400),
      title: (frame.getAttribute("title") ?? "").slice(0, 200),
      visible: layout.visible(frame),
    })),
    cloudflareMarker:
      document.querySelector(
        "#challenge-form, #challenge-stage, #challenge-running, #cf-challenge-running, .cf-browser-verification, #cf-please-wait",
      ) !== null,
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

export async function probe(page: Page): Promise<PageProbe | undefined> {
  const result = await withDeadline(
    page.evaluate(probePage, TEXT_SCAN_LIMIT),
    PROBE_TIMEOUT_MS,
  ).catch(() => undefined);
  return result === TIMED_OUT ? undefined : result;
}

const RECAPTCHA_FRAME =
  /\/recaptcha\/(api2|enterprise)\/(anchor|bframe)|recaptcha\.net\/recaptcha/i;
const HCAPTCHA_FRAME = /hcaptcha/i;
const TURNSTILE_FRAME =
  /challenges\.cloudflare\.com|\/challenge-platform\/.*turnstile|\/turnstile\//i;
const CLOUDFLARE_TITLE = /^(just a moment|attention required|please wait)\b/i;
const CLOUDFLARE_TEXT =
  /verify you are human|checking (if the site connection is secure|your browser before accessing)/i;
const BLOCK_WORDS =
  /access denied|blocked|forbidden|too many requests|rate.?limit|unusual (traffic|activity)|automated (queries|requests|traffic)|are you a (robot|human)|bot detection|security check|captcha|request (was|has been) (denied|rejected)/i;

function frameLabel(src: string) {
  try {
    const url = new URL(src, "http://relative.invalid");
    return url.host === "relative.invalid" ? url.pathname : `${url.host}${url.pathname}`;
  } catch {
    return src;
  }
}

export function classifyChallenge(probed: PageProbe, status?: number): Challenge | undefined {
  if (
    probed.cloudflareMarker ||
    CLOUDFLARE_TITLE.test(probed.title) ||
    ((status === 403 || status === 503) && CLOUDFLARE_TEXT.test(probed.text))
  ) {
    return {
      kind: "Cloudflare interstitial",
      detail: `title ${JSON.stringify(probed.title)}${status ? `, HTTP ${status}` : ""}`,
    };
  }
  const frames = probed.frames.filter(
    (frame) => frame.visible && !/[?&#]size=invisible\b/i.test(frame.src),
  );
  const widgets: [string, (frame: ProbeFrame) => boolean][] = [
    ["reCAPTCHA", (frame) => RECAPTCHA_FRAME.test(frame.src)],
    ["hCaptcha", (frame) => HCAPTCHA_FRAME.test(frame.src) || HCAPTCHA_FRAME.test(frame.title)],
    ["Cloudflare Turnstile", (frame) => TURNSTILE_FRAME.test(frame.src)],
  ];
  for (const [kind, matches] of widgets) {
    const frame = frames.find(matches);
    if (frame) return { kind, detail: `widget frame ${frameLabel(frame.src)}` };
  }
  if (
    status === 429 ||
    (status === 403 && (BLOCK_WORDS.test(probed.title) || BLOCK_WORDS.test(probed.text)))
  ) {
    return { kind: "block page", detail: `HTTP ${status}, title ${JSON.stringify(probed.title)}` };
  }
  return undefined;
}

export function challengeLine(challenge: Challenge) {
  return `Challenge: ${challenge.kind} on this page (${challenge.detail}). Use handoff to let the user complete it.`;
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
const SECOND_LEVEL = new Set([
  "co",
  "com",
  "net",
  "org",
  "gov",
  "edu",
  "ac",
  "gen",
  "bel",
  "web",
  "biz",
  "info",
  "av",
  "dr",
  "k12",
  "pol",
  "tsk",
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

function siteOf(host: string) {
  if (/^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return host;
  const labels = host.toLowerCase().split(".");
  const keep =
    labels.length >= 3 &&
    (labels.at(-1)?.length ?? 0) === 2 &&
    SECOND_LEVEL.has(labels.at(-2) ?? "")
      ? 3
      : 2;
  return labels.slice(-keep).join(".");
}

export function sameSite(left: string, right: string) {
  const a = parse(left);
  const b = parse(right);
  return a !== undefined && b !== undefined && siteOf(a.hostname) === siteOf(b.hostname);
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
