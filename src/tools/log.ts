import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withDeadline } from "../shared/async.ts";
import { formatEntry, LOG_LEVELS, LOG_RETENTION_DAYS, readLog } from "../log/logger.ts";
import { defineTool, type ToolDeps } from "./common.ts";

const FLUSH_MS = 2000;

export function registerLogTool(server: McpServer, deps: ToolDeps) {
  const { log } = deps;

  defineTool(server, deps, {
    name: "server_log",
    title: "Read the server log",
    description: [
      "Read this server's own log: every tool call with its request id, duration and outcome, browser launches, crashes and relaunches, MCP sessions, background jobs, and internal faults with their stacks. Use it when a tool call failed or behaved oddly, before retrying or asking the user: a failed result ends with [req <id>], request_id finds that call, and level, tool, since_minutes and contains show what happened around it, such as a browser crash or a relaunch.",
      "It holds only the server's own events; the page's console and network are in console_logs and network_requests. Inputs are summarized: secret, text, value, code, post data and similar fields appear only as their length, URLs keep their query keys with each value replaced by its length, and stored secrets are masked.",
    ].join("\n"),
    input: {
      level: z
        .enum(LOG_LEVELS)
        .optional()
        .describe(
          "Lowest level to include: debug, info, warn or error. Default info. Failed tool calls are warn; faults and crashes are error.",
        ),
      tool: z.string().optional().describe("Only calls of this tool, for example click."),
      request_id: z
        .string()
        .optional()
        .describe(
          "Only the entry with this request id, the 6 hex characters from [req <id>] at the end of a failed result.",
        ),
      since_minutes: z
        .number()
        .int()
        .min(1)
        .max(LOG_RETENTION_DAYS * 24 * 60)
        .optional()
        .describe("Only entries from the last this many minutes."),
      contains: z
        .string()
        .optional()
        .describe("Only entries whose JSON contains this text, case-insensitive."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Most entries to return, newest last. Default 30."),
    },
    readOnly: true,
    handler: async (input) => {
      await withDeadline(log.flush(), FLUSH_MS);
      const result = await readLog(log.dir, {
        level: input.level,
        tool: input.tool,
        requestId: input.request_id
          ?.trim()
          .replace(/^\[?req\s+/i, "")
          .replace(/\]$/, ""),
        sinceMinutes: input.since_minutes,
        contains: input.contains,
        limit: input.limit ?? 30,
      });
      const lines = [
        `Log directory: ${log.dir} (level ${log.level}, daily JSON Lines files kept ${LOG_RETENTION_DAYS} days)`,
      ];
      if (log.failures) lines.push(`${log.failures} log entries could not be written.`);
      if (result.unreadable.length) lines.push(`Could not read: ${result.unreadable.join(", ")}.`);
      if (result.entries.length === 0) lines.push("No matching entries.");
      else
        lines.push(
          `${result.entries.length} entries (newest last):`,
          ...result.entries.map(formatEntry),
        );
      return lines.join("\n");
    },
  });
}
