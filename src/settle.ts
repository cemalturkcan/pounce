import type { Page } from "playwright-core";
import { TIMED_OUT, withDeadline } from "./async.ts";

export type SettleOptions = { quietMs: number; maxWaitMs: number; pollMs?: number };

export type SettleOutcome = { settled: boolean; ms: number; unresponsive?: boolean };

const DEFAULT_POLL_MS = 250;
const PROBE_MS = 2000;

export const DEFAULT_QUIET_MS = 800;
export const DEFAULT_MAX_WAIT_MS = 8000;

function contentSignature() {
  const body = document.body;
  if (!body) return { key: "no-body", loading: true };
  const candidates = [...body.querySelectorAll<HTMLElement>("main, article, [role=main]")];
  const whole = body.innerText.length;
  const main = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0];
  const scope = main && main.innerText.length >= whole / 3 ? main : body;
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const markers = body.querySelectorAll(
    '[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="skeleton" i], [class*="loading" i], [class*="shimmer" i], [id*="spinner" i], [id*="skeleton" i], [id*="loading" i], [id*="shimmer" i]',
  );
  const loading = [...markers].some(visible);
  return { key: `${scope.innerText.length}:${body.getElementsByTagName("*").length}`, loading };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForContent(page: Page, options: SettleOptions): Promise<SettleOutcome> {
  if (options.maxWaitMs <= 0) return { settled: true, ms: 0 };
  const started = Date.now();
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  let last = "";
  let stableSince = started;
  while (Date.now() - started < options.maxWaitMs) {
    const probe = await withDeadline(page.evaluate(contentSignature), PROBE_MS).catch(() => undefined);
    const now = Date.now();
    if (probe === TIMED_OUT) return { settled: false, ms: now - started, unresponsive: true };
    const signature = probe;
    if (!signature || signature.key !== last || signature.loading) {
      last = signature?.key ?? "";
      stableSince = now;
    } else if (now - stableSince >= options.quietMs) {
      return { settled: true, ms: now - started };
    }
    await sleep(Math.min(pollMs, Math.max(0, options.maxWaitMs - (Date.now() - started))));
  }
  return { settled: false, ms: Date.now() - started };
}
