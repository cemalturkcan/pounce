import type { Page } from "playwright-core";
import { repeatUntil, TIMED_OUT, withDeadline } from "../shared/async.ts";

type SettleOptions = { quietMs: number; maxWaitMs: number; pollMs?: number };

type SettleOutcome = { settled: boolean; ms: number; unresponsive?: boolean };

const DEFAULT_POLL_MS = 250;
const PROBE_MS = 2000;

export const DEFAULT_QUIET_MS = 800;
export const DEFAULT_MAX_WAIT_MS = 8000;

function contentSignature() {
  const body = document.body;
  if (!body) return { key: "no-body", loading: true };
  const candidates = [...body.querySelectorAll<HTMLElement>("main, article, [role=main]")];
  const whole = body.innerText.length;
  const main = candidates.toSorted((a, b) => b.innerText.length - a.innerText.length)[0];
  const scope = main && main.innerText.length >= whole / 3 ? main : body;
  const markers = body.querySelectorAll(
    '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="skeleton" i], [class*="loading" i], [class*="shimmer" i], [id*="spinner" i], [id*="skeleton" i], [id*="loading" i], [id*="shimmer" i]',
  );
  const loading = [...markers].some((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  });
  return { key: `${scope.innerText.length}:${body.getElementsByTagName("*").length}`, loading };
}

export async function waitForContent(page: Page, options: SettleOptions): Promise<SettleOutcome> {
  if (options.maxWaitMs <= 0) return { settled: true, ms: 0 };
  const started = Date.now();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const elapsed = () => Date.now() - started;
  let last = "";
  let stableSince = started;
  const outcome = await repeatUntil(
    async (): Promise<SettleOutcome | undefined> => {
      const probe = await withDeadline(page.evaluate(contentSignature), PROBE_MS).catch(
        () => undefined,
      );
      const now = Date.now();
      if (probe === TIMED_OUT) return { settled: false, ms: now - started, unresponsive: true };
      if (!probe || probe.key !== last || probe.loading) {
        last = probe?.key ?? "";
        stableSince = now;
        return undefined;
      }
      if (now - stableSince >= options.quietMs) return { settled: true, ms: now - started };
      return undefined;
    },
    {
      delayMs: () => Math.min(pollMs, Math.max(0, options.maxWaitMs - elapsed())),
      giveUp: () => elapsed() >= options.maxWaitMs,
    },
  );
  return outcome ?? { settled: false, ms: elapsed() };
}

async function settleInPage(options: { maxMs: number; quietMs: number }) {
  const deadline = performance.now() + options.maxMs;
  const remaining = () => Math.max(0, deadline - performance.now());
  const within = (promise: Promise<unknown>) =>
    Promise.race([promise, new Promise((resolve) => setTimeout(resolve, remaining()))]);
  const frames = () =>
    within(new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await frames();
  const images = [...document.images].filter((image) => {
    const rect = image.getBoundingClientRect();
    return (
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    );
  });
  await within(
    Promise.allSettled([document.fonts.ready, ...images.map((image) => image.decode())]),
  );
  const finite = document
    .getAnimations()
    .filter(
      (animation) =>
        animation.playState === "running" &&
        Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
    );
  await within(Promise.allSettled(finite.map((animation) => animation.finished)));
  await new Promise<void>((resolve) => {
    let quiet = setTimeout(done, Math.min(options.quietMs, remaining()));
    const cutoff = setTimeout(done, remaining());
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, Math.min(options.quietMs, remaining()));
    });
    function done() {
      clearTimeout(quiet);
      clearTimeout(cutoff);
      observer.disconnect();
      resolve();
    }
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });
  await frames();
}

export const RENDER_MAX_MS = 1500;
const RENDER_QUIET_MS = 200;

export async function settleRendering(page: Page) {
  await withDeadline(
    page.evaluate(settleInPage, { maxMs: RENDER_MAX_MS, quietMs: RENDER_QUIET_MS }),
    RENDER_MAX_MS + PROBE_MS,
  ).catch(() => undefined);
}
