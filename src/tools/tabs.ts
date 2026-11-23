import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Response } from "playwright-core";
import { z } from "zod";
import { type BrowserManager } from "../browser/manager.ts";
import type { AutoConsent } from "../config/config.ts";
import { emptyErrorResponse, noContentResponse, settleErrorPage } from "../page/body.ts";
import { normalizeUrl } from "../page/collect.ts";
import { recentFaults } from "../log/faults.ts";
import { describeError, messageOf, ToolError } from "../shared/errors.ts";
import {
  describeEmulation,
  emulate,
  emulatesOffline,
  resetEmulation,
  resolveDevice,
} from "../browser/emulate.ts";
import { inSequence } from "../shared/async.ts";
import {
  fieldPointer,
  fieldsPointer,
  localClock,
  RETENTION_NOTE,
  shownUrl,
} from "../shared/output.ts";
import {
  describePage,
  documentStamp,
  hasHistoryEntry,
  settleHistoryStep,
  historyEnd,
  historyReason,
  isTimeout,
  landingReport,
  noContentLine,
  type NoResponse,
  pageTitle,
  redirectsOf,
  renderSnapshot,
  statusLine,
  unfinishedNavigation,
  watchNavigation,
} from "../page/page.ts";
import { watchConsent } from "../overlays/consent.ts";
import { siteNotesHint } from "../page/sites.ts";
import {
  defineTool,
  includeSnapshotParam,
  TAB_OWNERSHIPS,
  tabOwnership,
  tabParam,
  type ToolDeps,
  waitUntilParam,
} from "./common.ts";
import { downloadSavedEvent, LEAVE_CANCELLED } from "../browser/tab-watch.ts";
import { dialogLine, dialogStatus, raceDialog } from "../browser/dialogs.ts";
import { drainEvents, forgetEvent, pushEvent, type Tab } from "../browser/tab.ts";

const LEFT_PAGE_CANCELLED = Symbol("leave cancelled");

const challengeField = z.object({
  kind: z.enum(["self-clearing", "interactive", "block", "solved"]),
  provider: z.string(),
  detail: z.string(),
});

const HISTORY_STEPS = new Set(["back", "forward", "reload"]);

const CONSENT_HANDLING = {
  accept: "accepted",
  reject: "rejected",
  off: "left alone",
} as const satisfies Record<AutoConsent, string>;

type NavigateInput = {
  tab?: string;
  url: string;
  wait_until?: "commit" | "domcontentloaded" | "load";
  timeout_ms?: number;
  force?: boolean;
  include_snapshot?: boolean;
};

type Challenge = Awaited<ReturnType<typeof landingReport>>["challenge"];

type NavigationFacts = {
  challenge?: Challenge;
  challengeCleared?: Awaited<ReturnType<typeof landingReport>>["cleared"];
  redirectedFrom?: string[];
  fromCache?: true;
  sameDocument?: true;
  download?: { name: string; file?: string; note?: string };
};

type Navigated = { text: string; status: number | undefined; facts?: NavigationFacts };

function redirectFacts(response: Response | null) {
  const redirects = redirectsOf(response).map(shownUrl);
  return redirects.length ? { redirectedFrom: redirects } : {};
}

function historyFacts(url: string, reason: NoResponse): NavigationFacts {
  if (!/^https?:/.test(url)) return {};
  if (reason === "cache") return { fromCache: true };
  return reason === "same-document" ? { sameDocument: true } : {};
}

function landingFacts(report: Awaited<ReturnType<typeof landingReport>>): NavigationFacts {
  return { challenge: report.challenge, challengeCleared: report.cleared };
}

const HOUR_MS = 60 * 60 * 1000;

function authChallengeLine(response: Response | null) {
  const challenge = response?.status() === 401 ? response.headers()["www-authenticate"] : undefined;
  if (!challenge) return [];
  return [
    `The site asks for HTTP authentication (${challenge.split(/\s/)[0]}); use site with http_auth and a password-store entry for this origin, then navigate again.`,
  ];
}

