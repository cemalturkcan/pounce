import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDeps } from "./common.ts";
import { registerGestureTools } from "./gestures.ts";
import { registerInputTools } from "./input.ts";
import { registerWaitTools } from "./waits.ts";

export function registerActionTools(server: McpServer, deps: ToolDeps) {
  registerInputTools(server, deps);
  registerGestureTools(server, deps);
  registerWaitTools(server, deps);
}
