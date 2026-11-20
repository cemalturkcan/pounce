import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Response } from "playwright-core";
import { z } from "zod";
import { type BrowserManager, LEAVE_CANCELLED, pushEvent, type Tab } from "../browser.ts";
import { normalizeUrl } from "../collect.ts";
import { recentFaults } from "../errors.ts";
import { describeEmulation, emulate, resetEmulation, VIEWPORT_PRESETS } from "../emulate.ts";
import { RETENTION_NOTE } from "../output.ts";
import { describePage, landingLines, pageTitle, renderSnapshot } from "../page.ts";
import { siteNotesHint } from "../sites.ts";
import { defineTool, includeSnapshotParam, tabLine, tabParam, timeoutParam, type ToolDeps, waitUntilParam } from "./common.ts";

const LEFT_PAGE_CANCELLED = Symbol("leave cancelled");

async function downloadInstead(manager: BrowserManager, tab: Tab, since: number, error: unknown) {
  if (!/Download is starting|net::ERR_ABORTED/i.test(error instanceof Error ? error.message : String(error))) throw error;
  const download = await manager.downloadSince(tab, since);
  if (!download) throw error;
  const outcome = download.file ? `Downloaded ${download.name} to ${download.file}` : `The download of ${download.name} ${download.note}.`;
  return `${outcome}\nThe URL is a file download, so the tab stays at ${await describePage(tab.page)}.`;
}

async function leaveGuarded(tab: Tab, force: boolean, navigation: () => Promise<Response | null>) {
  let cancel = () => undefined as void;
  const cancelled = new Promise<typeof LEFT_PAGE_CANCELLED>((resolve) => (cancel = () => resolve(LEFT_PAGE_CANCELLED)));
  tab.unload = force ? { force: true } : { force: false, onBlocked: () => (pushEvent(tab, LEAVE_CANCELLED), cancel()) };
  try {
    const running = navigation();
    running.catch(() => undefined);
    return await Promise.race([running, cancelled]);
  } finally {
    tab.unload = undefined;
  }
}

