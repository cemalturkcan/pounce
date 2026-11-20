import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, BrowserType, Dialog, Locator, Page, Request, Response, Route } from "playwright-core";
import type { Config } from "./config.ts";
import { TIMED_OUT, withDeadline } from "./async.ts";
import { ToolError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { isStreamingMime, isTextualMime } from "./mime.ts";
import { timestampSlug } from "./output.ts";
import { clearStaleProfileLock } from "./profile-lock.ts";
import { ProfileSettings } from "./profile-settings.ts";
import { parseRef } from "./snapshot.ts";
import { describeMissingTab, TabCounter, TabHistory } from "./tab-ids.ts";

const CONSOLE_LIMIT = 300;
const NETWORK_LIMIT = 1000;
const BODY_ENTRY_LIMIT = 1024 * 1024;
const BODY_TAB_BUDGET = 48 * 1024 * 1024;
const BODY_GLOBAL_BUDGET = 256 * 1024 * 1024;
const EVENT_LIMIT = 50;
const CLOSE_TIMEOUT_MS = 10_000;
export const UNCLAIMED_OWNER = "browser";
export const ORPHANED_OWNER = "orphaned";
const ACTION_TIMEOUT_MS = 8_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const POPUP_GRACE_MS = 600;
const DOWNLOAD_START_MS = 3000;
const DOWNLOAD_SAVE_MS = 60_000;
export const LEAVE_CANCELLED = "the page asked to confirm leaving (unsaved changes); navigation was cancelled. Call navigate again with force: true to leave anyway.";
const PASSKEY_KEY = "webAgent.passkey";
const ISOLATED_WORLD = "web-agent-isolated";
export const ORPHAN_IDLE_MS = 30 * 60 * 1000;
const ORPHAN_SWEEP_MS = 5 * 60 * 1000;

export type ConsoleEntry = {
  level: string;
  text: string;
  time: string;
};

export type NetworkEntry = {
  id: number;
  time: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  request: Request;
  response?: Response;
  body?: Buffer;
};

export type InterceptRule = {
  id: number;
  summary: string;
  hits: number;
  errors: number;
  lastError?: string;
  matcher: (url: URL) => boolean;
  handler: (route: Route) => Promise<void>;
};

export type Tab = {
  id: string;
  page: Page;
  owner: string;
  createdAt: number;
  lastUsedAt: number;
  orphanedAt?: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  events: TabEvent[];
  rules: InterceptRule[];
  ruleCounter: number;
  document?: { url: string; status: number; redirected: boolean };
  popupChecks: Set<PopupCheck>;
  downloads: { at: number; name: string; saving: Promise<string> }[];
  openerId?: string;
  lastSeenUrl?: string;
  title?: string;
  closingByTool?: boolean;
  captureBodies?: boolean;
  unload?: { force: boolean; onBlocked?: () => void };
};

type PopupCheck = { done: Promise<void>; finish: (blocked: boolean) => void };

export type TabEvent = { at: number; text: string | (() => string) };

export type ConsoleHookMode = "local" | "all" | "off";

function evictBodies(entries: NetworkEntry[], keep: NetworkEntry, budget: number) {
  let total = 0;
  for (const candidate of entries) total += candidate.body?.length ?? 0;
  for (const candidate of entries) {
    if (total <= budget) break;
    if (!candidate.body || candidate === keep) continue;
    total -= candidate.body.length;
    candidate.body = undefined;
  }
}

export function shouldRetainBody(tab: Pick<Tab, "owner" | "captureBodies">, headers: Record<string, string>) {
  if (tab.owner === UNCLAIMED_OWNER && !tab.captureBodies) return false;
  const contentType = headers["content-type"];
  if (!isTextualMime(contentType) || isStreamingMime(contentType)) return false;
  const length = Number(headers["content-length"]);
  return !(Number.isFinite(length) && length > BODY_ENTRY_LIMIT);
}

export function pushEvent(tab: Tab, text: string | (() => string)) {
  pushBounded(tab.events, { at: Date.now(), text }, EVENT_LIMIT);
}

function pushBounded<T>(list: T[], entry: T, limit: number) {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function installConsoleHook(mode: ConsoleHookMode) {
  const host = location.hostname;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || /\.(localhost|test)$/.test(host);
  if (mode === "off" || (mode === "local" && !isLocal)) return;
  const scope = window as unknown as { __webAgentConsole?: { level: string; text: string; time: string }[] };
  if (scope.__webAgentConsole) return;
  const buffer: { level: string; text: string; time: string }[] = [];
  scope.__webAgentConsole = buffer;
  const record = (level: string, parts: unknown[]) => {
    const text = parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part instanceof Error) return part.stack ?? part.message;
        try {
          return JSON.stringify(part);
        } catch {
          return String(part);
        }
      })
      .join(" ")
      .slice(0, 2000);
    buffer.push({ level, text, time: new Date().toISOString() });
    if (buffer.length > 300) buffer.shift();
  };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...parts: unknown[]) => {
      record(level, parts);
      original(...parts);
    };
  }
  window.addEventListener("error", (event) => record("error", [event.message, event.filename, event.lineno]));
  window.addEventListener("unhandledrejection", (event) => record("error", ["Unhandled rejection:", event.reason]));
}

