import { setTimeout as delay } from "node:timers/promises";
import { repeatUntil, withDeadline } from "../shared/async.ts";
import type { AutoConsent } from "../config/config.ts";
import { dismissOverlays, type OverlayClick } from "./dismiss.ts";
import { pushEvent, type Tab } from "../browser/tab.ts";

const CONSENT_WINDOW_MS = 1500;
const CONSENT_POLL_MS = 250;
const CONSENT_PASS_MS = 3000;

function describe(click: OverlayClick) {
  const verb =
    click.kind === "reject" || click.kind === "necessary"
      ? "rejected"
      : click.kind === "accept"
        ? "accepted"
        : "closed";
  return `${verb} the cookie banner (${click.label})`;
}

const passes = new WeakMap<Tab, Promise<string | undefined>>();
const watches = new WeakMap<Tab, symbol>();

function consentPass(tab: Tab, mode: Exclude<AutoConsent, "off">) {
  const pass = (passes.get(tab) ?? Promise.resolve(undefined)).then(() => clickConsent(tab, mode));
  passes.set(tab, pass);
  return pass;
}

async function clickConsent(tab: Tab, mode: Exclude<AutoConsent, "off">) {
  if (tab.page.isClosed()) return undefined;
  const clicks = await withDeadline(
    dismissOverlays(tab.page, { consent: mode, allowAccept: true, consentOnly: true }),
    CONSENT_PASS_MS,
  ).catch(() => undefined);
  if (!Array.isArray(clicks)) return undefined;
  const clicked = clicks.find((click: OverlayClick) => click.clicked);
  return clicked ? describe(clicked) : undefined;
}

export async function acceptConsentOnce(tab: Tab, mode: AutoConsent) {
  if (mode === "off") return undefined;
  const done = await consentPass(tab, mode);
  if (done) pushEvent(tab, done);
  return done;
}

export async function watchConsent(tab: Tab, mode: AutoConsent, windowMs = CONSENT_WINDOW_MS) {
  if (mode === "off") return;
  const deadline = Date.now() + windowMs;
  const watch = Symbol("consent watch");
  watches.set(tab, watch);
  if (await acceptConsentOnce(tab, mode)) return;
  const windowClosed = () =>
    Date.now() >= deadline || tab.page.isClosed() || watches.get(tab) !== watch;
  if (windowClosed()) return;
  void repeatUntil(
    async () => {
      await delay(CONSENT_POLL_MS);
      if (windowClosed()) return undefined;
      return (await acceptConsentOnce(tab, mode)) || undefined;
    },
    { giveUp: windowClosed },
  ).catch(() => undefined);
}