async function downloadInstead(manager: BrowserManager, tab: Tab, since: number, cause: unknown) {
  const isDownload = /Download is starting|net::ERR_ABORTED/i.test(messageOf(cause));
  const download = isDownload ? await manager.downloadSince(tab, since) : undefined;
  if (!download) {
    if (!/net::ERR_/.test(String(cause))) throw cause;
    await settleErrorPage(tab.page);
    if (!emulatesOffline(tab.page)) throw cause;
    throw new ToolError(
      describeError(cause).split("\n")[0] ?? "",
      "The tab is emulating offline, so it loads nothing from the network; turn that off with emulate offline: false, then navigate again.",
    );
  }
  if (download.file) forgetEvent(tab, downloadSavedEvent(download.file));
  const outcome = download.file
    ? `Downloaded ${download.name} to ${download.file}`
    : `The download of ${download.name} ${download.note}.`;
  return {
    text: `${outcome}\nThe URL is a file download, so the tab stays at ${await describePage(tab.page)}.`,
    download,
  };
}

async function leaveGuarded(tab: Tab, force: boolean, navigation: () => Promise<Response | null>) {
  const cancelled = new Promise<typeof LEFT_PAGE_CANCELLED>((resolve) => {
    tab.unload = force
      ? { force: true }
      : {
          force: false,
          onBlocked: () => (pushEvent(tab, LEAVE_CANCELLED), resolve(LEFT_PAGE_CANCELLED)),
        };
  });
  try {
    const running = navigation();
    running.catch(() => undefined);
    return await Promise.race([running, cancelled]);
  } finally {
    tab.unload = undefined;
  }
}

async function pageData(tab: Tab, navigated: Navigated) {
  return {
    tab: tab.id,
    url: shownUrl(tab.page.url()),
    title: tab.dialog ? undefined : await pageTitle(tab.page),
    status: navigated.status,
    ...navigated.facts,
  };
}

