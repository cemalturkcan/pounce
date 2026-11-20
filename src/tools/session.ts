import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../errors.ts";
import { originOf, PERMISSION_NAMES } from "../profile-settings.ts";
import { registerSecret } from "../script.ts";
import { defineTool, tabParam, type ToolDeps } from "./common.ts";

export function registerSessionTools(server: McpServer, deps: ToolDeps) {
  const { manager, secrets, redactor } = deps;

  function targetOrigin(input: { tab?: string; origin?: string }, action: string) {
    if (input.origin) return originOf(input.origin);
    if (input.tab) return originOf(manager.getTab(input.tab).page.url());
    throw new ToolError(`${action} needs origin or tab.`, "Pass origin such as https://intranet.example.com, or a tab that is on that site.");
  }

  defineTool(server, deps, {
    name: "secrets_list",
    title: "List stored secrets",
    description:
      "List the names of entries in the user's password store, without their values. Use it before signing in to a site: a matching name goes to fill or fill_form as secret (with secret_field username, password or otp), and the server types the value, which you never see. Passwords and other secret fields are then masked in tool results, in the text files the server writes, in page text sent to the ask_pages model and in the server log (one-time codes for 2 minutes); usernames, raw exports (cookies export, network_export, storage export), downloads, binary files and screenshots are not masked. For a site that answers with the browser's own login dialog, pass the name to http_auth instead.",
    input: {
      query: z.string().optional().describe("Keep only names containing this, case-insensitive, for example a site name."),
    },
    readOnly: true,
    handler: async (input) => {
      const names = await secrets.list(input.query);
      if (names.length === 0) return input.query ? `No secret name contains ${JSON.stringify(input.query)}.` : "The password store has no entries.";
      return names.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "http_auth",
    title: "HTTP authentication for an origin",
    description: [
      "Answer HTTP Basic and Digest authentication challenges (the browser's own username and password dialog, which is not part of the page and cannot be filled with fill) for one origin, with the username and password fields of a password-store entry. The credentials are read by the server and never appear in results. Use it when a page or an intranet site answers HTTP 401 with a login dialog, which tab_open and navigate report; for login forms inside the page use fill with secret.",
      "set applies to every tab of the shared profile on that origin, including tabs of other sessions, until clear or until the server restarts; list shows which origins have credentials and from which secret. clear stops answering new challenges, but Chrome keeps credentials it has already accepted for that origin until the browser restarts.",
    ].join("\n"),
    input: {
      action: z.enum(["set", "clear", "list"]).describe("set stores credentials for the origin; clear removes them (all origins when neither origin nor tab is given); list shows the origins that have credentials."),
      origin: z.string().optional().describe("Origin to answer challenges for, such as https://intranet.example.com; a full URL is reduced to its origin. Default: the origin of tab."),
      tab: tabParam.optional().describe("Tab whose current origin is used when origin is not given."),
      secret: z.string().optional().describe("For set: name of a password-store entry from secrets_list; its username field and password are used."),
    },
    handler: async (input) => {
      if (input.action === "list") {
        const entries = manager.profile.listCredentials();
        if (entries.length === 0) return "No origin has HTTP authentication credentials.";
        return entries.map((entry) => `${entry.origin} uses secret ${entry.secret}`).join("\n");
      }
      const context = await manager.ensureContext();
      if (input.action === "clear") {
        const origin = input.origin || input.tab ? targetOrigin(input, "clear") : undefined;
        const removed = await manager.profile.clearCredentials(context, origin);
        if (removed.length === 0) return origin ? `${origin} had no HTTP authentication credentials.` : "No origin had HTTP authentication credentials.";
        return `Removed HTTP authentication credentials for ${removed.join(", ")}. Chrome may still send credentials it already accepted there until the browser restarts.`;
      }
      if (!input.secret) throw new ToolError("set needs secret.", "Pass a name from secrets_list whose entry has a username field.");
      const origin = targetOrigin(input, "set");
      const username = await secrets.get(input.secret, "username");
      const password = await secrets.get(input.secret, "password");
      registerSecret(redactor, input.secret, "password", password);
      await manager.profile.setCredential(context, { origin, secret: input.secret, username, password });
      return `HTTP authentication challenges from ${origin} are now answered with secret ${input.secret}, in every tab of the profile. Reload or navigate the page to send them.`;
    },
  });

  defineTool(server, deps, {
    name: "permissions",
    title: "Grant or clear site permissions",
    description: [
      "Grant browser permissions (geolocation, notifications, camera, microphone, clipboard-read, clipboard-write and others) to an origin, or clear the grants this tool made. Use it when a site asks for location, notifications, camera, microphone or clipboard access: the native permission prompt, the bubble under the address bar, is browser UI and not part of the page, so snapshot, click and dismiss_overlays cannot see or answer it. Grant the permission here, then reload or repeat the page action that asked.",
      "Grants apply to that origin in every tab of the shared profile and add up across calls. The server keeps them and applies them again when the browser relaunches, so they last until cleared or until the server restarts; they are not saved in the profile. Clearing also drops a geolocation grant made by emulate.",
    ].join("\n"),
    input: {
      action: z.enum(["grant", "clear"]).describe("grant adds the permissions in grant for the origin; clear removes every grant of the origin (of all origins when neither origin nor tab is given)."),
      grant: z.array(z.enum(PERMISSION_NAMES)).min(1).optional().describe("For grant: permission names, for example [\"notifications\"] or [\"camera\", \"microphone\"]."),
      origin: z.string().optional().describe("Origin such as https://meet.example.com; a full URL is reduced to its origin. Default: the origin of tab."),
      tab: tabParam.optional().describe("Tab whose current origin is used when origin is not given."),
    },
    handler: async (input) => {
      const context = await manager.ensureContext();
      if (input.action === "clear") {
        const origin = input.origin || input.tab ? targetOrigin(input, "clear") : undefined;
        const cleared = await manager.profile.clearGrants(context, origin);
        const scope = origin ?? "all origins";
        return cleared.length ? `Cleared permissions for ${scope}: ${cleared.join(", ")}.` : `Cleared permission overrides for ${scope}; this tool had granted none there.`;
      }
      if (!input.grant?.length) throw new ToolError("grant needs a list of permission names in grant.");
      const origin = targetOrigin(input, "grant");
      const granted = await manager.profile.grant(context, origin, input.grant);
      return `${origin} now has: ${granted.join(", ")}. Reload the page or repeat the action that asked for permission.`;
    },
  });
}