function installPasskeyHook(key: string) {
  const scope = window as unknown as Record<symbol, string[] | undefined>;
  const symbol = Symbol.for(key);
  const container = (window as unknown as { CredentialsContainer?: { prototype: Record<string, unknown> } }).CredentialsContainer?.prototype;
  if (scope[symbol] || !container) return;
  const calls: string[] = [];
  Object.defineProperty(window, symbol, { value: calls });
  for (const method of ["get", "create"]) {
    const original = container[method];
    if (typeof original !== "function") continue;
    container[method] = new Proxy(original, {
      apply(target, thisArg, args: unknown[]) {
        const options = args[0] as { publicKey?: unknown; mediation?: string } | undefined;
        if (options && typeof options === "object" && options.publicKey && options.mediation !== "conditional") {
          calls.push(method);
          if (calls.length > 20) calls.shift();
        }
        return Reflect.apply(target as (...values: unknown[]) => unknown, thisArg, args);
      },
    });
  }
}

async function loadChromium(engine: Config["engine"]) {
  const module = engine === "patchright" ? await import("patchright") : await import("playwright-core");
  return module.chromium as unknown as BrowserType;
}

const SANDBOX_FAILURE = /no usable sandbox|setuid sandbox|suid sandbox|namespace/i;

export function sandboxLaunchError(error: unknown, sandbox: boolean) {
  if (!sandbox) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (!SANDBOX_FAILURE.test(message)) return undefined;
  const detail = message.split("\n").find((line) => SANDBOX_FAILURE.test(line))?.trim() ?? message;
  return new ToolError(
    `Chrome could not start its sandbox: ${detail.slice(0, 300)}`,
    "This kernel or container does not allow the Chrome sandbox (unprivileged user namespaces). Enable them, or restart the daemon with WEB_AGENT_CHROME_SANDBOX=false to launch Chrome without the sandbox.",
  );
}

export function launchOptions(config: Config) {
  return {
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    channel: config.executablePath ? undefined : config.channel,
    executablePath: config.executablePath,
    headless: config.headless,
    viewport: null,
    colorScheme: null,
    locale: config.locale,
    timezoneId: config.timezoneId,
    acceptDownloads: true,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--disable-sync"],
    chromiumSandbox: config.chromeSandbox,
    args: [`--password-store=${config.passwordStore}`, "--hide-crash-restore-bubble", "--test-type", ...config.extraArgs],
  };
}

