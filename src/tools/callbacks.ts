import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerActionTools } from "./actions.ts";
import type { ToolCallback, ToolCallExtra, ToolCallResult, ToolDeps } from "./common.ts";
import { registerPageReadTools } from "./page-read.ts";
import { registerTabTools } from "./tabs.ts";

const collected = new WeakMap<ToolDeps, Map<string, ToolCallback>>();

export function collectToolCallbacks(deps: ToolDeps) {
  const known = collected.get(deps);
  if (known) return known;
  const callbacks = new Map<string, ToolCallback>();
  const stub = {
    registerTool(name: string, config: { inputSchema: z.ZodRawShape }, callback: (input: unknown, extra: ToolCallExtra) => Promise<ToolCallResult>) {
      const schema = z.object(config.inputSchema);
      callbacks.set(name, {
        shape: config.inputSchema,
        call: async (input, extra) => {
          const parsed = schema.safeParse(input);
          if (!parsed.success) return { content: [{ type: "text", text: `Invalid input for ${name}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}` }], isError: true };
          return callback(parsed.data, extra);
        },
      });
    },
  } as unknown as McpServer;
  registerTabTools(stub, deps);
  registerPageReadTools(stub, deps);
  registerActionTools(stub, deps);
  collected.set(deps, callbacks);
  return callbacks;
}