export function registerTabTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, secrets } = deps;

  defineTool(server, deps, {
    name: "tabs_list",
    title: "List tabs",
    description:
      "List the open tabs of the shared browser with their ids, owners and URLs, plus browser status (engine, Chrome version, profile and output directories) and recent background errors. Tabs marked \"other client\" belong to another agent session and \"unclaimed\" ones were opened by the browser or the user; leave both alone unless the task is about them. \"orphaned\" tabs belonged to a session that has ended: any session may use or close them, and using one makes it yours. A tab whose page does not answer is listed with (unresponsive) instead of its title. Does not start the browser if it is not running.",
    input: {},
    readOnly: true,
    handler: async (_input, owner) => {
      const { config } = manager;
      const status = manager.running
        ? `Browser running: Chrome ${manager.version ?? "?"} via ${config.engine}${config.headless ? " (headless)" : ""}.`
        : "Browser not started yet; it launches on the first tab_open.";
      const lines = [status, `Profile: ${config.profileDir}`, `Output files: ${store.root} (${RETENTION_NOTE})`, `Secret store: ${secrets.backend}`, `ask_pages adapter: ${deps.ask.label}`];
      const faults = recentFaults();
      if (faults.length) lines.push("Recent background errors (newest last):", ...faults.map((fault) => `  ${fault.time.slice(11, 19)} ${fault.source}: ${fault.message}`));
      const tabs = manager.listTabs();
      if (tabs.length === 0) return [...lines, "No tabs open."].join("\n");
      const titled = await Promise.all(
        tabs.map(async (tab) => {
          const title = await pageTitle(tab.page);
          return `${tabLine(tab, owner)} ${title === undefined ? "(unresponsive)" : JSON.stringify(title)}`;
        }),
      );
      return [...lines, "Tabs:", ...titled].join("\n");
    },
  });

  defineTool(server, deps, {
    name: "tab_open",
    title: "Open tab",
    description:
      "Open a new tab owned by this session and optionally navigate it. Returns the tab id to pass as `tab` to every other tool. Starts the browser on first use; the profile is persistent, so cookies and logins from earlier sessions are available.",
    input: {
      url: z.string().optional().describe("URL to load. https:// is assumed when no scheme is given. Omit for a blank tab."),
      wait_until: waitUntilParam,
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input, owner) => {
      const tab = await manager.openTab(owner);
      if (!input.url) {
        manager.markSeen(tab);
        return `Opened ${tab.id} (blank).`;
      }
      const startedAt = Date.now();
      let response: Response | null;
      try {
        response = await tab.page.goto(normalizeUrl(input.url), { waitUntil: input.wait_until ?? "domcontentloaded" });
      } catch (error) {
        const text = await downloadInstead(manager, tab, startedAt, error);
        manager.markSeen(tab);
        return `Opened ${tab.id}.\n${text}`;
      }
      manager.markSeen(tab);
      const lines = [`Opened ${tab.id}: ${await describePage(tab.page)} (HTTP ${response?.status() ?? "-"})`];
      lines.push(...(await landingLines(manager, tab, { previousUrl: "about:blank", status: response?.status() })));
      lines.push(...manager.drainEvents(tab, startedAt));
      const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
      if (notes) lines.push(notes);
      if (input.include_snapshot) lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
      return lines.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "tab_close",
    title: "Close tab",
    description:
      "Close a tab and free its memory. Cookies, logins and other profile data stay. If the page asks to confirm leaving because of unsaved changes, the tab stays open and the call fails; pass force: true to close it anyway and lose them. Close tabs you opened once the task no longer needs them, and leave tabs that belong to other sessions or the user open.",
    input: {
      tab: tabParam,
      force: z.boolean().optional().describe("Close even if the page asks to confirm leaving (unsaved changes are lost). Default false."),
    },
    destructive: true,
    handler: async (input) => {
      await manager.closeTab(input.tab, { runBeforeUnload: !input.force });
      return `Closed ${input.tab}.`;
    },
  });

  defineTool(server, deps, {
    name: "tab_resize",
    title: "Resize viewport",
    description:
      "Set the viewport size of a tab in CSS pixels, for responsive checks or to change what a viewport screenshot covers. The size stays until the tab is resized again or closed; other tabs are not affected.",
    input: {
      tab: tabParam,
      width: z.number().int().min(200).max(7680).describe("Viewport width in CSS pixels."),
      height: z.number().int().min(200).max(4320).describe("Viewport height in CSS pixels."),
    },
    handler: async (input) => {
      await manager.getTab(input.tab).page.setViewportSize({ width: input.width, height: input.height });
      return `Viewport of ${input.tab} is now ${input.width}x${input.height}.`;
    },
  });

  defineTool(server, deps, {
    name: "navigate",
    title: "Navigate",
    description:
      "Load a URL in an existing tab, or move through its history. Returns the final URL, title and HTTP status (or, for a URL that downloads a file, the saved file path while the tab stays where it was), and flags a CAPTCHA or bot wall and a sign-in page that suggests an expired session. Refs from earlier snapshots of this tab stop working after navigation. If the page asks to confirm leaving because of unsaved changes, the tab stays where it is and the result says so; call again with force: true to leave anyway.",
    input: {
      tab: tabParam,
      url: z.string().describe("URL to load, or one of back, forward, reload. https:// is assumed when no scheme is given."),
      wait_until: waitUntilParam,
      timeout_ms: timeoutParam(30_000),
      force: z.boolean().optional().describe("Leave even if the page asks to confirm leaving because of unsaved changes, which are then lost. Default false."),
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const startedAt = Date.now();
      const previousUrl = tab.page.url();
      const options = { waitUntil: input.wait_until ?? ("domcontentloaded" as const), timeout: input.timeout_ms };
      const history = { waitUntil: "commit" as const, timeout: input.timeout_ms };
      const requestedUrl = input.url === "reload" ? previousUrl : input.url === "back" || input.url === "forward" ? undefined : normalizeUrl(input.url);
      let outcome: Awaited<ReturnType<typeof leaveGuarded>>;
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
        return [await downloadInstead(manager, tab, startedAt, error), ...manager.drainEvents(tab, startedAt)].join("\n");
      }
      if (outcome === LEFT_PAGE_CANCELLED) {
        return [`Still at ${await describePage(tab.page)}`, ...manager.drainEvents(tab, startedAt)].join("\n");
      }
      const response = outcome;
      if (input.url === "back" || input.url === "forward") {
        await tab.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      }
      const lines = [`${await describePage(tab.page)} (HTTP ${response?.status() ?? "-"})`];
      lines.push(
        ...(await landingLines(manager, tab, { previousUrl, requestedUrl, status: response?.status(), redirected: response ? response.request().redirectedFrom() !== null : undefined })),
      );
      lines.push(...manager.drainEvents(tab, startedAt));
      const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
      if (notes) lines.push(notes);
      if (input.include_snapshot) lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
      return lines.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "emulate",
    title: "Emulate device and conditions",
    description: [
      "Change how one tab presents itself and what conditions it runs under: viewport and mobile mode, color scheme, reduced motion, geolocation, time zone, locale, user agent, offline mode and network throttling. Settings combine across calls and stay until reset: true or until the tab closes; the result lists everything active.",
      "All settings apply to this tab only, except one: geolocation also grants the geolocation permission to the tab's current origin for the whole browser profile, and reset clears permission grants made by the agent. Locale changes Intl formatting and the Accept-Language header but not navigator.language in every Chrome version. A user agent or locale override keeps the browser's real client hints (navigator.userAgentData brands and the sec-ch-ua headers); an empty user_agent or reset removes the override. Reload the page after changing locale, time zone or user agent so the site sees the new values from the start.",
      "For a plain viewport size without mobile emulation, tab_resize is simpler.",
    ].join("\n"),
    input: {
      tab: tabParam,
      viewport: z
        .object({
          preset: z.enum(Object.keys(VIEWPORT_PRESETS) as [keyof typeof VIEWPORT_PRESETS, ...(keyof typeof VIEWPORT_PRESETS)[]]).optional().describe("mobile 390x844 @3x with touch, tablet 820x1180 @2x with touch, laptop 1366x768, desktop 1920x1080."),
          width: z.number().int().min(200).max(7680).optional().describe("Width in CSS pixels; overrides the preset."),
          height: z.number().int().min(200).max(4320).optional().describe("Height in CSS pixels; overrides the preset."),
          mobile: z.boolean().optional().describe("Mobile mode with touch events; overrides the preset."),
          scale: z.number().min(1).max(4).optional().describe("Device pixel ratio; overrides the preset."),
        })
        .optional()
        .describe("Viewport to emulate: a preset, a size, or both."),
      color_scheme: z.enum(["light", "dark", "none"]).optional().describe("prefers-color-scheme to report; none removes the override."),
      reduced_motion: z.enum(["reduce", "no-preference", "none"]).optional().describe("prefers-reduced-motion to report; none removes the override."),
      geolocation: z
        .object({
          latitude: z.number().min(-90).max(90).describe("Latitude in degrees."),
          longitude: z.number().min(-180).max(180).describe("Longitude in degrees."),
          accuracy: z.number().min(0).optional().describe("Accuracy in meters. Default 10."),
        })
        .optional()
        .describe("Position reported by navigator.geolocation; the permission is granted to the tab's origin."),
      timezone: z.string().optional().describe("IANA time zone such as Europe/Istanbul; an empty string removes the override."),
      locale: z.string().optional().describe("Locale such as de-DE; an empty string removes the override."),
      user_agent: z.string().optional().describe("User agent string to send and report; an empty string removes the override."),
      offline: z.boolean().optional().describe("true cuts the tab off the network; false restores it."),
      network: z.enum(["slow3g", "fast3g", "none"]).optional().describe("Throttle the tab's network: slow3g about 2 s latency and 50 KB/s, fast3g about 560 ms and 180 KB/s, none removes throttling."),
      reset: z.boolean().optional().describe("Clear every setting this tool made on the tab before applying the others. Default false."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const lines: string[] = [];
      if (input.reset) {
        const cleared = await resetEmulation(tab.page);
        lines.push(cleared.length ? `Cleared: ${cleared.join(", ")}.` : "Nothing was being emulated.");
      }
      const settings = await emulate(tab.page, {
        viewport: input.viewport,
        colorScheme: input.color_scheme,
        reducedMotion: input.reduced_motion,
        geolocation: input.geolocation,
        timezone: input.timezone,
        locale: input.locale,
        offline: input.offline,
        network: input.network,
        userAgent: input.user_agent,
      });
      lines.push(describeEmulation(settings));
      return lines.join("\n");
    },
  });
}