export class BrowserManager {
  readonly config: Config;
  readonly profile = new ProfileSettings();
  private contextPromise?: Promise<BrowserContext>;
  private context?: BrowserContext;
  private readonly tabs = new Map<string, Tab>();
  private readonly byPage = new WeakMap<Page, Tab>();
  private readonly history: TabHistory;
  private readonly recentPages: { at: number; page: Page }[] = [];
  private readonly ids: TabCounter;
  private browserVersion?: string;
  private closing: Promise<unknown> = Promise.resolve();
  private launches = 0;
  private shuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.ids = new TabCounter(config.dataDir);
    this.history = new TabHistory(config.dataDir, () => this.listTabs().map((tab) => ({ id: tab.id, url: tab.page.url(), title: tab.title })));
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
      logEvent("browser_launch", { chrome: this.browserVersion, engine: this.config.engine, headless: this.config.headless, ms: Date.now() - startedAt, tabs: this.tabs.size });
      return context;
    } catch (error) {
      this.contextPromise = undefined;
      logEvent(
        "browser_launch_failed",
        { engine: this.config.engine, ms: Date.now() - startedAt, error: error instanceof Error ? error.message.split("\n").slice(0, 3).join("\n") : String(error), stack: error instanceof Error ? error.stack?.split("\n").slice(0, 12).join("\n") : undefined },
        "error",
      );
      throw error;
    }
  }

  private get consoleHookMode(): ConsoleHookMode {
    const value = process.env.WEB_AGENT_CONSOLE_HOOK;
    if (value === "all" || value === "off" || value === "local") return value;
    return this.config.engine === "playwright" ? "off" : "local";
  }

  private async launch() {
    const { config } = this;
    await mkdir(config.profileDir, { recursive: true });
    const chromium = await loadChromium(config.engine);
    const lock = await clearStaleProfileLock(config.profileDir);
    if (lock === "cleared") logEvent("profile_lock_cleared", { profileDir: config.profileDir }, "warn");
    if (lock === "in-use") logEvent("profile_lock_in_use", { profileDir: config.profileDir }, "warn");
    const context = await chromium.launchPersistentContext(config.profileDir, launchOptions(config)).catch((error: unknown) => {
      throw sandboxLaunchError(error, config.chromeSandbox) ?? error;
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
    for (const tab of this.tabs.values()) this.history.closed({ id: tab.id, url: tab.page.url(), title: tab.title }, this.shuttingDown ? "restart" : "closed-outside");
    this.tabs.clear();
  }

  private adopt(page: Page) {
    const existing = this.byPage.get(page);
    if (existing) return existing;

    pushBounded(this.recentPages, { at: Date.now(), page }, 20);
    for (const other of this.tabs.values()) for (const check of [...other.popupChecks]) check.finish(false);
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
      popupChecks: new Set(),
      downloads: [],
    };
    this.tabs.set(tab.id, tab);
    this.byPage.set(page, tab);
    this.attach(tab);

    void page
      .opener()
      .then((opener) => {
        const parent = opener ? this.byPage.get(opener) : undefined;
        if (!parent) return;
        if (tab.owner === UNCLAIMED_OWNER) tab.owner = parent.owner;
        tab.openerId = parent.id;
        pushEvent(parent, `opened new tab ${tab.id}`);
      })
      .catch(() => undefined);

    return tab;
  }

  private attach(tab: Tab) {
    const { page } = tab;
    let networkId = 0;

    page.on("close", () => this.onClose(tab));
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.history.changed();
    });
    page.on("load", () => {
      void page
        .title()
        .then((title) => {
          tab.title = title;
          this.history.changed();
        })
        .catch(() => undefined);
    });
    page.on("crash", () => {
      logEvent("tab_crash", { tab: tab.id, owner: tab.owner, url: page.url() }, "warn");
      pushEvent(tab, "the page crashed; reload it with navigate or close the tab");
    });
    page.on("console", (message) => {
      pushBounded(tab.console, { level: message.type(), text: message.text().slice(0, 2000), time: new Date().toISOString() }, CONSOLE_LIMIT);
    });
    page.on("pageerror", (error) => {
      pushBounded(tab.console, { level: "error", text: (error.stack ?? error.message).slice(0, 2000), time: new Date().toISOString() }, CONSOLE_LIMIT);
    });
    page.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload") {
        this.answerBeforeUnload(tab, dialog);
        return;
      }
      pushEvent(tab, `${dialog.type()} dialog "${dialog.message().slice(0, 300)}" was accepted automatically`);
      void dialog.accept(dialog.type() === "prompt" ? dialog.defaultValue() : undefined).catch(() => undefined);
    });
    page.on("download", (download) => {
      const fileName = `${timestampSlug()}-${download.suggestedFilename().replace(/[^\w.-]+/g, "_").slice(-120)}`;
      const target = path.join(this.config.outputDir, "downloads", fileName);
      const saving = mkdir(path.dirname(target), { recursive: true })
        .then(() => download.saveAs(target))
        .then(() => target);
      pushBounded(tab.downloads, { at: Date.now(), name: download.suggestedFilename(), saving }, 10);
      void saving
        .then(() => pushEvent(tab, `download saved to ${target}`))
        .catch((error: Error) => pushEvent(tab, `download of ${download.suggestedFilename()} failed: ${error.message.split("\n")[0]}`));
    });
    page.on("response", (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
        tab.document = { url: response.url(), status: response.status(), redirected: request.redirectedFrom() !== null };
      }
      networkId += 1;
      const entry: NetworkEntry = {
        id: networkId,
        time: new Date().toISOString(),
        method: request.method(),
        url: response.url(),
        resourceType: request.resourceType(),
        status: response.status(),
        request,
        response,
      };
      pushBounded(tab.network, entry, NETWORK_LIMIT);
      if (shouldRetainBody(tab, response.headers())) {
        void response
          .body()
          .then((body) => this.retainBody(tab, entry, body))
          .catch(() => undefined);
      }
    });
    this.watchPopups(tab);
    if (this.config.engine === "patchright") {
      page.on("request", (request) => {
        if (request.isNavigationRequest()) void this.profile.allowLocalNetwork(page.context(), request.url()).catch(() => undefined);
      });
    }
    page.on("requestfailed", (request) => {
      networkId += 1;
      pushBounded(
        tab.network,
        {
          id: networkId,
          time: new Date().toISOString(),
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          failure: request.failure()?.errorText ?? "failed",
          request,
        },
        NETWORK_LIMIT,
      );
    });
  }

  private onClose(tab: Tab) {
    this.tabs.delete(tab.id);
    for (const check of [...tab.popupChecks]) check.finish(false);
    if (!tab.closingByTool && !this.shuttingDown) logEvent("tab_closed_outside", { tab: tab.id, owner: tab.owner, url: tab.page.url() });
    this.history.closed({ id: tab.id, url: tab.page.url(), title: tab.title }, this.shuttingDown ? "restart" : tab.closingByTool ? "closed" : "closed-outside");
    const opener = tab.openerId ? this.tabs.get(tab.openerId) : undefined;
    if (opener && !opener.page.isClosed()) pushEvent(opener, () => `tab ${tab.id} (popup) closed; this tab is at ${opener.page.url()}`);
  }

  private answerBeforeUnload(tab: Tab, dialog: Dialog) {
    if (tab.unload?.force) {
      void dialog.accept().catch(() => undefined);
      return;
    }
    const onBlocked = tab.unload?.onBlocked;
    if (onBlocked) onBlocked();
    else pushEvent(tab, LEAVE_CANCELLED);
    void dialog.dismiss().catch(() => undefined);
  }

  private watchPopups(tab: Tab) {
    const { page } = tab;
    void page
      .context()
      .newCDPSession(page)
      .then(async (session) => {
        session.on("Page.windowOpen", (event) => {
          if (!event.userGesture) this.expectPopup(tab, event.url);
        });
        await session.send("Page.enable");
      })
      .catch(() => undefined);
  }

  private expectPopup(tab: Tab, url: string) {
    const openedAt = Date.now();
    const appeared = () => this.recentPages.some((entry) => entry.at >= openedAt - POPUP_GRACE_MS && entry.page !== tab.page && !entry.page.isClosed());
    let settle = () => undefined as void;
    const check: PopupCheck = {
      done: new Promise<void>((resolve) => (settle = resolve)),
      finish: (blocked) => {
        clearTimeout(timer);
        if (!tab.popupChecks.delete(check)) return;
        if (blocked) pushEvent(tab, `a popup was blocked (${url.slice(0, 200)}); if the page needs it, click the control that opens it`);
        settle();
      },
    };
    const timer = setTimeout(() => check.finish(!appeared()), POPUP_GRACE_MS);
    tab.popupChecks.add(check);
  }

  async downloadSince(tab: Tab, since: number) {
    const find = () => tab.downloads.find((entry) => entry.at >= since);
    if (!find() && !tab.page.isClosed()) await tab.page.waitForEvent("download", { timeout: DOWNLOAD_START_MS }).catch(() => undefined);
    const entry = find();
    if (!entry) return undefined;
    const saved = await withDeadline(entry.saving, DOWNLOAD_SAVE_MS).catch((error: Error) => error);
    if (saved === TIMED_OUT) return { name: entry.name, note: `is still downloading after ${DOWNLOAD_SAVE_MS / 1000} s; the result is reported as an event when it finishes` };
    if (saved instanceof Error) return { name: entry.name, note: `failed: ${saved.message.split("\n")[0]}` };
    return { name: entry.name, file: saved };
  }

  async settlePopups(tab: Tab) {
    await Promise.all([...tab.popupChecks].map((check) => check.done));
  }

  async drainPasskeyRequests(tab: Tab) {
    const calls = await withDeadline(
      this.evaluateMain<string[]>(tab.page, `(() => { const calls = window[Symbol.for(${JSON.stringify(PASSKEY_KEY)})]; return Array.isArray(calls) ? calls.splice(0, calls.length) : []; })()`),
      1500,
    ).catch(() => TIMED_OUT);
    if (Array.isArray(calls) && calls.length) pushEvent(tab, "the page requested a passkey or security key; use handoff");
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

  private retainBody(tab: Tab, entry: NetworkEntry, body: Buffer) {
    if (body.length > BODY_ENTRY_LIMIT || !tab.network.includes(entry)) return;
    entry.body = body;
    evictBodies(tab.network, entry, BODY_TAB_BUDGET);
    const all = this.listTabs()
      .flatMap((candidate) => candidate.network)
      .filter((candidate) => candidate.body)
      .sort((left, right) => left.time.localeCompare(right.time));
    evictBodies(all, entry, BODY_GLOBAL_BUDGET);
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
    let blank: Tab | undefined;
    for (const candidate of this.listTabs()) {
      if (candidate.owner !== UNCLAIMED_OWNER && candidate.owner !== ORPHANED_OWNER) continue;
      if (candidate.page.isClosed() || candidate.page.url() !== "about:blank") continue;
      const previousOwner = candidate.owner;
      candidate.owner = owner;
      if (await candidate.page.opener().catch(() => null)) {
        candidate.owner = previousOwner;
        continue;
      }
      blank = candidate;
      break;
    }
    const tab = blank ?? this.adopt(await context.newPage());
    tab.owner = owner;
    tab.lastSeenUrl = undefined;
    return tab;
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
    if (closed === TIMED_OUT) throw new ToolError(`Tab ${id} did not close within ${CLOSE_TIMEOUT_MS / 1000} s.`, "The page may be busy; try again or check tabs_list.");
  }

  private async closeAskingPage(tab: Tab) {
    let onClose = () => undefined as void;
    const outcome = new Promise<"closed" | "kept">((resolve) => {
      onClose = () => resolve("closed");
      tab.unload = { force: false, onBlocked: () => resolve("kept") };
      tab.page.once("close", onClose);
    });
    try {
      await tab.page.close({ runBeforeUnload: true });
      return await withDeadline(outcome, CLOSE_TIMEOUT_MS / 2);
    } finally {
      tab.page.off("close", onClose);
      tab.unload = undefined;
    }
  }

  claimIfOrphaned(id: string, owner: string) {
    const tab = this.tabs.get(id.trim());
    if (tab?.owner !== ORPHANED_OWNER) return;
    tab.owner = owner;
    tab.orphanedAt = undefined;
  }

  orphanTabsOf(owner: string) {
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
    const idle = this.listTabs().filter((tab) => tab.owner === ORPHANED_OWNER && now - Math.max(tab.orphanedAt ?? 0, tab.lastUsedAt) > ORPHAN_IDLE_MS);
    let closed = 0;
    for (const tab of idle) {
      const url = tab.page.url();
      const idleMinutes = Math.round((now - Math.max(tab.orphanedAt ?? 0, tab.lastUsedAt)) / 60_000);
      try {
        await this.closeTab(tab.id);
        closed += 1;
        logEvent("orphan_tab_closed", { tab: tab.id, url, idleMinutes });
      } catch (error) {
        logEvent("orphan_tab_close_failed", { tab: tab.id, url, error: error instanceof Error ? error.message : String(error) }, "warn");
      }
    }
    return closed;
  }

  locate(tab: Tab, target: string): Locator {
    const ref = parseRef(target);
    return ref ? tab.page.getByRef(ref) : tab.page.locator(target);
  }

  async resolve(tab: Tab, target: string) {
    const locator = this.locate(tab, target);
    const ref = parseRef(target);
    if (ref && (await locator.count()) === 0) {
      throw new ToolError(
        `Ref ${ref} is not in the latest snapshot of tab ${tab.id}.`,
        "Refs are valid until the page changes. Take a new snapshot and use a ref from it.",
      );
    }
    return locator;
  }

  evaluateMain<T>(page: Page, expression: string): Promise<T> {
    if (this.config.engine === "patchright") {
      const evaluate = page.evaluate.bind(page) as unknown as (
        expression: string,
        arg: undefined,
        options: undefined,
        isolatedContext: boolean,
      ) => Promise<T>;
      return evaluate(expression, undefined, undefined, false);
    }
    return page.evaluate(expression) as Promise<T>;
  }

  async evaluateIsolated<T>(page: Page, expression: string): Promise<T> {
    if (this.config.engine === "patchright") return (await page.evaluate(expression)) as T;
    const session = await page.context().newCDPSession(page);
    try {
      const { frameTree } = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
      const { executionContextId } = (await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: ISOLATED_WORLD })) as { executionContextId: number };
      const evaluated = (await session.send("Runtime.evaluate", { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true })) as {
        result: { value?: unknown; type: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "evaluation failed");
      return evaluated.result.value as T;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  async drainConsole(tab: Tab) {
    const hooked = await this.evaluateMain<ConsoleEntry[] | undefined>(
      tab.page,
      "(() => { const b = window.__webAgentConsole; return b ? b.splice(0, b.length) : undefined; })()",
    ).catch(() => undefined);
    for (const entry of hooked ?? []) pushBounded(tab.console, entry, CONSOLE_LIMIT);
    return tab.console;
  }

  drainEvents(tab: Tab, since?: number) {
    return tab.events.splice(0, tab.events.length).map((event) => {
      const text = typeof event.text === "function" ? event.text() : event.text;
      return since === undefined || event.at >= since
        ? `Event: ${text}`
        : `Earlier event (${new Date(event.at).toISOString().slice(11, 19)}, before this call): ${text}`;
    });
  }

  async shutdown() {
    const context = this.context;
    if (!context) return;
    this.shuttingDown = true;
    this.history.flush();
    await Promise.race([
      context.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
    this.history.flush();
  }
}
