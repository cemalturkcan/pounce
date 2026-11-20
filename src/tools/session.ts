import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defineTool, type ToolDeps } from "./common.ts";

export function registerSessionTools(server: McpServer, deps: ToolDeps) {
  const { secrets } = deps;

  defineTool(server, deps, {
    name: "secrets_list",
    title: "List stored secrets",
    description:
      "List the names of entries in the user's password store, without their values. Pass a name to fill(secret=...) to enter a credential into a page; the value is read and typed by the server, and passwords and other secret fields are masked in tool results and written files (one-time codes for 2 minutes, usernames not at all, raw exports excepted).",
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
}