export function registerTabTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, secrets, log } = deps;

  async function listTabs(owner: string) {
    const { config } = manager;
    const status = manager.running
      ? `Browser running: Chrome ${manager.version ?? "?"} via ${config.engine}${config.headless ? " (headless)" : ""}.`
      : "Browser not started yet; it launches on the first navigate.";
    const lines = [
      status,
      `Profile: ${config.profileDir}`,
      `Output files: ${store.root} (${RETENTION_NOTE})`,
      `Cookie banners: ${CONSENT_HANDLING[config.autoConsent]} on your own tabs after a page loads.`,
      `Secret store: ${secrets.backend}`,
      `ask_pages adapter: ${deps.ask.label}`,
    ];
    const errors = log.recentCount("error", HOUR_MS);
    lines.push(
      `Log: ${log.dir} (${errors} ${errors === 1 ? "error" : "errors"} in the last hour; read with logs, source server)`,
    );
    const faults = recentFaults();
    const serverState = {
      browser: {
        running: manager.running,
        engine: config.engine,
        headless: config.headless,
        version: manager.running ? manager.version : undefined,
      },
      profile: config.profileDir,
      cookieBanners: config.autoConsent,
      secretStore: secrets.backend,
      askAdapter: deps.ask.label,
      log: { dir: log.dir, errorsLastHour: errors },
      backgroundErrors: faults.length
        ? faults.map((fault) => ({
            time: localClock(fault.time),
            source: fault.source,
            message: fault.message,
          }))
        : undefined,
    };
    if (faults.length)
      lines.push(
        "Recent background errors (newest last):",
        ...faults.map((fault) => `  ${localClock(fault.time)} ${fault.source}: ${fault.message}`),
      );
    const listed = manager.listTabs();
    const tabs = await Promise.all(
      listed.map(async (tab) => {
        const title = tab.dialog ? undefined : await pageTitle(tab.page);
        return {
          id: tab.id,
          ownership: tabOwnership(tab, owner),
          url: shownUrl(tab.page.url()),
          title,
          dialog: tab.dialog ? dialogStatus(tab.dialog) : undefined,
          unresponsive: !tab.dialog && title === undefined ? true : undefined,
        };
      }),
    );
    const data = { tabs, outputDir: store.root };
    const serverPointer = [
      `Server state: ${fieldsPointer(["browser", "profile", "cookieBanners", "secretStore", "askAdapter", "log", ...(faults.length ? ["backgroundErrors"] : [])])}`,
      `Output files: ${fieldPointer("outputDir")} (${RETENTION_NOTE})`,
    ];
    if (tabs.length === 0)
      return {
        serverLines: lines,
        serverPointer,
        serverState,
        tabLines: ["No tabs open."],
        tabPointer: ["No tabs open."],
        data,
      };
    const titled = tabs.map((tab) => {
      const state = tab.dialog
        ? `(${tab.dialog})`
        : tab.unresponsive
          ? "(unresponsive)"
          : JSON.stringify(tab.title);
      return `${tab.id} [${tab.ownership}] ${tab.url} ${state}`;
    });
    return {
      serverLines: lines,
      serverPointer,
      serverState,
      tabLines: ["Tabs:", ...titled],
      tabPointer: ["Tabs:", fieldPointer("tabs")],
      data,
    };
  }

  async function closeOne(id: string, force: boolean, owner: string) {
    const tab = manager.peekTab(id);
    const foreign = tab !== undefined && tabOwnership(tab, owner) === "other client";
    const note = foreign ? [`Note: ${id} belongs to another session.`] : [];
    manager.claimIfOrphaned(id, owner);
    try {
      await manager.closeTab(id, { runBeforeUnload: !force });
      return { closed: true, lines: [...note, `Closed ${id}.`] };
    } catch (failure) {
      const reason =
        tab === undefined && failure instanceof ToolError
          ? failure.message
          : describeError(failure);
      return { closed: false, lines: [...note, `${id}: ${reason}`] };
    }
  }

  defineTool(server, deps, {
    name: "tabs",
    title: "Tabs",
    description:
      'List the open tabs and the server\'s state, or close tabs with close (one tab id or a list) and then list only the tabs that are left. Returns every tab with its id, owner, URL and title (or the dialog it waits on, or (unresponsive)), then the browser status (engine, Chrome version, profile; listing does not start the browser), the output directory where results and files are saved, the cookie banner setting, the secret store, the model adapter that ask_pages and compare_design use, the log directory with the errors of the last hour (read them with logs) and recent background errors. Ownership: "yours" tabs belong to this session; "other client" tabs belong to another agent session and "unclaimed" ones were opened by the browser or the user, so leave both alone unless the task is about them; "orphaned" tabs belonged to a session that has ended: any session may use or close them, using one makes it yours, and one nobody uses for 30 minutes is closed. Closing frees memory while cookies and sign-ins stay; close the tabs you opened once the task no longer needs them. A page that asks to confirm leaving (unsaved changes) keeps its tab open with an error line and the call fails; force: true closes it anyway and the changes are lost.',
    input: {
      close: z
        .union([z.string().transform((id) => [id]), z.array(z.string()).min(1)])
        .optional()
        .describe(
          'One tab id or a list of them to close, closed in this order, such as "t482913" or ["t482913", "t104577"].',
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "With close: close even if a page asks to confirm leaving; its unsaved changes are lost. Default false.",
        ),
    },
    output: {
      tabs: z.array(
        z.object({
          id: z.string(),
          ownership: z.enum(TAB_OWNERSHIPS),
          url: z.string(),
          title: z.string().optional(),
          dialog: z.string().optional(),
          unresponsive: z.boolean().optional(),
        }),
      ),
      outputDir: z.string(),
      closed: z.array(z.string()).optional(),
      browser: z
        .object({
          running: z.boolean(),
          engine: z.string(),
          headless: z.boolean(),
          version: z.string().optional(),
        })
        .optional(),
      profile: z.string().optional(),
      cookieBanners: z.enum(["accept", "reject", "off"]).optional(),
      secretStore: z.string().optional(),
      askAdapter: z.string().optional(),
      log: z.object({ dir: z.string(), errorsLastHour: z.number().int() }).optional(),
      backgroundErrors: z
        .array(z.object({ time: z.string(), source: z.string(), message: z.string() }))
        .optional(),
    },
    destructive: true,
    runsWithDialog: true,
    handler: async (input, owner) => {
      if (input.force !== undefined && input.close === undefined)
        throw new ToolError(
          "force only applies with close.",
          "Pass close with the ids of the tabs to close, or leave force out to list the tabs.",
        );
      const outcomes = input.close
        ? await inSequence(input.close, (id) => closeOne(id, input.force ?? false, owner))
        : [];
      const listing = await listTabs(owner);
      const closed = input.close?.filter((_id, index) => outcomes[index]?.closed);
      const closing = [...outcomes.flatMap((outcome) => outcome.lines), ""];
      const text = [...(outcomes.length ? closing : listing.serverLines), ...listing.tabLines].join(
        "\n",
      );
      const data = outcomes.length
        ? { ...listing.data, closed }
        : { ...listing.data, ...listing.serverState };
      if (outcomes.some((outcome) => !outcome.closed)) throw new ToolError(text, undefined, data);
      const structuredText = [
        ...(outcomes.length ? closing : listing.serverPointer),
        ...listing.tabPointer,
      ].join("\n");
      return { text, structuredText, data };
    },
  });

  async function openFailed(tab: Tab, startedAt: number, cause: unknown): Promise<Navigated> {
    let saved: Awaited<ReturnType<typeof downloadInstead>>;
    try {
      saved = await downloadInstead(manager, tab, startedAt, cause);
    } catch (failure) {
      manager.markSeen(tab);
      throw new ToolError(
        `${describeError(failure)}\nTab ${tab.id} was opened and stays open at ${tab.page.isClosed() ? "a closed page" : tab.page.url()} so the error page can be inspected.`,
        `Use navigate on ${tab.id} to try again, or tabs with close to close it.`,
        { tab: tab.id },
      );
    }
    manager.markSeen(tab);
    return {
      text: `Opened ${tab.id}.\n${saved.text}`,
      status: undefined,
      facts: { download: saved.download },
    };
  }

  async function openIn(tab: Tab, input: NavigateInput): Promise<Navigated> {
    if (input.url === "about:blank") {
      manager.markSeen(tab);
      return { text: `Opened ${tab.id} (blank).`, status: undefined };
    }
    const startedAt = Date.now();
    const url = normalizeUrl(input.url);
    const watch = watchNavigation(tab.page);
    let response: Response | null;
    let emptyBody = false;
    try {
      response = await tab.page.goto(url, {
        waitUntil: input.wait_until ?? "domcontentloaded",
        timeout: input.timeout_ms,
      });
    } catch (error) {
      if (isTimeout(error)) {
        manager.markSeen(tab);
        const lines = await unfinishedNavigation(tab, url, watch, Date.now() - startedAt);
        return {
          text: [`Opened ${tab.id}.`, ...lines, ...drainEvents(tab, startedAt)].join("\n"),
          status: undefined,
        };
      }
      const answered = noContentResponse(tab, startedAt, error);
      if (answered) {
        manager.markSeen(tab);
        return {
          text: [
            `Opened ${tab.id}.`,
            await noContentLine(tab.page, answered),
            ...drainEvents(tab, startedAt),
          ].join("\n"),
          status: answered.status(),
          facts: redirectFacts(answered),
        };
      }
      const failed = emptyErrorResponse(tab, error);
      if (!failed) return openFailed(tab, startedAt, error);
      response = failed;
      emptyBody = true;
    } finally {
      watch.stop();
    }
    manager.markSeen(tab, emptyBody ? response?.url() : undefined);
    await watchConsent(tab, manager.config.autoConsent);
    const lines = [
      `Opened ${tab.id}: ${await statusLine(tab.page, response, emptyBody)}`,
      ...authChallengeLine(response),
    ];
    const landing = await landingReport(manager, tab, {
      previousUrl: "about:blank",
      status: response?.status(),
    });
    lines.push(...landing.lines);
    lines.push(...drainEvents(tab, startedAt));
    const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
    if (notes) lines.push(notes);
    if (input.include_snapshot)
      lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
    return {
      text: lines.join("\n"),
      status: response?.status(),
      facts: { ...redirectFacts(response), ...landingFacts(landing) },
    };
  }

  async function openNew(input: NavigateInput, owner: string) {
    if (HISTORY_STEPS.has(input.url))
      throw new ToolError(
        `${input.url} needs a tab.`,
        `Pass the tab to ${input.url === "reload" ? "reload" : `go ${input.url} in`}; without tab, navigate opens a URL in a new tab.`,
      );
    if (input.force)
      throw new ToolError(
        "force needs a tab.",
        "force leaves a page with unsaved changes in a tab you have; a new tab has none, so leave it out.",
      );
    const tab = await manager.openTab(owner);
    const endAction = manager.beginAction(tab, "navigate", owner);
    try {
      const opened = await raceDialog(tab, openIn(tab, input), (dialog) => {
        manager.markSeen(tab);
        return {
          text: `Opened ${tab.id}: ${shownUrl(tab.page.url())}\n${dialogLine(dialog)}`,
          status: undefined,
        };
      });
      return { text: opened.text, data: await pageData(tab, opened) };
    } finally {
      endAction();
    }
  }

  async function navigateIn(tab: Tab, input: NavigateInput, owner: string): Promise<Navigated> {
    const startedAt = Date.now();
    const previousUrl = tab.page.url();
    const options = {
      waitUntil: input.wait_until ?? ("domcontentloaded" as const),
      timeout: input.timeout_ms,
    };
    const history = { waitUntil: "commit" as const, timeout: input.timeout_ms };
    const requestedUrl =
      input.url === "reload"
        ? previousUrl
        : input.url === "back" || input.url === "forward"
          ? undefined
          : normalizeUrl(input.url);
    const step = input.url === "back" || input.url === "forward" ? input.url : undefined;
    if (step && !(await hasHistoryEntry(tab, step)))
      return { text: await historyEnd(tab.page, step), status: undefined };
    const stampBefore = step ? await documentStamp(tab.page) : undefined;
    let outcome: Awaited<ReturnType<typeof leaveGuarded>>;
    let emptyBody = false;
    const watch = watchNavigation(tab.page);
    try {
      outcome = await leaveGuarded(tab, input.force ?? false, () =>
        input.url === "back"
          ? tab.page.goBack(history)
          : input.url === "forward"
            ? tab.page.goForward(history)
            : input.url === "reload"
              ? tab.page.reload(options)
              : tab.page.goto(requestedUrl ?? input.url, options),
      );
    } catch (error) {
      if (isTimeout(error)) {
        const lines = await unfinishedNavigation(
          tab,
          requestedUrl ?? `the ${input.url} navigation`,
          watch,
          Date.now() - startedAt,
        );
        lines.push(...drainEvents(tab, startedAt));
        if (input.include_snapshot && watch.navigated)
          lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
        return { text: lines.join("\n"), status: undefined };
      }
      const answered = noContentResponse(tab, startedAt, error);
      if (answered)
        return {
          text: [await noContentLine(tab.page, answered), ...drainEvents(tab, startedAt)].join(
            "\n",
          ),
          status: answered.status(),
          facts: redirectFacts(answered),
        };
      const failed = emptyErrorResponse(tab, error);
      if (!failed) {
        const saved = await downloadInstead(manager, tab, startedAt, error);
        return {
          text: [saved.text, ...drainEvents(tab, startedAt)].join("\n"),
          status: undefined,
          facts: { download: saved.download },
        };
      }
      outcome = failed;
      emptyBody = true;
    } finally {
      watch.stop();
    }
    if (outcome === LEFT_PAGE_CANCELLED) {
      return {
        text: [`Still at ${await describePage(tab.page)}`, ...drainEvents(tab, startedAt)].join(
          "\n",
        ),
        status: undefined,
      };
    }
    const response = outcome;
    let reason: NoResponse = "same-document";
    if (step) {
      await settleHistoryStep(tab.page);
      reason = historyReason(stampBefore, await documentStamp(tab.page));
    }
    if (tab.owner === owner) await watchConsent(tab, manager.config.autoConsent);
    const lines = [
      await statusLine(tab.page, response, emptyBody, reason),
      ...authChallengeLine(response),
    ];
    const landing = await landingReport(manager, tab, {
      previousUrl,
      requestedUrl,
      status: response?.status(),
      redirected: response ? response.request().redirectedFrom() !== null : undefined,
    });
    lines.push(...landing.lines);
    lines.push(...drainEvents(tab, startedAt));
    const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
    if (notes) lines.push(notes);
    if (input.include_snapshot)
      lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
    return {
      text: lines.join("\n"),
      status: response?.status(),
      facts: {
        ...(response ? redirectFacts(response) : historyFacts(tab.page.url(), reason)),
        ...landingFacts(landing),
      },
    };
  }

  defineTool(server, deps, {
    name: "navigate",
    title: "Navigate",
    description:
      "Open a URL in a new tab (no tab given) or in a tab you have, or go back, forward or reload a tab. Work on any web page starts here, local development servers included: the browser renders JavaScript and carries the user's cookies and sign-ins, which a plain HTTP fetch does not. Without tab, a new tab for this session opens, the result starts with Opened and its id (which every page tool takes as tab), and about:blank gives a blank tab. Returns the final URL, title and HTTP status with any redirect it followed; when the page does not finish loading within timeout_ms, the result says Still loading with what the tab shows instead of failing. Lines to act on: Challenge cleared: a bot check that cleared by itself within about 15 s; Challenge: a CAPTCHA or bot wall, so try it yourself and use handoff when it does not clear; Challenge solved: carry on with the page; Blocked: the site refused the visit, so stop rather than retry. It also reports an HTTP login dialog (answer it with site and http_auth), a sign-in page that suggests an expired session and site notes for the host, and for a URL that downloads a file gives the saved path while the tab stays where it was. On your own tabs a cookie banner that shows within about 1.5 s is handled by the server's cookie banner setting (shown by tabs) and reported as an event. Refs from earlier snapshots stop working after a navigation or reload. If the page asks to confirm leaving because of unsaved changes, the tab stays where it is and the result says so; force: true leaves anyway. When a new tab fails to load, the call fails but the tab stays open on the error page and the error names its id. To load many URLs at once, use save_pages.",
    input: {
      tab: z
        .string()
        .optional()
        .describe(
          "Tab to load the URL in, such as t482913. Omit to open a new tab for this session; back, forward, reload and force need a tab.",
        ),
      url: z
        .string()
        .trim()
        .min(1)
        .describe(
          "URL to load (https:// is assumed when no scheme is given), about:blank, or back, forward or reload. back and forward return once the history step commits; wait_until applies to URLs and reload.",
        ),
      wait_until: waitUntilParam,
      timeout_ms: z
        .number()
        .int()
        .min(100)
        .max(120_000)
        .optional()
        .describe(
          "How long to wait for the page before returning Still loading, in milliseconds. Default 30000.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Leave even if the page asks to confirm leaving because of unsaved changes, which are then lost. Default false.",
        ),
      include_snapshot: includeSnapshotParam,
    },
    output: {
      tab: z.string(),
      url: z.string(),
      title: z.string().optional(),
      status: z.number().int().optional(),
      challenge: challengeField.optional(),
      challengeCleared: challengeField.extend({ waitedMs: z.number() }).optional(),
      redirectedFrom: z.array(z.string()).optional(),
      fromCache: z.literal(true).optional(),
      sameDocument: z.literal(true).optional(),
      download: z
        .object({ name: z.string(), file: z.string().optional(), note: z.string().optional() })
        .optional(),
    },
    handler: async (input, owner) => {
      if (input.tab === undefined) return openNew(input, owner);
      const tab = manager.getTab(input.tab);
      const navigated = await navigateIn(tab, input, owner);
      return { text: navigated.text, data: await pageData(tab, navigated) };
    },
  });

  defineTool(server, deps, {
    name: "emulate",
    title: "Emulate device and conditions",
    description: [
      "Resize the viewport, or emulate a device, color scheme, reduced motion, geolocation, time zone, locale, user agent, offline mode or a slow network, for one tab. Settings combine across calls and stay until reset or until the tab closes; the result lists everything active.",
      "A viewport size alone keeps the desktop user agent and no touch, so sites that detect phones keep their desktop layout; for a phone or tablet use device (its size, pixel ratio, touch, mobile mode, user agent and the client hints its browser sends), or viewport with mobile: true. reset returns the tab to how it was before emulate: the earlier viewport size, no overrides, and the geolocation permission emulate granted removed; other permission grants stay. Everything applies to this tab only, except that geolocation grants the geolocation permission to the tab's current origin for the whole browser profile until reset or the tab closes. Locale changes Intl formatting and the Accept-Language header but not navigator.language in every Chrome version. Reload the page after changing device, locale, time zone or user agent so the site sees the new values from the start; the result says so when the page was loaded with another device or user agent. A change of size, device or media features returns once the page has been drawn with it, so a screenshot right after shows it.",
    ].join("\n"),
    input: {
      tab: tabParam,
      device: z
        .string()
        .optional()
        .describe(
          'Device to present as, such as "iPhone 15", "Pixel 8", "Galaxy S24", "iPad (gen 11)" or "Desktop Chrome"; add " landscape" for landscape. Sets its viewport, pixel ratio, touch, mobile mode, user agent and client hints (Safari on iPhone and iPad sends none). An unknown name returns the list of valid names. An empty string removes the device and its size.',
        ),
      viewport: z
        .strictObject({
          width: z.number().int().min(200).max(7680).describe("Width in CSS pixels."),
          height: z.number().int().min(200).max(4320).describe("Height in CSS pixels."),
          mobile: z
            .boolean()
            .optional()
            .describe(
              "Mobile mode with touch events, without changing the user agent. Default false, or the device's.",
            ),
          scale: z
            .number()
            .min(1)
            .max(4)
            .optional()
            .describe("Device pixel ratio. Default 1, or the device's."),
        })
        .optional()
        .describe("Viewport size. With a device active, it changes that device's size."),
      color_scheme: z
        .enum(["light", "dark", "none"])
        .optional()
        .describe(
          "prefers-color-scheme to report for this tab; none removes the override, and pages then follow the system setting as they do by default.",
        ),
      reduced_motion: z
        .enum(["reduce", "no-preference", "none"])
        .optional()
        .describe("prefers-reduced-motion to report; none removes the override."),
      geolocation: z
        .strictObject({
          latitude: z.number().min(-90).max(90).describe("Latitude in degrees."),
          longitude: z.number().min(-180).max(180).describe("Longitude in degrees."),
          accuracy: z.number().min(0).optional().describe("Accuracy in meters. Default 10."),
        })
        .optional()
        .describe(
          "Position reported by navigator.geolocation; the permission is granted to the tab's origin.",
        ),
      timezone: z
        .string()
        .optional()
        .describe("IANA time zone such as Europe/Istanbul; an empty string removes the override."),
      locale: z
        .string()
        .optional()
        .describe("Locale such as de-DE; an empty string removes the override."),
      user_agent: z
        .string()
        .optional()
        .describe(
          "User agent to send and report, with client hints that match it (none for a browser that is not based on Chromium); it takes precedence over the device's. An empty string removes the override.",
        ),
      offline: z
        .boolean()
        .optional()
        .describe("true cuts the tab off the network; false restores it."),
      network: z
        .enum(["slow3g", "fast3g", "none"])
        .optional()
        .describe(
          "Throttle the tab's network: slow3g about 2 s latency and 50 KB/s, fast3g about 560 ms and 180 KB/s, none removes throttling.",
        ),
      reset: z
        .boolean()
        .optional()
        .describe(
          "Return the tab to how it was before emulate, then apply the other settings given. Default false.",
        ),
    },
    handler: async (input) => {
      const device =
        input.device === undefined || input.device === ""
          ? input.device
          : resolveDevice(input.device);
      const tab = manager.getTab(input.tab);
      const lines: string[] = [];
      if (input.reset) {
        const { cleared, size } = await resetEmulation(tab.page, manager.profile);
        const restored = size ? `; the viewport is back to ${size.width}x${size.height}` : "";
        lines.push(
          cleared.length
            ? `Cleared: ${cleared.join(", ")}${restored}.`
            : "Nothing was being emulated.",
        );
      }
      const { settings, reload } = await emulate(
        tab.page,
        {
          device,
          viewport: input.viewport,
          colorScheme: input.color_scheme,
          reducedMotion: input.reduced_motion,
          geolocation: input.geolocation,
          timezone: input.timezone,
          locale: input.locale,
          offline: input.offline,
          network: input.network,
          userAgent: input.user_agent,
        },
        manager.profile,
      );
      lines.push(describeEmulation(settings));
      if (reload) lines.push(reload);
      return lines.join("\n");
    },
  });
}
