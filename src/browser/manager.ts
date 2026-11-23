import type { BrowserContext, CDPSession, Frame, Locator, Page } from "playwright-core";
import { mkdir } from "node:fs/promises";
import type { Config, Engine } from "../config/config.ts";
import { inSequence, sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import { shownUrl } from "../shared/output.ts";
import { recordSelector } from "../shared/call-scope.ts";
import { logEvent } from "../log/logger.ts";
import { dropOldLoads, type IssuedRef, parseRef, type RefIdentity, refIdentities } from "./ref.ts";
import {
  boundPlace,
  boundRef,
  checkInsideFrame,
  checkRefIdentity,
  confirmRef,
  filterRef,
  type FilterRoot,
  FRAME_PLACE_MS,
  nextShowing,
  probedRef,
  type RefQuestion,
  type Shown,
  refBound,
  refFromEarlierPage,
} from "./ref-check.ts";
import { launchOptions, loadChromium, sandboxLaunchError } from "./launch.ts";
import { belongsElsewhere, nextFrame, RenderKeeper } from "./foreground.ts";
import {
  ConsoleHookScript,
  consoleHookMode,
  installPasskeyHook,
  PASSKEY_KEY,
} from "./page-hooks.ts";
import { consoleCaptureSites, setConsoleCapture } from "../page/sites.ts";
import { pageSession } from "./page-session.ts";
import { clearStaleProfileLock } from "./profile-lock.ts";
import { ProfileSettings } from "./profile-settings.ts";
import {
  movedTo,
  ORPHANED_OWNER,
  pushBounded,
  pushEvent,
  runningActions,
  type Tab,
  type TabAction,
  UNCLAIMED_OWNER,
} from "./tab.ts";
import { describeMissingTab, TabCounter, TabHistory } from "./tab-ids.ts";
import { type TabHost, watchDialogs, watchTab } from "./tab-watch.ts";

const CLOSE_TIMEOUT_MS = 10_000;
export const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const DOWNLOAD_START_MS = 3000;
const DOWNLOAD_SAVE_MS = 60_000;
const ORPHAN_IDLE_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_MS = 5 * 60 * 1000;
const BEHIND_MARKER = "about:blank#web-agent-behind-";

export const DRAW_WAIT_MS = 1000;

export class BrowserManager {
  readonly config: Config;
  readonly profile = new ProfileSettings();
  private contextPromise?: Promise<BrowserContext>;
  private browserSession?: Promise<CDPSession>;
  private context?: BrowserContext;
  private readonly tabs = new Map<string, Tab>();
  private readonly endedOwners = new Set<string>();
  private readonly workingOwners = new Map<string, number>();
  private readonly byPage = new WeakMap<object, Tab>();
  private readonly history: TabHistory;
  private readonly openedPopups: { at: number; openerId: string; page: Page }[] = [];
  private readonly openedTargets: { at: number; openerTargetId: string; targetId: string }[] = [];
  private readonly openingBehind = new Map<string, (tab: Tab) => void>();
  private behindOpens = 0;
  private readonly ids: TabCounter;
  private browserVersion?: string;
  private closing: Promise<unknown> = Promise.resolve();
  private launches = 0;
  private shuttingDown = false;
  private readonly host: TabHost;
  private readonly rendering = new RenderKeeper();
  private readonly consoleHook: ConsoleHookScript;

  constructor(config: Config) {
    this.config = config;
    this.host = {
      config,
      profile: this.profile,
      allTabs: () => this.listTabs(),
      pageChanged: () => this.history.changed(),
      closed: (tab) => this.onClose(tab),
      popupSince: (at, opener) => {
        if (
          this.openedPopups.some(
            (entry) => entry.at >= at && entry.openerId === opener.id && !entry.page.isClosed(),
          )
        )
          return "listed";
        const opening = this.openedTargets.some(
          (entry) => entry.at >= at && entry.openerTargetId === opener.targetId,
        );
        return opening ? "opening" : undefined;
      },
    };
    this.consoleHook = new ConsoleHookScript(consoleHookMode(config));
    this.ids = new TabCounter(config.dataDir);
    this.history = new TabHistory(config.dataDir, () =>
      this.listTabs().map((tab) => ({ id: tab.id, url: tab.page.url(), title: tab.title })),
    );
    setInterval(() => {
      if (this.running) void this.closeIdleOrphans().catch(() => undefined);
    }, ORPHAN_SWEEP_MS).unref();
  }

  async consoleSites() {
    return this.running ? this.consoleHook.sites : consoleCaptureSites(this.config.sitesDir);
  }

  async setConsoleCapture(host: string, on: boolean) {
    const site = await setConsoleCapture(this.config.sitesDir, host, on);
    await this.consoleHook.choose(() => consoleCaptureSites(this.config.sitesDir));
    return site;
  }

  get running() {
    return this.context !== undefined;
  }

  get version() {
    return this.browserVersion;
  }

  ensureContext() {
    this.contextPromise ??= this.launchLogged();
    return this.contextPromise;
  }

  private async launchLogged() {
    const startedAt = Date.now();
    this.shuttingDown = false;
    if (this.launches > 0) logEvent("browser_relaunch", { launches: this.launches });
    try {
      const context = await this.launch();
      this.launches += 1;
      logEvent("browser_launch", {
        chrome: this.browserVersion,
        engine: this.config.engine,
        headless: this.config.headless,
        ms: Date.now() - startedAt,
        tabs: this.tabs.size,
      });
      return context;
    } catch (error) {
      this.contextPromise = undefined;
      logEvent(
        "browser_launch_failed",
        {
          engine: this.config.engine,
          ms: Date.now() - startedAt,
          error:
            error instanceof Error
              ? error.message.split("\n").slice(0, 3).join("\n")
              : String(error),
          stack:
            error instanceof Error ? error.stack?.split("\n").slice(0, 12).join("\n") : undefined,
        },
        "error",
      );
      throw error;
    }
  }

  private async launch() {
    const { config } = this;
    await mkdir(config.profileDir, { recursive: true });
    const chromium = await loadChromium(config.engine);
    const lock = await clearStaleProfileLock(config.profileDir);
    if (lock === "cleared")
      logEvent("profile_lock_cleared", { profileDir: config.profileDir }, "warn");
    if (lock === "in-use")
      logEvent("profile_lock_in_use", { profileDir: config.profileDir }, "warn");
    const context = await chromium
      .launchPersistentContext(config.profileDir, launchOptions(config))
      .catch((cause: unknown) => {
        throw sandboxLaunchError(cause, config.chromeSandbox) ?? cause;
      });

    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await this.consoleHook.apply(context, await consoleCaptureSites(config.sitesDir));
    await context.addInitScript(installPasskeyHook, PASSKEY_KEY);
    await this.profile.apply(context);

    this.context = context;
    this.browserVersion = context.browser()?.version();
    context.on("close", () => this.reset());
    context.on("page", (page) => this.adopt(page));
    watchDialogs(context, (page) => this.adopt(page));
    for (const page of context.pages()) this.adopt(page);
    await this.watchOpenedTargets(context).catch((cause: unknown) =>
      logEvent("target_watch_failed", { error: messageOf(cause) }, "warn"),
    );
    return context;
  }

  private async watchOpenedTargets(context: BrowserContext) {
    const browser = context.browser();
    if (!browser) return;
    const session = await this.browserCDPSession(browser);
    session.on("Target.targetCreated", ({ targetInfo }) => {
      if (targetInfo.type !== "page" || !targetInfo.openerId) return;
      pushBounded(
        this.openedTargets,
        { at: Date.now(), openerTargetId: targetInfo.openerId, targetId: targetInfo.targetId },
        20,
      );
    });
    session.on("Target.targetDestroyed", ({ targetId }) => {
      const index = this.openedTargets.findIndex((entry) => entry.targetId === targetId);
      if (index !== -1) this.openedTargets.splice(index, 1);
    });
    await session.send("Target.setDiscoverTargets", { discover: true });
  }

  private reset() {
    this.browserSession = undefined;
    this.consoleHook.forget();
    if (this.shuttingDown) logEvent("browser_closed", { reason: "shutdown" });
    else logEvent("browser_closed", { reason: "unexpected", tabs: this.tabs.size }, "warn");
    this.context = undefined;
    this.contextPromise = undefined;
    for (const tab of this.tabs.values())
      this.history.closed(
        { id: tab.id, url: tab.page.url(), title: tab.title },
        this.shuttingDown ? "restart" : "closed-outside",
      );
    this.tabs.clear();
  }

  private adopt(page: Page) {
    const existing = this.byPage.get(page);
    if (existing) return existing;

    const session = pageSession(page);
    void session
      .then((opened) => opened.send("Target.getTargetInfo"))
      .then(({ targetInfo }) => {
        tab.targetId = targetInfo.targetId;
      })
      .catch(() => undefined);
    const tab: Tab = {
      id: this.ids.next(),
      page,
      session,
      owner: UNCLAIMED_OWNER,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      console: [],
      consoleSeq: 0,
      consoleReads: new Map(),
      documents: [],
      currentDocument: 0,
      network: [],
      pending: new Map(),
      events: [],
      rules: [],
      ruleCounter: 0,
      loads: 0,
      routes: 0,
      refs: new Map(),
      popupChecks: new Set(),
      downloads: [],
      actions: [],
      dialogsOpened: 0,
      dialogsClosed: 0,
      dialogsHeld: 0,
      dialogWatchers: new Set(),
    };
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    watchTab(tab, this.host);
    const url = page.url();
    if (url.startsWith(BEHIND_MARKER)) {
      const opened = this.openingBehind.get(url);
      if (opened) opened(tab);
      else {
        tab.closingByTool = true;
        void page.close().catch(() => undefined);
      }
      return tab;
    }

    const openedAt = Date.now();
    const running = new Map(
      [...this.tabs.values()].map((candidate) => [candidate, [...candidate.actions]]),
    );
    void page
      .opener()
      .then((opener) => {
        const parent = opener ? this.byPage.get(opener) : undefined;
        if (parent && tab.owner === UNCLAIMED_OWNER) tab.owner = parent.owner;
        if (!parent) return;
        tab.openerId = parent.id;
        pushBounded(this.openedPopups, { at: tab.createdAt, openerId: parent.id, page }, 20);
        if (parent.browse) tab.browse = parent.browse;
        if (parent.unattended) tab.unattended = parent.unattended;
        const during = runningActions(parent.id, running.get(parent) ?? []);
        pushEvent(
          parent,
          `opened new tab ${tab.id} from ${parent.id} (${shownUrl(parent.page.url())}), ${during}`,
          { at: openedAt, stamped: true },
        );
      })
      .catch(() => undefined);

    return tab;
  }

  private onClose(tab: Tab) {
    this.tabs.delete(tab.id);
    for (const check of tab.popupChecks) check.finish(false);
    if (!tab.closingByTool && !this.shuttingDown)
      logEvent("tab_closed_outside", { tab: tab.id, owner: tab.owner, url: tab.page.url() });
    this.history.closed(
      { id: tab.id, url: tab.page.url(), title: tab.title },
      this.shuttingDown ? "restart" : tab.closingByTool ? "closed" : "closed-outside",
    );
    const opener = tab.openerId ? this.tabs.get(tab.openerId) : undefined;
    if (opener && !opener.page.isClosed()) {
      const during = runningActions(opener.id, opener.actions);
      pushEvent(
        opener,
        () =>
          `tab ${tab.id} (popup) closed, ${during}; this tab ${opener.id} is at ${shownUrl(opener.page.url())}`,
        { stamped: true },
      );
    }
  }

  async downloadSince(tab: Tab, since: number) {
    const find = () => tab.downloads.find((entry) => entry.at >= since);
    if (!find() && !tab.page.isClosed())
      await tab.page
        .waitForEvent("download", { timeout: DOWNLOAD_START_MS })
        .catch(() => undefined);
    const entry = find();
    if (!entry) return undefined;
    const saved = await withDeadline(entry.saving, DOWNLOAD_SAVE_MS).catch((error: Error) => error);
    if (saved === TIMED_OUT)
      return {
        name: entry.name,
        note: `is still downloading after ${DOWNLOAD_SAVE_MS / 1000} s; the result is reported as an event when it finishes`,
      };
    if (saved instanceof Error)
      return { name: entry.name, note: `failed: ${saved.message.split("\n")[0]}` };
    return { name: entry.name, file: saved };
  }

  async settlePopups(tab: Tab) {
    await Promise.all([...tab.popupChecks].map((check) => check.done));
  }

  beginAction(tab: Tab, tool: string, owner: string) {
    const action: TabAction = { tool, owner };
    tab.actions.push(action);
    const release = this.holdRendering(tab);
    return () => {
      release();
      const index = tab.actions.indexOf(action);
      if (index !== -1) tab.actions.splice(index, 1);
    };
  }

  holdRendering(tab: Tab) {
    return this.rendering.hold(tab);
  }

  async untilDrawn(tab: Tab) {
    if (this.rendering.drawing(tab)) return true;
    const dialogs = tab.dialogsOpened;
    const drawn = await withDeadline(
      this.rendering
        .started(tab)
        .then(async () => nextFrame(await tab.session))
        .then(
          () => true,
          () => !tab.page.isClosed(),
        ),
      DRAW_WAIT_MS,
    );
    if (drawn === TIMED_OUT) {
      if (tab.dialogsOpened === dialogs)
        logEvent("tab_not_drawn", { tab: tab.id, ms: DRAW_WAIT_MS }, "warn");
      return false;
    }
    if (drawn) this.rendering.drew(tab);
    return drawn;
  }

  peekTab(id: string) {
    const tab = this.tabs.get(id.trim());
    return tab && !tab.page.isClosed() ? tab : undefined;
  }

  movedSinceSeen(tab: Tab) {
    return movedTo(tab.lastSeenUrl, tab.page.url(), tab.document?.url);
  }

  markSeen(tab: Tab, seenUrl?: string) {
    tab.lastUsedAt = Date.now();
    if (!tab.page.isClosed()) tab.lastSeenUrl = seenUrl ?? tab.page.url();
  }

  listTabs() {
    return [...this.tabs.values()];
  }

  getTab(id: string) {
    const tab = this.tabs.get(id.trim());
    if (tab && !tab.page.isClosed()) return tab;
    const open = this.listTabs()
      .map((candidate) => `${candidate.id} (${shownUrl(candidate.page.url())})`)
      .join(", ");
    throw new ToolError(
      describeMissingTab(id.trim(), this.history.find(id.trim())),
      open ? `Open tabs: ${open}.` : "No tabs are open. Use navigate without tab to open one.",
    );
  }

  tabOf<Candidate extends object>(candidate: Candidate) {
    return this.byPage.get(candidate);
  }

  async openTab(owner: string) {
    const context = await this.ensureContext();
    const blank = await this.claimBlankTab(this.listTabs(), owner);
    const tab = blank ?? (await this.openBehind(context, owner));
    tab.owner = owner;
    tab.lastSeenUrl = undefined;
    return tab;
  }

  private async openBehind(context: BrowserContext, owner: string) {
    const browser = context.browser();
    if (!browser) {
      const tab = this.adopt(await context.newPage());
      tab.owner = owner;
      return tab;
    }
    this.behindOpens += 1;
    const marker = `${BEHIND_MARKER}${this.behindOpens}`;
    const adopted = new Promise<Tab>((resolve) => this.openingBehind.set(marker, resolve));
    try {
      await (
        await this.browserCDPSession(browser)
      ).send("Target.createTarget", { url: marker, background: true });
      const tab = await withDeadline(adopted, ACTION_TIMEOUT_MS);
      if (tab === TIMED_OUT)
        throw new ToolError(
          `The new tab did not open within ${ACTION_TIMEOUT_MS / 1000} s.`,
          "Try again; tabs shows the tabs that are open.",
        );
      tab.owner = owner;
      await tab.page.evaluate(() => history.replaceState(null, "", "about:blank"));
      return tab;
    } finally {
      this.openingBehind.delete(marker);
    }
  }

  private browserCDPSession(browser: NonNullable<ReturnType<BrowserContext["browser"]>>) {
    const session = this.browserSession ?? browser.newBrowserCDPSession();
    this.browserSession = session;
    session.catch(() => {
      if (this.browserSession === session) this.browserSession = undefined;
    });
    return session;
  }

  private async claimBlankTab(candidates: Tab[], owner: string): Promise<Tab | undefined> {
    const [candidate, ...rest] = candidates;
    if (!candidate) return undefined;
    if (
      !isBlankForAnyone(candidate) ||
      (await belongsElsewhere(candidate)) ||
      !isBlankForAnyone(candidate)
    )
      return this.claimBlankTab(rest, owner);
    candidate.owner = owner;
    return candidate;
  }

  async openForUser(url: string | undefined) {
    if (this.contextPromise) {
      await this.contextPromise;
      return { launched: false, running: true };
    }
    const context = await this.ensureContext();
    const blank = this.listTabs().find(
      (tab) =>
        tab.owner === UNCLAIMED_OWNER &&
        !tab.openingForUser &&
        !tab.page.isClosed() &&
        tab.page.url() === "about:blank",
    );
    const tab = blank ?? this.adopt(await context.newPage());
    const target = url ?? "chrome://newtab/";
    tab.openingForUser = true;
    let error: string | undefined;
    try {
      await tab.page.goto(target, { waitUntil: "commit" });
    } catch (cause) {
      error = messageOf(cause).split("\n")[0];
    } finally {
      tab.openingForUser = false;
    }
    logEvent("launcher_open", { tab: tab.id, url: target, error }, error ? "warn" : "info");
    const opened = { launched: true, running: false, tab: tab.id, url: tab.page.url() };
    return error ? { ...opened, error } : opened;
  }

  closeTab(id: string, options: { runBeforeUnload?: boolean } = {}) {
    const run = this.closing.then(() => this.closeNow(id, options.runBeforeUnload ?? false));
    this.closing = run.catch(() => undefined);
    return run;
  }

  private async closeNow(id: string, runBeforeUnload: boolean) {
    const tab = this.getTab(id);
    const context = await this.ensureContext();
    const open = context.pages().filter((page) => !page.isClosed());
    if (open.length <= 1 || open.every((page) => page === tab.page)) await this.openKeeper(context);
    tab.closingByTool = true;
    if (runBeforeUnload && !tab.dialog && (await this.closeAskingPage(tab)) === "kept") {
      tab.closingByTool = false;
      throw new ToolError(
        `Tab ${id} was not closed: the page asked to confirm leaving (unsaved changes).`,
        "Call tabs again with close and force: true to close it anyway and lose the changes, or finish or save the work in the page first.",
      );
    }
    if (tab.page.isClosed()) return;
    const closed = await withDeadline(tab.page.close(), CLOSE_TIMEOUT_MS);
    if (closed === TIMED_OUT)
      throw new ToolError(
        `Tab ${id} did not close within ${CLOSE_TIMEOUT_MS / 1000} s.`,
        "The page may be busy; try again or check tabs.",
      );
  }

  private async openKeeper(context: BrowserContext) {
    try {
      await this.openBehind(context, UNCLAIMED_OWNER);
    } catch (cause) {
      logEvent("keeper_tab_behind_failed", { error: messageOf(cause) }, "warn");
      this.adopt(await context.newPage());
    }
  }

  private async closeAskingPage(tab: Tab) {
    let onClose: (() => void) | undefined;
    const outcome = new Promise<"closed" | "kept">((resolve) => {
      const closed = () => resolve("closed");
      onClose = closed;
      tab.unload = { force: false, onBlocked: () => resolve("kept") };
      tab.page.once("close", closed);
    });
    try {
      await tab.page.close({ runBeforeUnload: true });
      return await withDeadline(outcome, CLOSE_TIMEOUT_MS / 2);
    } finally {
      if (onClose) tab.page.off("close", onClose);
      tab.unload = undefined;
    }
  }

  claimIfOrphaned(id: string, owner: string) {
    this.endedOwners.delete(owner);
    const tab = this.tabs.get(id.trim());
    if (tab?.owner !== ORPHANED_OWNER) return;
    tab.owner = owner;
    tab.orphanedAt = undefined;
  }

  beginWork(owner: string) {
    this.workingOwners.set(owner, (this.workingOwners.get(owner) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.workingOwners.get(owner) ?? 1) - 1;
      if (left > 0) {
        this.workingOwners.set(owner, left);
        return;
      }
      this.workingOwners.delete(owner);
      if (this.endedOwners.delete(owner)) this.orphanOwnedTabs(owner);
    };
  }

  orphanTabsOf(owner: string) {
    if (this.workingOwners.has(owner)) this.endedOwners.add(owner);
    return this.orphanOwnedTabs(owner);
  }

  private orphanOwnedTabs(owner: string) {
    let count = 0;
    for (const tab of this.tabs.values()) {
      if (tab.owner !== owner) continue;
      tab.owner = ORPHANED_OWNER;
      tab.orphanedAt = Date.now();
      count += 1;
    }
    return count;
  }

  async closeIdleOrphans(now = Date.now()) {
    const idle = this.listTabs().filter(
      (tab) =>
        tab.owner === ORPHANED_OWNER &&
        now - Math.max(tab.orphanedAt ?? 0, tab.lastUsedAt) > ORPHAN_IDLE_MS,
    );
    const outcomes = await inSequence(idle, async (tab) => {
      const url = tab.page.url();
      const idleMinutes = Math.round(
        (now - Math.max(tab.orphanedAt ?? 0, tab.lastUsedAt)) / 60_000,
      );
      try {
        await this.closeTab(tab.id);
        logEvent("orphan_tab_closed", { tab: tab.id, url, idleMinutes });
        return true;
      } catch (cause) {
        logEvent("orphan_tab_close_failed", { tab: tab.id, url, error: messageOf(cause) }, "warn");
        return false;
      }
    });
    return outcomes.filter(Boolean).length;
  }

  locate(tab: Tab, target: string): Locator {
    const ref = parseRef(target);
    if (ref) return this.locateIssued(tab, ref, this.issued(tab, ref), target);
    const locator = tab.page.locator(target);
    recordSelector(String(locator), target);
    return locator;
  }

  issued(tab: Tab, ref: string) {
    return tab.refs.get(ref) ?? this.unissued(tab, ref);
  }

  locateIssued(tab: Tab, ref: string, issued: IssuedRef, target = ref) {
    const locator = boundRef(tab, ref, issued);
    recordSelector(String(locator), target);
    return locator;
  }

  async resolve(tab: Tab, target: string, timeout = ACTION_TIMEOUT_MS) {
    const ref = parseRef(target);
    if (!ref) return this.locate(tab, target);
    return this.confirmIssued(tab, ref, this.issued(tab, ref), timeout, target);
  }

  async confirmIssued(
    tab: Tab,
    ref: string,
    issued: IssuedRef,
    timeout: number,
    target = ref,
    deadline = Date.now() + timeout,
  ) {
    const locator = await confirmRef(tab, ref, issued, timeout, deadline);
    recordSelector(String(locator), target);
    return locator;
  }

  locateProbed(tab: Tab, ref: string, issued: IssuedRef, shown: boolean, filter?: FilterRoot) {
    const locator = probedRef(tab, ref, issued, shown, filter);
    if (locator) recordSelector(String(locator), ref);
    return locator;
  }

  locateInFilter(tab: Tab, ref: string, issued: IssuedRef, root?: Frame) {
    const locator = filterRef(tab, ref, issued, root);
    recordSelector(String(locator), ref);
    return locator;
  }

  checkIssued(tab: Tab, ref: string, issued: IssuedRef, question: RefQuestion) {
    return checkRefIdentity(tab, ref, issued, question);
  }

  checkInsideIssued(tab: Tab, ref: string, issued: IssuedRef) {
    return checkInsideFrame(tab, ref, issued);
  }

  async checkInside(tab: Tab, target: string) {
    const ref = parseRef(target);
    if (ref) await this.checkInsideIssued(tab, ref, this.issued(tab, ref));
  }

  async absenceReady(tab: Tab, ref: string, issued: IssuedRef) {
    if (issued.loads !== tab.loads) return false;
    await refBound(ref, issued);
    return true;
  }

  async waitForAbsence(tab: Tab, target: string, state: "hidden" | "detached", timeout: number) {
    const ref = parseRef(target);
    if (!ref) return (await this.resolve(tab, target, timeout)).waitFor({ state, timeout });
    const issued = this.issued(tab, ref);
    if (await this.absenceReady(tab, ref, issued))
      await boundRef(tab, ref, issued).waitFor({ state, timeout });
  }

  async rememberRefs(tab: Tab, snapshot: string, issue: RefIssue) {
    const identities = refIdentities(snapshot);
    const token = nextShowing();
    const places = await placesOf(tab.page, identities, token, this.config.engine);
    dropOldLoads(tab.refs, issue.loads);
    for (const [ref, identity] of identities) {
      if (issue.only && !issue.only.has(ref)) continue;
      const shown = places.shownFor(identity);
      tab.refs.set(ref, {
        ...identity,
        loads: issue.loads,
        url: issue.url,
        document: shown?.place.document,
        href: shown?.place.href,
        bound: shown?.bound ?? Promise.resolve(false),
        token,
        path: framePath(identities, identity.frameRef),
        content: places.inside(ref),
      });
    }
  }

  private unissued(tab: Tab, ref: string): never {
    if (tab.snapshotLoads !== undefined && tab.snapshotLoads !== tab.loads)
      throw refFromEarlierPage(tab, ref);
    const givers = this.listTabs().filter((other) => other !== tab && other.refs.has(ref));
    const giver = givers.length === 1 ? givers[0] : undefined;
    throw new ToolError(
      `Ref ${ref} is not in the latest snapshot of tab ${tab.id}${giver ? `; it came from a snapshot of tab ${giver.id}` : ""}.`,
      "Refs are valid until the element changes or the page loads again. Take a new snapshot and use a ref from it.",
    );
  }

  async shutdown() {
    const context = this.context;
    if (!context) return;
    this.shuttingDown = true;
    this.history.flush();
    await Promise.race([context.close().catch(() => undefined), sleep(SHUTDOWN_TIMEOUT_MS)]);
    this.history.flush();
  }
}

export type RefIssue = {
  loads: number;
  url: string;
  only?: ReadonlySet<string>;
};

async function framePlace(page: Page, ref: string, showing: string, engine: Engine) {
  const handle = await page.getByRef(ref).elementHandle({ timeout: FRAME_PLACE_MS });
  try {
    const frame = await handle.contentFrame();
    return frame ? await boundPlace(frame, showing, engine) : undefined;
  } finally {
    await handle.dispose();
  }
}

function framePath(identities: ReadonlyMap<string, RefIdentity>, frameRef?: string): string[] {
  if (!frameRef) return [];
  return [...framePath(identities, identities.get(frameRef)?.frameRef), frameRef];
}

async function placesOf(
  page: Page,
  identities: ReadonlyMap<string, RefIdentity>,
  showing: string,
  engine: Engine,
) {
  const refs = [...identities].flatMap(([ref, identity]) =>
    identity.role === "iframe" ? [ref] : [],
  );
  const lookups = refs.map(async (ref) => {
    const place = await withDeadline(framePlace(page, ref, showing, engine), FRAME_PLACE_MS).catch(
      () => undefined,
    );
    return [ref, place === TIMED_OUT ? undefined : place] as const;
  });
  const [main, found] = await Promise.all([
    boundPlace(page, showing, engine),
    Promise.all(lookups),
  ]);
  const frames = new Map<string, Shown>(
    found.flatMap(([ref, place]) => (place === undefined ? [] : [[ref, place] as const])),
  );
  return {
    shownFor: (identity: RefIdentity) => (identity.frameRef ? frames.get(identity.frameRef) : main),
    inside: (ref: string) => frames.get(ref)?.place,
  };
}

function isBlankForAnyone(tab: Tab) {
  return (
    (tab.owner === UNCLAIMED_OWNER || tab.owner === ORPHANED_OWNER) &&
    !tab.openingForUser &&
    !tab.page.isClosed() &&
    tab.page.url() === "about:blank"
  );
}
