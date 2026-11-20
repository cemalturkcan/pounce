import { withDeadline } from "./async.ts";
import { pushEvent, type Tab } from "./browser.ts";
import type { AutoConsent } from "./config.ts";
import { dismissOverlays, type OverlayClick } from "./overlays.ts";

export const CONSENT_WINDOW_MS = 1500;
const CONSENT_POLL_MS = 250;
const CONSENT_PASS_MS = 3000;

function describe(click: OverlayClick) {
  const verb = click.kind === "reject" || click.kind === "necessary" ? "rejected" : click.kind === "accept" ? "accepted" : "closed";
  return `${verb} the cookie banner (${click.label})`;
}

async function consentPass(tab: Tab, mode: Exclude<AutoConsent, "off">) {
  if (tab.page.isClosed()) return undefined;
  const clicks = await withDeadline(dismissOverlays(tab.page, { consent: mode, allowAccept: true, consentOnly: true }), CONSENT_PASS_MS).catch(() => undefined);
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
  if (await acceptConsentOnce(tab, mode)) return;
  void (async () => {
    while (Date.now() < deadline && !tab.page.isClosed()) {
      await new Promise((resolve) => setTimeout(resolve, CONSENT_POLL_MS));
      if (await acceptConsentOnce(tab, mode)) return;
    }
  })().catch(() => undefined);
}
