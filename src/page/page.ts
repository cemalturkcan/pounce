import type { Frame, Page } from "playwright-core";
import { sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import type { BrowserManager } from "../browser/manager.ts";
import { ToolError } from "../shared/errors.ts";
import { clipHeadTail, type OutputStore } from "../shared/output.ts";
import {
  challengeLine,
  classifyChallenge,
  probe as probeLanding,
  SIGN_IN_NOTE,
  sessionMayHaveExpired,
} from "./checks.ts";
import { settleRendering } from "./settle.ts";
import { parseRef } from "../browser/ref.ts";
import { cutSubtree, interactiveOnly, limitDepth, topLevelRefs } from "./snapshot.ts";
import type { Tab } from "../browser/tab.ts";
import { drainPasskeyRequests } from "../browser/page-hooks.ts";
import { drainEvents } from "../browser/tab.ts";

const SETTLE_MS = 150;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 1500;

type SnapshotOptions = {
  target?: string;
  depth?: number;
  interactive?: boolean;
  boxes?: boolean;
  maxChars: number;
};

type PageLink = { text: string; url: string };

export async function pageTitle(page: Page, ms = PROBE_TIMEOUT_MS) {
  const title = await withDeadline(page.title(), ms).catch(() => "");
  return title === TIMED_OUT ? undefined : title;
}

export async function describePage(page: Page) {
  if (page.isClosed()) return "tab closed";
  const title = await pageTitle(page);
  if (title === undefined) return `${page.url()} (title unavailable: the page is not responding)`;
  return title ? `${page.url()} "${title}"` : page.url();
}

async function scopeRefs(manager: BrowserManager, tab: Tab, target: string) {
  const ref = parseRef(target);
  if (ref) return [ref];
  const locator = await manager.resolve(tab, target);
  const scoped = await locator.ariaSnapshot({ mode: "ai", timeout: SNAPSHOT_TIMEOUT_MS });
  const refs = topLevelRefs(scoped);
  if (refs.length === 0)
    throw new ToolError(
      `${target} has no element in the accessibility tree.`,
      "Target a visible element, or use read_text for its text.",
    );
  return refs;
}

export async function rawSnapshot(
  manager: BrowserManager,
  tab: Tab,
  options: Pick<SnapshotOptions, "target" | "depth" | "boxes">,
) {
  const refs = options.target ? await scopeRefs(manager, tab, options.target) : undefined;
  const loads = tab.loads;
  const full = await tab.page.ariaSnapshot({
    mode: "ai",
    depth: refs ? undefined : options.depth,
    boxes: options.boxes,
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
  tab.snapshotLoads = loads;
  if (!refs || !options.target) return full;
  const parts = refs
    .map((ref) => cutSubtree(full, ref))
    .filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    throw new ToolError(
      `${options.target} is not in the current snapshot of tab ${tab.id}.`,
      "Refs are valid until the element changes or the page loads again. Take a new snapshot and use a ref from it.",
    );
  }
  const scoped = parts.join("\n");
  return options.depth ? limitDepth(scoped, options.depth) : scoped;
}

function comparableLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/ \[active\]/g, ""))
    .filter(Boolean);
}

function changedLines(before: string, after: string) {
  const beforeLines = comparableLines(before);
  const afterLines = comparableLines(after);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter((line) => !beforeSet.has(line)).map((line) => `+ ${line}`);
  const removed = beforeLines.filter((line) => !afterSet.has(line)).map((line) => `- ${line}`);
  return [...added, ...removed];
}

function diffSnapshots(before: string, after: string, maxLines: number) {
  const lines = changedLines(before, after);
  if (lines.length === 0) return "No lines of the snapshot changed.";
  const shown = lines.slice(0, maxLines);
  const more =
    lines.length > shown.length
      ? `\n… ${lines.length - shown.length} more changed lines; take a snapshot for the full page.`
      : "";
  return `Snapshot changes (+ added, - removed):\n${shown.join("\n")}${more}`;
}

