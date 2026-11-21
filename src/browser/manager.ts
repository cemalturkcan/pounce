import type { BrowserContext, Locator, Page } from "playwright-core";
import { mkdir } from "node:fs/promises";
import type { Config, ConsoleHookMode } from "../config/config.ts";
import { inSequence, sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import { logEvent } from "../log/logger.ts";
import { parseRef } from "./ref.ts";
import { launchOptions, loadChromium, sandboxLaunchError } from "./launch.ts";
import { installConsoleHook, installPasskeyHook, PASSKEY_KEY } from "./page-hooks.ts";
import { clearStaleProfileLock } from "./profile-lock.ts";
import { ProfileSettings } from "./profile-settings.ts";
import {
  ORPHANED_OWNER,
  pushBounded,
  pushEvent,
  runningActions,
  type Tab,
  type TabAction,
  UNCLAIMED_OWNER,
} from "./tab.ts";
import { describeMissingTab, TabCounter, TabHistory } from "./tab-ids.ts";
import { type TabHost, watchTab } from "./tab-watch.ts";

const CLOSE_TIMEOUT_MS = 10_000;
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const DOWNLOAD_START_MS = 3000;
const DOWNLOAD_SAVE_MS = 60_000;
const ORPHAN_IDLE_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_MS = 5 * 60 * 1000;

export class BrowserManager {
  readonly config: Config;
  readonly profile = new ProfileSettings();
  private contextPromise?: Promise<BrowserContext>;
  private context?: BrowserContext;
  private readonly tabs = new Map<string, Tab>();
  private readonly endedOwners = new Set<string>();
  private readonly workingOwners = new Map<string, number>();
  private readonly byPage = new WeakMap<Page, Tab>();
  private readonly history: TabHistory;
  private readonly recentPages: { at: number; page: Page }[] = [];
  private readonly ids: TabCounter;
  private browserVersion?: string;
  private closing: Promise<unknown> = Promise.resolve();
  private launches = 0;
  private shuttingDown = false;
  private readonly host: TabHost;

  constructor(config: Config) {
    this.config = config;
    this.host = {
      config,
      profile: this.profile,
      allTabs: () => this.listTabs(),
      pageChanged: () => this.history.changed(),
      closed: (tab) => this.onClose(tab),
      popupOpenedSince: (at, opener) =>
        this.recentPages.some(
          (entry) => entry.at >= at && entry.page !== opener && !entry.page.isClosed(),
        ),
    };
    this.ids = new TabCounter(config.dataDir);
    this.history = new TabHistory(config.dataDir, () =>
      this.listTabs().map((tab) => ({ id: tab.id, url: tab.page.url(), title: tab.title })),
    );
    setInterval(() => {
      if (this.running) void this.closeIdleOrphans().catch(() => undefined);
    }, ORPHAN_SWEEP_MS).unref();
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

  private get consoleHookMode(): ConsoleHookMode {
    return this.config.engine === "playwright" ? "off" : this.config.consoleHook;
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
    await context.addInitScript(installConsoleHook, this.consoleHookMode);
    await context.addInitScript(installPasskeyHook, PASSKEY_KEY);
    await this.profile.apply(context);

    this.context = context;
    this.browserVersion = context.browser()?.version();
    context.on("close", () => this.reset());
    context.on("page", (page) => this.adopt(page));
    for (const page of context.pages()) this.adopt(page);
    return context;
  }

  private reset() {
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

    pushBounded(this.recentPages, { at: Date.now(), page }, 20);
    for (const other of this.tabs.values())
      for (const check of other.popupChecks) check.finish(false);
    const tab: Tab = {
      id: this.ids.next(),
      page,
      owner: UNCLAIMED_OWNER,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      console: [],
      network: [],
      events: [],
      rules: [],
      ruleCounter: 0,
      loads: 0,
      popupChecks: new Set(),
      downloads: [],
      actions: [],
    };
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    watchTab(tab, this.host);

    const openedAt = Date.now();
    const running = new Map(
      [...this.tabs.values()].map((candidate) => [candidate, [...candidate.actions]]),
    );
    void page
      .opener()
      .then((opener) => {
        const parent = opener ? this.byPage.get(opener) : undefined;
        if (!parent) return;
        if (tab.owner === UNCLAIMED_OWNER) tab.owner = parent.owner;
        tab.openerId = parent.id;
        if (parent.browse) tab.browse = parent.browse;
        const during = runningActions(parent.id, running.get(parent) ?? []);
        pushEvent(
          parent,
          `opened new tab ${tab.id} from ${parent.id} (${parent.page.url()}), ${during}`,
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
          `tab ${tab.id} (popup) closed, ${during}; this tab ${opener.id} is at ${opener.page.url()}`,
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
    return () => {
      const index = tab.actions.indexOf(action);
      if (index !== -1) tab.actions.splice(index, 1);
    };
  }

  peekTab(id: string) {
    const tab = this.tabs.get(id.trim());
    return tab && !tab.page.isClosed() ? tab : undefined;
  }

  movedSinceSeen(tab: Tab) {
    const url = tab.page.url();
    return tab.lastSeenUrl !== undefined && url !== tab.lastSeenUrl ? url : undefined;
  }

  markSeen(tab: Tab) {
    tab.lastUsedAt = Date.now();
    if (!tab.page.isClosed()) tab.lastSeenUrl = tab.page.url();
  }

  listTabs() {
    return [...this.tabs.values()];
  }

  getTab(id: string) {
    const tab = this.tabs.get(id.trim());
    if (tab && !tab.page.isClosed()) return tab;
    const open = this.listTabs()
      .map((candidate) => `${candidate.id} (${candidate.page.url()})`)
      .join(", ");
    throw new ToolError(
      describeMissingTab(id.trim(), this.history.find(id.trim())),
      open ? `Open tabs: ${open}.` : "No tabs are open. Use tab_open to create one.",
    );
  }

  tabOf(page: Page) {
    return this.byPage.get(page);
  }

  async openTab(owner: string) {
    const context = await this.ensureContext();
    const blank = await this.claimBlankTab(this.listTabs(), owner);
    const tab = blank ?? this.adopt(await context.newPage());
    tab.owner = owner;
    tab.lastSeenUrl = undefined;
    return tab;
  }

  private async claimBlankTab(candidates: Tab[], owner: string): Promise<Tab | undefined> {
    const [candidate, ...rest] = candidates;
    if (!candidate) return undefined;
    if (
      (candidate.owner !== UNCLAIMED_OWNER && candidate.owner !== ORPHANED_OWNER) ||
      candidate.openingForUser ||
      candidate.page.isClosed() ||
      candidate.page.url() !== "about:blank"
    )
      return this.claimBlankTab(rest, owner);
    const previousOwner = candidate.owner;
    candidate.owner = owner;
    if (await candidate.page.opener().catch(() => null)) {
      candidate.owner = previousOwner;
      return this.claimBlankTab(rest, owner);
    }
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
    if (open.length <= 1 || open.every((page) => page === tab.page)) await context.newPage();
    tab.closingByTool = true;
    if (runBeforeUnload && (await this.closeAskingPage(tab)) === "kept") {
      tab.closingByTool = false;
      throw new ToolError(
        `Tab ${id} was not closed: the page asked to confirm leaving (unsaved changes).`,
        "Call tab_close again with force: true to close it anyway and lose the changes, or finish or save the work in the page first.",
      );
    }
    if (tab.page.isClosed()) return;
    const closed = await withDeadline(tab.page.close(), CLOSE_TIMEOUT_MS);
    if (closed === TIMED_OUT)
      throw new ToolError(
        `Tab ${id} did not close within ${CLOSE_TIMEOUT_MS / 1000} s.`,
        "The page may be busy; try again or check tabs_list.",
      );
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
    return ref ? tab.page.getByRef(ref) : tab.page.locator(target);
  }

  async resolve(tab: Tab, target: string) {
    const locator = this.locate(tab, target);
    const ref = parseRef(target);
    if (!ref) return locator;
    const count = await locator.count().catch((cause: unknown) => {
      if (cause instanceof Error && /Invalid frame in aria-ref selector/.test(cause.message))
        return 0;
      throw cause;
    });
    if (count > 0) return locator;
    if (tab.snapshotLoads !== undefined && tab.snapshotLoads !== tab.loads) {
      throw new ToolError(
        `Ref ${ref} is from a snapshot taken before tab ${tab.id} loaded a new page (navigation or reload); refs from before a page load no longer work.`,
        "Take a new snapshot and use a ref from it.",
      );
    }
    throw new ToolError(
      `Ref ${ref} is not in the latest snapshot of tab ${tab.id}.`,
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
