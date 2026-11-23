import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { messageOf, ToolError } from "../shared/errors.ts";
import { originOf, PERMISSION_NAMES } from "../browser/profile-settings.ts";
import { defineTool, tabParam, type ToolDeps } from "./common.ts";
import { normalizeUrl } from "../page/collect.ts";
import { registerSecret } from "../shared/secrets.ts";
import {
  appendSiteNote,
  mainLabel,
  readSiteNotes,
  registrableDomain,
  siteHost,
  siteNotesPath,
} from "../page/sites.ts";
import { onConsoleSite } from "./logs.ts";

type SiteTarget = { host: string; origin: string; domain: string };

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.(localhost|test)$/;

export function registerSessionTools(server: McpServer, deps: ToolDeps) {
  const { manager, secrets, redactor } = deps;

  function targetOf(input: { tab?: string; site?: string }): SiteTarget | undefined {
    const source = input.site ?? (input.tab ? manager.getTab(input.tab).page.url() : undefined);
    if (!source) return undefined;
    const host = siteHost(source);
    const origin = originOf(normalizeUrl(source));
    const hostname = URL.parse(origin)?.hostname ?? host;
    return { host, origin, domain: registrableDomain(hostname.replace(/^www\./, "")) };
  }

  function requireTarget(input: { tab?: string; site?: string }, parameter: string) {
    const target = targetOf(input);
    if (!target)
      throw new ToolError(
        `${parameter} needs tab or site.`,
        "Pass a tab that is on the site, or site such as shop.example.com.",
      );
    return target;
  }

  async function secretNames(filter: string) {
    const names = await secrets.list(filter || undefined);
    if (names.length)
      return `Password store${filter ? ` names containing ${JSON.stringify(filter)}` : ""}: ${names.join(", ")}`;
    return filter
      ? `Password store: no name contains ${JSON.stringify(filter)}.`
      : "Password store: no entries.";
  }

  async function consoleState(target: SiteTarget) {
    const { engine, consoleHook } = manager.config;
    const hostname = URL.parse(target.origin)?.hostname ?? target.host;
    const state =
      engine === "playwright"
        ? "captured on every site with the playwright engine"
        : consoleHook === "all"
          ? "captured on every site (WEB_AGENT_CONSOLE_HOOK=all)"
          : consoleHook === "off"
            ? "not captured on any site (WEB_AGENT_CONSOLE_HOOK=off)"
            : LOCAL_HOST.test(hostname)
              ? "captured on local development hosts"
              : onConsoleSite(await manager.consoleSites(), hostname)
                ? "captured, turned on with console_capture"
                : "not captured, only its uncaught errors are; console_capture true turns it on";
    return `Console calls on ${target.domain}: ${state}.`;
  }

  async function siteState(target: SiteTarget, secretsFilter: string | undefined) {
    const { sitesDir } = manager.config;
    const notes = await readSiteNotes(sitesDir, target.host);
    const grants = manager.profile
      .listGrants()
      .find((entry) => entry.origin === target.origin)
      ?.names.join(", ");
    const credential = manager.profile
      .listCredentials()
      .find((entry) => entry.origin === target.origin);
    const filter = secretsFilter ?? mainLabel(target.host);
    return [
      notes
        ? `Notes for ${target.host} (${siteNotesPath(sitesDir, target.host)}):\n${notes.trimEnd()}`
        : `No notes for ${target.host} yet. Add one with note once you learn something worth keeping.`,
      grants
        ? `Permissions for ${target.origin}: ${grants}`
        : `Permissions for ${target.origin}: none granted with site.`,
      credential
        ? `HTTP authentication for ${target.origin}: answered with secret ${credential.secret}`
        : `HTTP authentication for ${target.origin}: none.`,
      await consoleState(target),
      await secretNames(filter).catch(
        (error) => `Password store names could not be listed: ${messageOf(error)}`,
      ),
    ].join("\n");
  }

  async function originsState() {
    const consoleSites = await manager.consoleSites();
    const lines = [
      ...manager.profile
        .listGrants()
        .filter((entry) => entry.names.length)
        .map((entry) => `${entry.origin}: ${entry.names.join(", ")}`),
      ...manager.profile
        .listCredentials()
        .map((entry) => `${entry.origin}: HTTP authentication with ${entry.secret}`),
    ];
    const origins = lines.length
      ? lines.join("\n")
      : "No origin has permission grants or HTTP authentication.";
    return consoleSites.length
      ? `${origins}\nConsole capture is turned on for: ${consoleSites.join(", ")}`
      : origins;
  }

  async function clearState(target: SiteTarget | undefined) {
    const context = await manager.ensureContext();
    const origin = target?.origin;
    const scope = origin ?? "all origins";
    const cleared = await manager.profile.clearGrants(context, origin);
    const removed = await manager.profile.clearCredentials(context, origin);
    return [
      cleared.length
        ? `Cleared permissions for ${scope}: ${cleared.join(", ")}.`
        : `Cleared permission overrides for ${scope}; site had granted none there.`,
      removed.length
        ? `Removed HTTP authentication credentials for ${removed.join(", ")}. Chrome may still send credentials it already accepted there until the browser restarts.`
        : origin
          ? `${origin} had no HTTP authentication credentials.`
          : "No origin had HTTP authentication credentials.",
    ];
  }

  defineTool(server, deps, {
    name: "site",
    title: "Site notes, permissions, HTTP authentication and secret names",
    description: [
      "Show or change what is kept for one site: notes written by agents, the browser permissions granted to its origin, the password-store entry that answers its HTTP authentication, and the names of password-store entries that match it (names only, never values), and whether logs captures its pages' own console calls.",
      "With tab or site and no write parameter it shows all four; with nothing given it lists every origin that has grants or HTTP authentication. note appends one dated line to the host's Markdown notes, a file per host name that survives between sessions: record what took effort to find out, such as working selectors, API endpoints with their parameters, pagination, login steps, rate limits and quirks. navigate mentions when a host has notes. An old note is a lead to check, not a fact.",
      "grant gives permissions (geolocation, notifications, camera, microphone, clipboard-read and others) to the origin. The browser's native permission prompt is not part of the page, so snapshot, click and dismiss_overlays cannot answer it: grant here, then reload or repeat the action that asked. Grants apply in every tab of the shared profile, add up across calls and last until clear or until the server restarts.",
      "http_auth takes a password-store name and answers HTTP Basic and Digest challenges (the browser's own login dialog, which fill cannot reach) for the origin, in every tab of the profile, until clear or until the server restarts; for login forms inside the page use fill with secret. clear removes the grants (including a geolocation grant made by emulate) and the HTTP authentication of the origin, or of every origin when neither tab nor site is given; Chrome keeps credentials it already accepted until the browser restarts. Each write ends by showing the state.",
      "console_capture true makes logs capture the page's own console calls on the site, its registrable domain with every subdomain, which the default patchright engine otherwise does only on local development hosts; it is off by default, kept between sessions, applies from a page's next load (reload an open page after turning it on) and leaves every other site as it is.",
      "The shown names are those containing the host's main name, for example example for shop.example.com; secrets with some text lists the names containing it instead, and an empty string lists all. Pass a name to fill as secret (with secret_field username, password or otp) and the server types the value, which you never see. Passwords and other secret fields are then masked in tool results, in the text files the server writes, in page text sent to the ask_pages model and in the server log (one-time codes for 2 minutes); usernames, raw exports (storage export, network har), downloads, binary files and screenshots are not masked.",
    ].join("\n"),
    input: {
      tab: tabParam.optional().describe("Use the site of this tab's current URL."),
      site: z
        .string()
        .optional()
        .describe(
          "Host name or URL, for example shop.example.com, used instead of tab. A leading www. is ignored for notes.",
        ),
      note: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "Append one line with what took effort to learn, such as an endpoint with its parameters, a pagination scheme, a working selector or a quirk.",
        ),
      grant: z
        .array(z.enum(PERMISSION_NAMES))
        .min(1)
        .optional()
        .describe(
          'Permission names to grant, for example ["notifications"] or ["camera", "microphone"].',
        ),
      http_auth: z
        .string()
        .optional()
        .describe(
          "Name of a password-store entry whose username and password answer HTTP authentication challenges from the origin.",
        ),
      clear: z
        .boolean()
        .optional()
        .describe(
          "Remove the grants and HTTP authentication of the origin (every origin when neither tab nor site is given). Cannot be combined with grant or http_auth.",
        ),
      console_capture: z
        .boolean()
        .optional()
        .describe(
          "true captures the page's own console calls (console.log, console.error and the like) on this site, its registrable domain and every subdomain, for logs; false stops it. Off by default; kept between sessions. Takes effect when a page loads, so reload an open page after turning it on.",
        ),
      secrets: z
        .string()
        .optional()
        .describe(
          "List password-store names containing this text, case-insensitive, instead of the names matching the host; an empty string lists all.",
        ),
    },
    handler: async (input) => {
      if (input.clear && input.grant)
        throw new ToolError("clear cannot be combined with grant.", "Call site twice.");
      if (input.clear && input.http_auth)
        throw new ToolError("clear cannot be combined with http_auth.", "Call site twice.");
      const target = targetOf(input);
      if (input.note !== undefined) requireTarget(input, "note");
      if (input.grant) requireTarget(input, "grant");
      if (input.http_auth) requireTarget(input, "http_auth");
      if (input.console_capture !== undefined) requireTarget(input, "console_capture");
      const lines: string[] = [];
      if (input.clear) lines.push(...(await clearState(target)));
      if (target && input.note !== undefined) {
        const file = await appendSiteNote(manager.config.sitesDir, target.host, input.note);
        lines.push(`Added a note for ${target.host} to ${file}.`);
      }
      if (target && input.grant) {
        const context = await manager.ensureContext();
        await manager.profile.grant(context, target.origin, input.grant);
      }
      if (target && input.http_auth) {
        const context = await manager.ensureContext();
        const username = await secrets.get(input.http_auth, "username");
        const password = await secrets.get(input.http_auth, "password");
        registerSecret(redactor, input.http_auth, "password", password);
        await manager.profile.setCredential(context, {
          origin: target.origin,
          secret: input.http_auth,
          username,
          password,
        });
        lines.push(
          `HTTP authentication challenges from ${target.origin} are now answered with secret ${input.http_auth}, in every tab of the profile. Reload or navigate the page to send them.`,
        );
      }
      if (target && input.console_capture !== undefined) {
        const site = await manager.setConsoleCapture(target.domain, input.console_capture);
        lines.push(
          input.console_capture
            ? `Console calls of pages on ${site} are now captured from their next load, in every tab, and stay so between sessions. Reload a page of ${site} that is already open to capture its console calls.`
            : `Console calls of pages on ${site} are no longer captured from their next load.`,
        );
      }
      if (target) lines.push(await siteState(target, input.secrets));
      else if (input.secrets !== undefined) lines.push(await secretNames(input.secrets));
      else lines.push(await originsState());
      return lines.join("\n");
    },
  });
}
