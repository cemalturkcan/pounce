import type { Frame, Locator, Page, Request, Response } from "playwright-core";
import { repeatUntil, sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import type { BrowserManager, RefIssue } from "../browser/manager.ts";
import { ToolError } from "../shared/errors.ts";
import { type OutputStore, shownUrl } from "../shared/output.ts";
import {
  awaitWidgetSolve,
  type Challenge,
  type ChallengeOutcome,
  challengeLine,
  classifyChallenge,
  clearedLine,
  probeLanding,
  SIGN_IN_NOTE,
  sessionMayHaveExpired,
  settleChallenge,
} from "./checks.ts";
import { RENDER_MAX_MS, settleRendering, waitForContent } from "./settle.ts";
import { checkedLines, parseRef, targetLabel } from "../browser/ref.ts";
import { aiSnapshot, rememberShownRef } from "../browser/ref-check.ts";
import {
  changedLines,
  clipByImportance,
  collapseNavigation,
  cutSubtree,
  diffSnapshots,
  interactiveOnly,
  limitDepth,
  scopeSnapshot,
  shownRefs,
  topLevelRefs,
} from "./snapshot.ts";
import type { Tab } from "../browser/tab.ts";
import { drainPasskeyRequests } from "../browser/page-hooks.ts";
import { drainEvents, namedStatus } from "../browser/tab.ts";
import { pageBound } from "./bound.ts";
import { checkpoint, recordStep } from "../shared/call-scope.ts";

const SETTLE_MS = 150;
const SNAPSHOT_TIMEOUT_MS = 15_000;
const DIALOG_LOOKUP_MS = 1000;
const PROBE_TIMEOUT_MS = 1500;
const NAVIGATION_WAIT_MS = 10_000;
const ERROR_PAGE_WAIT_MS = 2000;
const POLL_MS = 50;
const FRESH_PAGE_MS = 5000;
const NETWORK_SETTLE_MS = 1000;
const CONTENT_SETTLE = { quietMs: 200, maxWaitMs: 1500, pollMs: 100 };
const STREAMING_TYPES = new Set(["eventsource", "websocket"]);
const ERROR_PAGE_PREFIX = "chrome-error:";

type SnapshotOptions = {
  target?: string;
  scope?: "auto" | "full";
  depth?: number;
  interactive?: boolean;
  boxes?: boolean;
  maxChars: number;
};

type PageLink = { text: string; url: string };

const PENDING_TITLE = /^Loading \S+$/;

export async function shownTitle(page: Page, ms = PROBE_TIMEOUT_MS) {
  const title = await page.title();
  if (!PENDING_TITLE.test(title)) return title;
  const shown = await withDeadline(
    page.evaluate(() => document.title),
    ms / 2,
  ).catch(() => title);
  return shown === TIMED_OUT ? title : shown;
}

export async function pageTitle(page: Page, ms = PROBE_TIMEOUT_MS) {
  const title = await withDeadline(shownTitle(page, ms), ms).catch(() => "");
  return title === TIMED_OUT ? undefined : title;
}

export async function describePage(page: Page) {
  if (page.isClosed()) return "tab closed";
  const title = await pageTitle(page);
  const url = shownUrl(page.url());
  if (title === undefined) return `${url} (title unavailable: the page is not responding)`;
  return title ? `${url} "${title}"` : url;
}

function redirectPhrase(redirects: string[]) {
  const steps = redirects.length > 1 ? ` in ${redirects.length} steps` : "";
  return redirects[0] ? `redirected from ${redirects[0]}${steps}` : "";
}

export function statusNote(status: number, redirects: string[]) {
  const redirected = redirectPhrase(redirects);
  return `(HTTP ${status}${redirected ? `, ${redirected}` : ""})`;
}

export async function noContentLine(page: Page, response: Response) {
  const redirected = redirectPhrase(redirectsOf(response));
  return `No page to show: ${shownUrl(response.url())} answered HTTP ${namedStatus(response.status())}${redirected ? ` (${redirected})` : ""}, so the tab stays at ${await describePage(page)}.`;
}

export function redirectsOf(response: Response | null) {
  const chain: string[] = [];
  let previous = response?.request().redirectedFrom() ?? null;
  while (previous) {
    chain.unshift(previous.url());
    previous = previous.redirectedFrom();
  }
  return chain;
}

export type NoResponse = "same-document" | "cache" | "unknown";

export function noResponseNote(url: string, reason: NoResponse) {
  if (!/^https?:/.test(url) || reason === "unknown") return "";
  return reason === "cache" ? "(from the back/forward cache)" : "(same document, no new request)";
}

export function historyReason(before: number | undefined, after: number | undefined): NoResponse {
  if (before === undefined || after === undefined) return "unknown";
  return before === after ? "same-document" : "cache";
}

export async function documentStamp(page: Page) {
  const stamp = await withDeadline(
    page.mainFrame().evaluate(() => performance.timeOrigin),
    PROBE_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  return stamp === TIMED_OUT ? undefined : stamp;
}

const HISTORY_LOAD_MS = 3000;

export async function settleHistoryStep(page: Page) {
  const state = await withDeadline(
    page.mainFrame().evaluate(() => document.readyState),
    PROBE_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  if (state === "interactive" || state === "complete") return;
  await page
    .waitForLoadState("domcontentloaded", { timeout: HISTORY_LOAD_MS })
    .catch(() => undefined);
}

export async function hasHistoryEntry(tab: Tab, step: "back" | "forward") {
  const session = await tab.session;
  const { currentIndex, entries } = await session.send("Page.getNavigationHistory");
  return step === "back" ? currentIndex > 0 : currentIndex < entries.length - 1;
}

export async function historyEnd(page: Page, step: "back" | "forward") {
  const place = step === "back" ? "first" : "latest";
  return `Nothing to go ${step} to: ${await describePage(page)} is the ${place} page in this tab's history.`;
}

export async function statusLine(
  page: Page,
  response: Response | null,
  emptyBody: boolean,
  reason: NoResponse = "same-document",
) {
  if (response && emptyBody)
    return `${shownUrl(response.url())} (HTTP ${response.status()} with an empty body, so the tab shows Chrome's error page)`;
  const note = response
    ? statusNote(response.status(), redirectsOf(response))
    : noResponseNote(page.url(), reason);
  const described = await describePage(page);
  return note ? `${described} ${note}` : described;
}

export async function targetName(tab: Tab, locator: Locator, target: string) {
  const checked = checkedLines.get(locator);
  if (checked !== undefined) return targetLabel(checked, target);
  const snapshot = await withDeadline(
    aiSnapshot(locator, { depth: 1, timeout: PROBE_TIMEOUT_MS }),
    PROBE_TIMEOUT_MS * 2,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  if (snapshot === TIMED_OUT) return target;
  const line = snapshot.split("\n")[0] ?? "";
  if (!parseRef(target)) await rememberShownRef(tab, locator, line);
  return targetLabel(line, target);
}

function describeElementAt(point: { x: number; y: number }) {
  const hit = document.elementFromPoint(point.x, point.y);
  if (!hit) return "";
  const attributes = ["id", "class", "role", "aria-label", "title", "name"]
    .map((name) => [name, hit.getAttribute(name)] as const)
    .filter(([, value]) => value)
    .map(([name, value]) => ` ${name}="${value}"`)
    .join("");
  const text = (hit instanceof HTMLElement ? hit.innerText : (hit.textContent ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  const quoted = text.length > 60 ? `${text.slice(0, 59)}…` : text;
  return `<${hit.tagName.toLowerCase()}${attributes}>${quoted ? ` with text "${quoted}"` : ""}`;
}

export async function elementAt(page: Page, point: { x: number; y: number }) {
  const found = await withDeadline(
    page.mainFrame().evaluate(describeElementAt, point),
    PROBE_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  return found === TIMED_OUT ? "" : found;
}

const busyRequests = (tab: Tab, since: number) =>
  [...tab.pending].filter(
    ([request, { startedAt }]) =>
      startedAt >= since && !STREAMING_TYPES.has(request.resourceType()),
  ).length;

async function settleFreshRequests(tab: Tab) {
  const committedAt = tab.committedAt;
  if (tab.page.isClosed() || committedAt === undefined) return false;
  if (Date.now() - committedAt > FRESH_PAGE_MS) return false;
  const deadline = Date.now() + NETWORK_SETTLE_MS;
  await repeatUntil(async () => (busyRequests(tab, committedAt) === 0 ? true : undefined), {
    delayMs: () => POLL_MS,
    giveUp: () => Date.now() >= deadline || tab.page.isClosed(),
  });
  return true;
}

export async function settleFreshPage(tab: Tab) {
  if (!(await settleFreshRequests(tab))) return;
  if (!tab.page.isClosed()) await waitForContent(tab.page, CONTENT_SETTLE);
}

async function settleFontRequests(tab: Tab) {
  const deadline = Date.now() + RENDER_MAX_MS;
  await repeatUntil(
    async () =>
      [...tab.pending.keys()].some((request) => request.resourceType() === "font")
        ? undefined
        : true,
    {
      delayMs: () => POLL_MS,
      giveUp: () => Date.now() >= deadline || tab.page.isClosed(),
    },
  );
}

export async function settleForCapture(tab: Tab) {
  await settleFreshRequests(tab);
  if (tab.page.isClosed()) return;
  await waitForContent(tab.page, CONTENT_SETTLE);
  await Promise.all([settleRendering(tab.page), settleFontRequests(tab)]);
}

export type NavigationWatch = {
  navigated: boolean;
  request?: Request;
  doneAt?: number;
  failure?: string;
  stop: () => void;
};

export function watchNavigation(page: Page): NavigationWatch {
  const watch: NavigationWatch = { navigated: false, stop: () => undefined };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) watch.navigated = true;
  };
  const onRequest = (request: Request) => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    watch.request = request;
    watch.doneAt = undefined;
    watch.failure = undefined;
  };
  const onFinished = (request: Request) => {
    if (request === watch.request) watch.doneAt = Date.now();
  };
  const onFailed = (request: Request) => {
    if (request !== watch.request) return;
    watch.doneAt = Date.now();
    watch.failure = request.failure()?.errorText;
  };
  page.on("framenavigated", onNavigation);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  watch.stop = () => {
    page.off("framenavigated", onNavigation);
    page.off("request", onRequest);
    page.off("requestfinished", onFinished);
    page.off("requestfailed", onFailed);
  };
  return watch;
}

type NavigationState = "none" | "pending" | "loading" | "loaded";

function stoppedWithoutCommit(watch: NavigationWatch) {
  if (watch.doneAt === undefined) return false;
  const showsErrorPage = watch.failure !== undefined && !/ERR_ABORTED/.test(watch.failure);
  return Date.now() - watch.doneAt >= (showsErrorPage ? ERROR_PAGE_WAIT_MS : SETTLE_MS);
}

async function awaitNavigation(
  page: Page,
  watch: NavigationWatch,
  ms: number,
): Promise<NavigationState> {
  if (!watch.navigated && !watch.request) return "none";
  const deadline = Date.now() + ms;
  await repeatUntil(async () => (watch.navigated || page.isClosed() ? true : undefined), {
    delayMs: () => POLL_MS,
    giveUp: () => Date.now() >= deadline || stoppedWithoutCommit(watch),
  });
  if (page.isClosed()) return "loaded";
  if (!watch.navigated) return watch.doneAt === undefined ? "pending" : "none";
  const loaded = await page
    .waitForLoadState("domcontentloaded", { timeout: Math.max(deadline - Date.now(), 1) })
    .then(() => true)
    .catch(() => false);
  return loaded ? "loaded" : "loading";
}

function stillLoadingLine(url: string, waitedMs: number) {
  return `Still loading ${shownUrl(url)} after ${Math.round(waitedMs / 1000)} s`;
}

export const isTimeout = (cause: unknown) =>
  cause instanceof Error && cause.name === "TimeoutError";

export async function unfinishedNavigation(
  tab: Tab,
  url: string,
  watch: NavigationWatch,
  waitedMs: number,
) {
  const head = `${stillLoadingLine(url, waitedMs)}.`;
  if (!watch.navigated)
    return [
      head,
      `The server has not answered yet; the tab still shows ${shownUrl(tab.page.url())}.`,
    ];
  const document = currentDocument(tab);
  return [
    head,
    `The tab shows ${await statusLine(tab.page, document?.response ?? null, false, "unknown")}, still loading.`,
  ];
}

async function landedLine(tab: Tab, watch: NavigationWatch) {
  const { page } = tab;
  const document = tab.document;
  const request = watch.request;
  if (page.url().startsWith(ERROR_PAGE_PREFIX) && request) {
    if (
      document?.response.request() === request &&
      /ERR_HTTP_RESPONSE_CODE_FAILURE/.test(watch.failure ?? "")
    )
      return `Navigated to ${await statusLine(page, document.response, true)}`;
    if (watch.failure)
      return `Chrome could not load ${shownUrl(request.url())} (${watch.failure}) and shows its error page instead.`;
  }
  const current = currentDocument(tab);
  if (!current) return `Navigated to ${await describePage(page)}`;
  return `Navigated to ${await statusLine(page, current.response, false)}`;
}

async function scopeRefs(manager: BrowserManager, tab: Tab, target: string) {
  const ref = parseRef(target);
  if (ref) return [ref];
  const locator = await manager.resolve(tab, target);
  const scoped = await aiSnapshot(locator, { timeout: SNAPSHOT_TIMEOUT_MS });
  const refs = topLevelRefs(scoped);
  if (refs.length === 0)
    throw new ToolError(
      `${target} has no element in the accessibility tree.`,
      "Target a visible element, or use read_page for its text.",
    );
  return refs;
}

export async function rawSnapshot(
  manager: BrowserManager,
  tab: Tab,
  options: Pick<SnapshotOptions, "target" | "depth" | "boxes">,
) {
  const refs = options.target ? await scopeRefs(manager, tab, options.target) : undefined;
  const { text: full, issue } = await takeSnapshot(
    tab,
    refs ? undefined : options.depth,
    options.boxes,
  );
  await manager.rememberRefs(tab, full, issue);
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

async function takeSnapshot(tab: Tab, depth?: number, boxes?: boolean) {
  const issue: RefIssue = { loads: tab.loads, url: tab.page.url() };
  const text = await aiSnapshot(tab.page, {
    depth,
    boxes,
    timeout: SNAPSHOT_TIMEOUT_MS,
  });
  tab.snapshotLoads = issue.loads;
  if (depth === undefined) tab.lastSnapshot = { text, loads: issue.loads };
  return { text, issue };
}

const MODAL_CANDIDATES =
  "dialog[open], [role=dialog][aria-modal=true], [role=alertdialog][aria-modal=true]";

type ModalLookup = {
  modalFlags: () => Promise<boolean[]>;
  snapshotOf: (index: number, timeout: number) => Promise<string>;
};

function modalLookup(tab: Tab): ModalLookup {
  const candidates = tab.page.locator(MODAL_CANDIDATES).filter({ visible: true });
  return {
    modalFlags: () =>
      candidates.evaluateAll((elements) =>
        elements.map(
          (element) => element.matches(":modal") || element.getAttribute("aria-modal") === "true",
        ),
      ),
    snapshotOf: (index, timeout) => aiSnapshot(candidates.nth(index), { timeout }),
  };
}

async function openDialogRefs(lookup: ModalLookup) {
  const modal = await pageBound(
    lookup.modalFlags(),
    "Looking for an open dialog",
    DIALOG_LOOKUP_MS,
  );
  const index = modal.lastIndexOf(true);
  if (index === -1) return undefined;
  return topLevelRefs(await lookup.snapshotOf(index, DIALOG_LOOKUP_MS));
}

export async function autoView(lookup: ModalLookup, full: string) {
  const scoped = scopeSnapshot(full, await openDialogRefs(lookup).catch(() => undefined));
  const collapsed = collapseNavigation(scoped.text);
  return {
    text: collapsed.text,
    notes: [scoped.note, collapsed.note].filter((note): note is string => note !== undefined),
  };
}

export async function renderSnapshot(
  manager: BrowserManager,
  store: OutputStore,
  tab: Tab,
  options: SnapshotOptions,
) {
  await settleFreshPage(tab);
  const full = await rawSnapshot(manager, tab, options);
  const view =
    options.target || options.scope === "full"
      ? { text: full, notes: [] }
      : await autoView(modalLookup(tab), full);
  const body = options.interactive ? interactiveOnly(view.text) : view.text;
  const header = view.notes.map((note) => `[${note}]`);
  const clipped = clipByImportance(body, options.maxChars);
  if (clipped.kept === clipped.total) return [...header, body || "(empty)"].join("\n");
  const file = await store.write("snapshots", store.uniqueName(`${tab.id}-snapshot`, "yml"), full);
  return [
    ...header,
    clipped.text,
    `[snapshot clipped: kept ${clipped.kept} of ${clipped.total} lines, alerts, dialogs, headings and controls first and links last. Full snapshot saved to ${file}. Narrow it with target, depth, interactive, or query.]`,
  ].join("\n");
}

export async function snapshotDiff(manager: BrowserManager, tab: Tab) {
  const previous = tab.lastSnapshot;
  if (!previous)
    throw new ToolError(
      `There is no earlier snapshot of tab ${tab.id} to compare with.`,
      "Take a snapshot first, then call snapshot with diff: true after the change.",
    );
  const current = await rawSnapshot(manager, tab, {});
  if (previous.loads !== tab.snapshotLoads)
    throw new ToolError(
      `Tab ${tab.id} loaded a new page since the previous snapshot, so a line diff would list the whole page.`,
      "Take a snapshot without diff.",
    );
  return diffSnapshots(previous.text, current);
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

const VISIBILITY_CHECK = { visibilityProperty: true, opacityProperty: true };

function armVisibility(check: typeof VISIBILITY_CHECK) {
  const elements = [...document.querySelectorAll("*")];
  window[Symbol.for("web-agent-mcp.visible")] = Uint8Array.from(elements, (element) =>
    element.checkVisibility(check) ? 1 : 0,
  );
  return true;
}

function readVisibility(check: typeof VISIBILITY_CHECK) {
  const before = window[Symbol.for("web-agent-mcp.visible")];
  const elements = [...document.querySelectorAll("*")];
  if (!(before instanceof Uint8Array) || before.length !== elements.length) return undefined;
  const after = elements.map((element) => (element.checkVisibility(check) ? 1 : 0));
  return {
    shown: after.filter((visible, index) => visible > (before[index] ?? 0)).length,
    hidden: after.filter((visible, index) => visible < (before[index] ?? 0)).length,
  };
}

const elementCount = (value: number) => `${value} element${value === 1 ? "" : "s"}`;

type VisibilityChange = { shown: number; hidden: number };

function visibilityChanges({ shown, hidden }: VisibilityChange) {
  return [
    ...(shown ? [`${elementCount(shown)} became visible`] : []),
    ...(hidden ? [`${elementCount(hidden)} became hidden`] : []),
  ].join(" and ");
}

function describeVisibility(change: VisibilityChange) {
  return `The page changed: ${visibilityChanges(change)} although the DOM did not change, as with a CSS :hover or :focus style.`;
}

async function visibilityProbe<T>(page: Page, fn: (check: typeof VISIBILITY_CHECK) => T) {
  const result = await withDeadline(
    page.mainFrame().evaluate(fn, VISIBILITY_CHECK),
    PROBE_TIMEOUT_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  return result === TIMED_OUT ? undefined : result;
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
  widgetClicked?: boolean;
};

async function solvedOutcome(page: Page, outcome: ChallengeOutcome, status?: number) {
  if (outcome.challenge?.kind !== "interactive") return outcome;
  const probed = await awaitWidgetSolve(page, outcome.probed);
  return { probed, challenge: classifyChallenge(probed, status), waitedMs: 0 };
}

type LandingReport = {
  lines: string[];
  challenge?: Challenge;
  cleared?: Challenge & { waitedMs: number };
};

export async function landingLines(manager: BrowserManager, tab: Tab, landing: Landing) {
  return (await landingReport(manager, tab, landing)).lines;
}

export async function landingReport(
  manager: BrowserManager,
  tab: Tab,
  landing: Landing,
): Promise<LandingReport> {
  const { page } = tab;
  if (page.isClosed()) return { lines: [] };
  const [probed] = await Promise.all([
    probeLanding(tab),
    drainPasskeyRequests(manager.config.engine, tab),
    manager.settlePopups(tab),
  ]);
  if (!probed || page.isClosed()) return { lines: [] };
  const settled = await settleChallenge(page, probed, landing.status);
  const outcome = landing.widgetClicked
    ? await solvedOutcome(page, settled, landing.status)
    : settled;
  if (page.isClosed()) return { lines: [] };
  const lines: string[] = [];
  const report: LandingReport = { lines };
  const solve =
    outcome.challenge?.kind === "solved"
      ? `${tab.loads} ${outcome.challenge.provider} ${outcome.challenge.detail}`
      : undefined;
  const reported = solve !== undefined && solve === tab.reportedSolve;
  tab.reportedSolve = solve;
  if (outcome.challenge && !reported) {
    lines.push(challengeLine(outcome.challenge, outcome.waitedMs));
    report.challenge = outcome.challenge;
  }
  if (outcome.cleared) {
    lines.push(clearedLine(outcome.cleared, outcome.waitedMs, await describePage(page)));
    report.cleared = { ...outcome.cleared, waitedMs: outcome.waitedMs };
  }
  const check = {
    previousUrl: landing.previousUrl,
    finalUrl: page.url(),
    requestedUrl: landing.requestedUrl,
    redirected: landing.redirected,
    page: outcome.probed,
  };
  if (sessionMayHaveExpired(check)) lines.push(SIGN_IN_NOTE);
  return report;
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
  navigationTimeoutMs?: number;
  widgetClicked?: boolean;
};

const DIFF_MAX_LINES = 60;

async function changeLine(
  tab: Tab,
  observed: {
    armed: ArmedFrames;
    visibilityArmed: boolean | undefined;
    snapshotBefore: string | undefined;
    snapshotAfter: string | undefined;
  },
  noChangeText: string | undefined,
) {
  const verdict = await readFrames(tab.page, observed.armed);
  const { snapshotBefore, snapshotAfter } = observed;
  const snapshotChanged =
    snapshotBefore !== undefined &&
    snapshotAfter !== undefined &&
    changedLines(snapshotBefore, snapshotAfter).length > 0;
  const visibility =
    verdict.state !== "unknown" && observed.visibilityArmed
      ? await visibilityProbe(tab.page, readVisibility)
      : undefined;
  const visible = visibility !== undefined && (visibility.shown > 0 || visibility.hidden > 0);
  if (verdict.state === "changed")
    return visible
      ? `The page changed: its DOM changed and ${visibilityChanges(visibility)}.`
      : "The page changed: its DOM changed (not classified further).";
  if (snapshotChanged)
    return "The page changed: the snapshot differs although the DOM did not, as with a CSS :hover or :focus style.";
  if (visible) return describeVisibility(visibility);
  if (verdict.state === "unknown")
    return `Could not tell whether the page changed: ${verdict.silent} of ${verdict.total} frames did not answer. Take a snapshot to check.`;
  if (noChangeText === "") return undefined;
  return noChangeText ?? "No change detected on the page.";
}

export async function runAnswer(tab: Tab, answer: () => Promise<string>) {
  const { page } = tab;
  const urlBefore = page.url();
  const startedAt = Date.now();
  const watch = watchNavigation(page);
  let summary: string;
  let state: NavigationState;
  try {
    summary = await answer();
    recordStep(summary);
    await sleep(SETTLE_MS);
    state = await awaitNavigation(page, watch, NAVIGATION_WAIT_MS);
  } finally {
    watch.stop();
  }
  const lines = [summary];
  if (page.isClosed()) lines.push("The tab closed.");
  else if (state === "pending")
    lines.push(
      `${stillLoadingLine(watch.request?.url() ?? page.url(), Date.now() - startedAt)}: the server has not answered yet.`,
    );
  else if (watch.navigated || page.url() !== urlBefore)
    lines.push(
      `${await landedLine(tab, watch)}${state === "loading" ? " The page is still loading." : ""}`,
    );
  lines.push(...drainEvents(tab, startedAt));
  return lines.join("\n");
}

type ActionProgress = { mutations: () => Promise<MutationVerdict["state"]> };

const childFrameUrls = (page: Page) =>
  new Map(
    page
      .frames()
      .filter((frame) => frame !== page.mainFrame() && frame.url() !== "")
      .map((frame) => [frame, frame.url()]),
  );

const movedFrameLines = (before: Map<Frame, string>) =>
  [...before]
    .filter(([frame, url]) => !frame.isDetached() && frame.url() !== url)
    .map(
      ([frame, url]) =>
        `An iframe's address changed from ${shownUrl(url)} to ${shownUrl(frame.url())}.`,
    );

export async function runAction(
  manager: BrowserManager,
  store: OutputStore,
  tab: Tab,
  action: (progress: ActionProgress) => Promise<string>,
  options: ActionOptions = {},
) {
  const { page } = tab;
  const urlBefore = page.url();
  const snapshotBefore = options.includeDiff
    ? await takeSnapshot(tab)
        .then((taken) => taken.text)
        .catch(() => undefined)
    : undefined;
  const [armed, visibilityArmed] = await Promise.all([
    armFrames(page),
    snapshotBefore === undefined ? visibilityProbe(page, armVisibility) : undefined,
  ]);
  const frameUrls = childFrameUrls(page);
  const startedAt = Date.now();
  const watch = watchNavigation(page);
  let summary: string;
  let state: NavigationState;
  let actedAt: number;
  try {
    summary = await action({
      mutations: async () => {
        await sleep(SETTLE_MS);
        return (await readFrames(page, armed)).state;
      },
    });
    actedAt = Date.now();
    await sleep(SETTLE_MS);
    checkpoint();
    state = await awaitNavigation(page, watch, options.navigationTimeoutMs ?? NAVIGATION_WAIT_MS);
  } finally {
    watch.stop();
  }

  const lines = [summary];
  const pending = state === "pending" && !page.isClosed();
  const moved = watch.navigated || page.url() !== urlBefore;
  let snapshotAfter: Awaited<ReturnType<typeof takeSnapshot>> | undefined;
  if (page.isClosed()) {
    lines.push("The tab closed.");
  } else if (pending) {
    lines.push(
      `${stillLoadingLine(watch.request?.url() ?? page.url(), Date.now() - actedAt)}: the server has not answered yet. The action went through, so do not repeat it; wait_for or snapshot shows the page once it arrives.`,
    );
  } else {
    if (options.includeSnapshot || snapshotBefore !== undefined) await settleRendering(page);
    if (snapshotBefore !== undefined && !moved)
      snapshotAfter = await takeSnapshot(tab).catch(() => undefined);
    const framesMoved = moved ? [] : movedFrameLines(frameUrls);
    const outcome = moved
      ? `${await landedLine(tab, watch)}${state === "loading" ? " The page is still loading." : ""}`
      : await changeLine(
          tab,
          { armed, visibilityArmed, snapshotBefore, snapshotAfter: snapshotAfter?.text },
          framesMoved.length ? "" : options.noChangeText,
        );
    if (outcome) lines.push(outcome);
    lines.push(...framesMoved);
    checkpoint();
    const document = currentDocument(tab);
    lines.push(
      ...(await landingLines(manager, tab, {
        previousUrl: urlBefore,
        status: document?.status,
        redirected: watch.navigated && document?.redirected === true,
        widgetClicked: options.widgetClicked,
      })),
    );
  }
  checkpoint();
  lines.push(...drainEvents(tab, startedAt));

  if (page.isClosed() || pending) return lines.join("\n");
  if (options.includeSnapshot) {
    lines.push(
      "",
      await renderSnapshot(manager, store, tab, { maxChars: options.snapshotMaxChars ?? 12_000 }),
    );
  } else if (snapshotBefore !== undefined && moved) {
    lines.push(
      "",
      "The page navigated, so there is no line diff; take a snapshot of the new page.",
    );
  } else if (snapshotBefore !== undefined) {
    const after = snapshotAfter ?? (await takeSnapshot(tab));
    const diff = diffSnapshots(snapshotBefore, after.text, DIFF_MAX_LINES);
    await manager.rememberRefs(tab, after.text, { ...after.issue, only: shownRefs(diff) });
    lines.push("", diff);
  }
  return lines.join("\n");
}
