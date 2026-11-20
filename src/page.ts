import type { Locator, Page } from "playwright-core";
import type { BrowserManager, Tab } from "./browser.ts";
import { clipHeadTail, type OutputStore } from "./output.ts";
import { interactiveOnly } from "./snapshot.ts";

const SETTLE_MS = 150;
const SNAPSHOT_TIMEOUT_MS = 15_000;

export type SnapshotOptions = {
  target?: string;
  depth?: number;
  interactive?: boolean;
  boxes?: boolean;
  maxChars: number;
};

export type PageLink = { text: string; url: string };

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function describePage(page: Page) {
  if (page.isClosed()) return "tab closed";
  const title = await page.title().catch(() => "");
  return title ? `${page.url()} "${title}"` : page.url();
}

export async function rawSnapshot(manager: BrowserManager, tab: Tab, options: Pick<SnapshotOptions, "target" | "depth" | "boxes">) {
  const source: Page | Locator = options.target ? await manager.resolve(tab, options.target) : tab.page;
  return source.ariaSnapshot({ mode: "ai", depth: options.depth, boxes: options.boxes, timeout: SNAPSHOT_TIMEOUT_MS });
}

export function diffSnapshots(before: string, after: string, maxLines: number) {
  const clean = (text: string) => text.split("\n").map((line) => line.trim().replace(/ \[active\]/g, "")).filter(Boolean);
  const beforeLines = clean(before);
  const afterLines = clean(after);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  const added = afterLines.filter((line) => !beforeSet.has(line)).map((line) => `+ ${line}`);
  const removed = beforeLines.filter((line) => !afterSet.has(line)).map((line) => `- ${line}`);
  const lines = [...added, ...removed];
  if (lines.length === 0) return "No lines of the snapshot changed.";
  const shown = lines.slice(0, maxLines);
  const more = lines.length > shown.length ? `\n… ${lines.length - shown.length} more changed lines; take a snapshot for the full page.` : "";
  return `Snapshot changes (+ added, - removed):\n${shown.join("\n")}${more}`;
}

export async function renderSnapshot(manager: BrowserManager, store: OutputStore, tab: Tab, options: SnapshotOptions) {
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
    .sort((left, right) => right.length - left.length);
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
    links.push({ text: (anchor.innerText || anchor.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 120), url });
    if (links.length >= limit) break;
  }
  return links;
}

export function pageLinks(page: Page, limit: number): Promise<PageLink[]> {
  return page.evaluate(extractLinks, limit);
}

function armMutationCounter() {
  const scope = globalThis as unknown as { __webAgentMutations?: { count: number } };
  if (scope.__webAgentMutations) {
    scope.__webAgentMutations.count = 0;
    return;
  }
  const state = { count: 0 };
  scope.__webAgentMutations = state;
  new MutationObserver((records) => {
    state.count += records.length;
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

function readMutationCounter() {
  const scope = globalThis as unknown as { __webAgentMutations?: { count: number } };
  return scope.__webAgentMutations?.count ?? -1;
}

export type ActionOptions = {
  includeSnapshot?: boolean;
  includeDiff?: boolean;
  snapshotMaxChars?: number;
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
  const onNavigation = (frame: unknown) => {
    if (frame === page.mainFrame()) navigated = true;
  };

  const snapshotBefore = options.includeDiff ? await rawSnapshot(manager, tab, {}).catch(() => undefined) : undefined;
  await page.evaluate(armMutationCounter).catch(() => undefined);
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
  if (page.isClosed()) {
    lines.push("The tab closed.");
  } else {
    const mutations = await page.evaluate(readMutationCounter).catch(() => -1);
    if (navigated || page.url() !== urlBefore) lines.push(`Navigated to ${await describePage(page)}`);
    else if (mutations > 0) lines.push("The page changed.");
    else lines.push("No change detected on the page.");
  }
  lines.push(...manager.drainEvents(tab).map((event) => `Event: ${event}`));

  if (options.includeSnapshot && !page.isClosed()) {
    lines.push("", await renderSnapshot(manager, store, tab, { maxChars: options.snapshotMaxChars ?? 12_000 }));
  } else if (snapshotBefore !== undefined && !page.isClosed()) {
    const moved = navigated || page.url() !== urlBefore;
    lines.push(
      "",
      moved
        ? "The page navigated, so there is no line diff; take a snapshot of the new page."
        : diffSnapshots(snapshotBefore, await rawSnapshot(manager, tab, {}), DIFF_MAX_LINES),
    );
  }
  return lines.join("\n");
}