export async function renderSnapshot(
  manager: BrowserManager,
  store: OutputStore,
  tab: Tab,
  options: SnapshotOptions,
) {
  const full = await rawSnapshot(manager, tab, options);
  const body = options.interactive ? interactiveOnly(full) : full;
  const clipped = clipHeadTail(body, options.maxChars);
  if (!clipped.truncated) return body || "(empty)";
  const file = await store.write("snapshots", store.uniqueName(`${tab.id}-snapshot`, "yml"), full);
  return `${clipped.text}\n[snapshot truncated: ${clipped.totalChars} chars total. Full snapshot saved to ${file}. Narrow it with target, depth, interactive, or use find.]`;
}

function extractText(scope: "main" | "page") {
  const body = document.body;
  if (!body) return "";
  const whole = body.innerText ?? "";
  if (scope === "page") return whole;
  const candidates = [...document.querySelectorAll<HTMLElement>("main, article, [role=main]")]
    .map((element) => element.innerText ?? "")
    .toSorted((left, right) => right.length - left.length);
  const best = candidates[0] ?? "";
  return best.length >= whole.length / 3 ? best : whole;
}

export async function pageText(page: Page, scope: "main" | "page") {
  const text = await page.evaluate(extractText, scope);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function extractLinks(limit: number) {
  const seen = new Set<string>();
  const links: { text: string; url: string }[] = [];
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const url = anchor.href;
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    links.push({
      text: (anchor.innerText || anchor.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120),
      url,
    });
    if (links.length >= limit) break;
  }
  return links;
}

export function pageLinks(page: Page, limit: number): Promise<PageLink[]> {
  return page.evaluate(extractLinks, limit);
}

