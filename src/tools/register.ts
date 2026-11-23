import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { ToolCallExtra, ToolCallResult } from "../shared/tool-call.ts";
import { registerActionTools } from "./actions.ts";
import { registerAskTools } from "./ask.ts";
import type { ToolArguments, ToolDeps, ToolFields } from "./common.ts";
import { registerDataTools } from "./data.ts";
import { registerLogsTool } from "./logs.ts";
import { registerNetworkTools } from "./network.ts";
import { registerPageReadTools } from "./page-read.ts";
import { registerRecordingTools } from "./recording.ts";
import { registerScriptTools } from "./script.ts";
import { registerSessionTools } from "./session.ts";
import { registerTabTools } from "./tabs.ts";
import { registerVisualTools } from "./visual.ts";

export function registerTools(server: McpServer, deps: ToolDeps) {
  registerTabTools(server, deps);
  registerPageReadTools(server, deps);
  registerActionTools(server, deps);
  registerNetworkTools(server, deps);
  registerScriptTools(server, deps);
  registerDataTools(server, deps);
  registerSessionTools(server, deps);
  registerVisualTools(server, deps);
  registerRecordingTools(server, deps);
  registerAskTools(server, deps);
  registerLogsTool(server, deps);
}

export type RecordedTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema: z.ZodObject<ToolFields>;
    annotations?: ToolAnnotations;
  };
  callback: (input: ToolArguments, extra: ToolCallExtra) => Promise<ToolCallResult>;
};

const recorded = new WeakMap<ToolDeps, RecordedTool[]>();

export function recordedTools(deps: ToolDeps) {
  const known = recorded.get(deps);
  if (known) return known;
  const tools: RecordedTool[] = [];
  const recorder = {
    registerTool(name: string, config: RecordedTool["config"], callback: RecordedTool["callback"]) {
      tools.push({ name, config, callback });
    },
  };
  // SAFETY: the tool registrars only call registerTool, which the recorder implements.
  registerTools(recorder as McpServer, deps);
  recorded.set(deps, tools);
  return tools;
}
