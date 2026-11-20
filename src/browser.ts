import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, BrowserType, Locator, Page, Request, Response, Route } from "playwright-core";
import type { Config } from "./config.ts";
import { TIMED_OUT, withDeadline } from "./async.ts";
import { ToolError } from "./errors.ts";
import { isStreamingMime, isTextualMime } from "./mime.ts";
import { timestampSlug } from "./output.ts";
import { parseRef } from "./snapshot.ts";

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
  console: ConsoleEntry[];
  network: NetworkEntry[];
  events: TabEvent[];
  rules: InterceptRule[];
  ruleCounter: number;
};

export type TabEvent = { at: number; text: string };

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

export function pushEvent(tab: Tab, text: string) {
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

async function loadChromium(engine: Config["engine"]) {
  const module = engine === "patchright" ? await import("patchright") : await import("playwright-core");
  return module.chromium as unknown as BrowserType;
}

export class BrowserManager {
  readonly config: Config;
  private contextPromise?: Promise<BrowserContext>;
  private context?: BrowserContext;
  private readonly tabs = new Map<string, Tab>();
  private readonly byPage = new WeakMap<Page, Tab>();
  private counter = 0;
  private browserVersion?: string;
  private closing: Promise<unknown> = Promise.resolve();

  constructor(config: Config) {
    this.config = config;
  }

  get running() {
    return this.context !== undefined;
  }

  get version() {
    return this.browserVersion;
  }

  ensureContext() {
    this.contextPromise ??= this.launch().catch((error: unknown) => {
      this.contextPromise = undefined;
      throw error;
    });
    return this.contextPromise;
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
    const context = await chromium.launchPersistentContext(config.profileDir, {
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      channel: config.executablePath ? undefined : config.channel,
      executablePath: config.executablePath,
      headless: config.headless,
      viewport: null,
      locale: config.locale,
      timezoneId: config.timezoneId,
      acceptDownloads: true,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--disable-sync"],
      args: [`--password-store=${config.passwordStore}`, "--hide-crash-restore-bubble", ...config.extraArgs],
    });

    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await context.addInitScript(installConsoleHook, this.consoleHookMode);

    this.context = context;
    this.browserVersion = context.browser()?.version();
    context.on("close", () => this.reset());
    context.on("page", (page) => this.adopt(page));
    for (const page of context.pages()) this.adopt(page);
    return context;
  }

  private reset() {
    this.context = undefined;
    this.contextPromise = undefined;
    this.tabs.clear();
  }

  private adopt(page: Page) {
    const existing = this.byPage.get(page);
    if (existing) return existing;

    this.counter += 1;
    const tab: Tab = {
      id: `t${this.counter}`,
      page,
      owner: UNCLAIMED_OWNER,
      createdAt: Date.now(),
      console: [],
      network: [],
      events: [],
      rules: [],
      ruleCounter: 0,
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
        pushEvent(parent, `opened new tab ${tab.id}`);
      })
      .catch(() => undefined);

    return tab;
  }

  private attach(tab: Tab) {
    const { page } = tab;
    let networkId = 0;

    page.on("close", () => this.tabs.delete(tab.id));
    page.on("crash", () => pushEvent(tab, "the page crashed; reload it with navigate or close the tab"));
    page.on("console", (message) => {
      pushBounded(tab.console, { level: message.type(), text: message.text().slice(0, 2000), time: new Date().toISOString() }, CONSOLE_LIMIT);
    });
    page.on("pageerror", (error) => {
      pushBounded(tab.console, { level: "error", text: (error.stack ?? error.message).slice(0, 2000), time: new Date().toISOString() }, CONSOLE_LIMIT);
    });
    page.on("dialog", (dialog) => {
      pushEvent(tab, `${dialog.type()} dialog "${dialog.message().slice(0, 300)}" was accepted automatically`);
      void dialog.accept(dialog.type() === "prompt" ? dialog.defaultValue() : undefined).catch(() => undefined);
    });
    page.on("download", (download) => {
      const fileName = `${timestampSlug()}-${download.suggestedFilename().replace(/[^\w.-]+/g, "_").slice(-120)}`;
      const target = path.join(this.config.outputDir, "downloads", fileName);
      void mkdir(path.dirname(target), { recursive: true })
        .then(() => download.saveAs(target))
        .then(() => pushEvent(tab, `download saved to ${target}`))
        .catch((error: Error) => pushEvent(tab, `download of ${download.suggestedFilename()} failed: ${error.message.split("\n")[0]}`));
    });
    page.on("response", (response) => {
      const request = response.request();
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
      const contentType = response.headers()["content-type"];
      if (isTextualMime(contentType) && !isStreamingMime(contentType)) {
        void response
          .body()
          .then((body) => this.retainBody(tab, entry, body))
          .catch(() => undefined);
      }
    });
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
      `Tab ${id} is not open.`,
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
      if (await candidate.page.opener().catch(() => null)) continue;
      blank = candidate;
      break;
    }
    const tab = blank ?? this.adopt(await context.newPage());
    tab.owner = owner;
    return tab;
  }

  closeTab(id: string) {
    const run = this.closing.then(() => this.closeNow(id));
    this.closing = run.catch(() => undefined);
    return run;
  }

  private async closeNow(id: string) {
    const tab = this.getTab(id);
    const context = await this.ensureContext();
    const open = context.pages().filter((page) => !page.isClosed());
    if (open.length <= 1 || open.every((page) => page === tab.page)) await context.newPage();
    const closed = await withDeadline(tab.page.close(), CLOSE_TIMEOUT_MS);
    if (closed === TIMED_OUT) throw new ToolError(`Tab ${id} did not close within ${CLOSE_TIMEOUT_MS / 1000} s.`, "The page may be busy; try again or check tabs_list.");
  }

  claimIfOrphaned(id: string, owner: string) {
    const tab = this.tabs.get(id.trim());
    if (tab?.owner === ORPHANED_OWNER) tab.owner = owner;
  }

  orphanTabsOf(owner: string) {
    let count = 0;
    for (const tab of this.tabs.values()) {
      if (tab.owner !== owner) continue;
      tab.owner = ORPHANED_OWNER;
      count += 1;
    }
    return count;
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

  async drainConsole(tab: Tab) {
    const hooked = await this.evaluateMain<ConsoleEntry[] | undefined>(
      tab.page,
      "(() => { const b = window.__webAgentConsole; return b ? b.splice(0, b.length) : undefined; })()",
    ).catch(() => undefined);
    for (const entry of hooked ?? []) pushBounded(tab.console, entry, CONSOLE_LIMIT);
    return tab.console;
  }

  drainEvents(tab: Tab, since?: number) {
    return tab.events.splice(0, tab.events.length).map((event) =>
      since === undefined || event.at >= since
        ? `Event: ${event.text}`
        : `Earlier event (${new Date(event.at).toISOString().slice(11, 19)}, before this call): ${event.text}`,
    );
  }

  async shutdown() {
    const context = this.context;
    if (!context) return;
    await Promise.race([
      context.close().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);
  }
}