function armMutationCounter() {
  const key = Symbol.for("web-agent-mcp.mutations");
  const existing = window[key];
  if (existing instanceof Float64Array) {
    existing[0] = 0;
    return true;
  }
  const state = new Float64Array(1);
  Object.defineProperty(window, key, { value: state });
  new MutationObserver((records) => {
    state[0] = (state[0] ?? 0) + records.length;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  return true;
}

function readMutationCounter() {
  const state = window[Symbol.for("web-agent-mcp.mutations")];
  return state instanceof Float64Array ? (state[0] ?? -1) : -1;
}

async function probe<T>(frame: Frame, fn: () => T) {
  const result = await withDeadline(frame.evaluate(fn), PROBE_TIMEOUT_MS).catch(
    (): typeof TIMED_OUT => TIMED_OUT,
  );
  return result === TIMED_OUT ? undefined : result;
}

type ArmedFrames = { known: Set<Frame>; armed: Set<Frame> };

async function armFrames(page: Page): Promise<ArmedFrames> {
  const known = new Set(page.frames());
  const armed = new Set<Frame>();
  await Promise.all(
    [...known].map(async (frame) => {
      if (!frame.isDetached() && (await probe(frame, armMutationCounter))) armed.add(frame);
    }),
  );
  return { known, armed };
}

type MutationVerdict = {
  state: "changed" | "unchanged" | "unknown";
  silent: number;
  total: number;
};

async function readFrames(page: Page, { known, armed }: ArmedFrames): Promise<MutationVerdict> {
  const frames = page.frames();
  const total = frames.length;
  if (
    frames.some((frame) => !known.has(frame)) ||
    [...known].some((frame) => armed.has(frame) && frame.isDetached())
  ) {
    return { state: "changed", silent: 0, total };
  }
  let silent = frames.filter((frame) => !armed.has(frame)).length;
  const counts = await Promise.all(
    frames.filter((frame) => armed.has(frame)).map((frame) => probe(frame, readMutationCounter)),
  );
  for (const count of counts) {
    if (count === undefined) silent += 1;
    else if (count !== 0) return { state: "changed", silent: 0, total };
  }
  return { state: silent ? "unknown" : "unchanged", silent, total };
}

type Landing = {
  previousUrl: string;
  requestedUrl?: string;
  status?: number;
  redirected?: boolean;
};

export async function landingLines(manager: BrowserManager, tab: Tab, landing: Landing) {
  const { page } = tab;
  if (page.isClosed()) return [];
  const [probed] = await Promise.all([
    probeLanding(page),
    drainPasskeyRequests(manager.config.engine, tab),
    manager.settlePopups(tab),
  ]);
  if (!probed || page.isClosed()) return [];
  const lines: string[] = [];
  const challenge = classifyChallenge(probed, landing.status);
  if (challenge) lines.push(challengeLine(challenge));
  const check = {
    previousUrl: landing.previousUrl,
    finalUrl: page.url(),
    requestedUrl: landing.requestedUrl,
    redirected: landing.redirected,
    page: probed,
  };
  if (sessionMayHaveExpired(check)) lines.push(SIGN_IN_NOTE);
  return lines;
}

function currentDocument(tab: Tab) {
  const document = tab.document;
  return document && document.url === tab.page.url() ? document : undefined;
}

type ActionOptions = {
  includeSnapshot?: boolean;
  includeDiff?: boolean;
  snapshotMaxChars?: number;
  noChangeText?: string;
};

const DIFF_MAX_LINES = 60;

export async function runAction(
  manager: BrowserManager,
  store: OutputStore,
  tab: Tab,
  action: () => Promise<string>,
  options: ActionOptions = {},
) {
  const { page } = tab;
  const urlBefore = page.url();
  let navigated = false;
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) navigated = true;
  };

  const snapshotBefore = options.includeDiff
    ? await rawSnapshot(manager, tab, {}).catch(() => undefined)
    : undefined;
  const armed = await armFrames(page);
  const startedAt = Date.now();
  page.on("framenavigated", onNavigation);
  let summary: string;
  try {
    summary = await action();
    await sleep(SETTLE_MS);
    if (navigated && !page.isClosed()) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
    }
  } finally {
    page.off("framenavigated", onNavigation);
  }

  const lines = [summary];
  const moved = navigated || page.url() !== urlBefore;
  let snapshotAfter: string | undefined;
  if (page.isClosed()) {
    lines.push("The tab closed.");
  } else {
    if (options.includeSnapshot || snapshotBefore !== undefined) await settleRendering(page);
    if (snapshotBefore !== undefined && !moved)
      snapshotAfter = await rawSnapshot(manager, tab, {}).catch(() => undefined);
    if (moved) lines.push(`Navigated to ${await describePage(page)}`);
    else {
      const verdict = await readFrames(page, armed);
      const snapshotChanged =
        snapshotBefore !== undefined &&
        snapshotAfter !== undefined &&
        changedLines(snapshotBefore, snapshotAfter).length > 0;
      if (verdict.state === "changed") lines.push("The page changed.");
      else if (snapshotChanged)
        lines.push(
          "The page changed: the snapshot differs although the DOM did not, as with a CSS :hover or :focus style.",
        );
      else if (verdict.state === "unknown") {
        lines.push(
          `Could not tell whether the page changed: ${verdict.silent} of ${verdict.total} frames did not answer. Take a snapshot to check.`,
        );
      } else if (options.noChangeText !== "")
        lines.push(options.noChangeText ?? "No change detected on the page.");
    }
    const document = currentDocument(tab);
    lines.push(
      ...(await landingLines(manager, tab, {
        previousUrl: urlBefore,
        status: document?.status,
        redirected: navigated && document?.redirected === true,
      })),
    );
  }
  lines.push(...drainEvents(tab, startedAt));

  if (options.includeSnapshot && !page.isClosed()) {
    lines.push(
      "",
      await renderSnapshot(manager, store, tab, { maxChars: options.snapshotMaxChars ?? 12_000 }),
    );
  } else if (snapshotBefore !== undefined && !page.isClosed()) {
    lines.push(
      "",
      moved
        ? "The page navigated, so there is no line diff; take a snapshot of the new page."
        : diffSnapshots(
            snapshotBefore,
            snapshotAfter ?? (await rawSnapshot(manager, tab, {})),
            DIFF_MAX_LINES,
          ),
    );
  }
  return lines.join("\n");
}
