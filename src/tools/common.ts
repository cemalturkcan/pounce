import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskAdapterSource } from "../ask.ts";
import { type BrowserManager, ORPHANED_OWNER, type Tab, UNCLAIMED_OWNER } from "../browser.ts";
import { withTimeout } from "../async.ts";
import { describeError, ToolError } from "../errors.ts";
import type { JobRunner } from "../jobs.ts";
import { type Logger, newRequestId, summarizeInput } from "../log.ts";
import { clipHeadTail, type OutputStore, type Redactor } from "../output.ts";
import type { SecretStore } from "../secrets.ts";

export type ToolDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  jobs: JobRunner;
  ask: AskAdapterSource;
  log: Logger;
};

type ToolImage = { data: Buffer; mimeType: string };
export type ToolOutput = string | { text: string; images?: ToolImage[] };

export type ToolInput<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

type ToolSpec<Shape extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  input: Shape;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (input: z.infer<z.ZodObject<Shape>>, owner: string, signal: AbortSignal) => Promise<ToolOutput>;
};

const RESULT_LOG_CHARS = 500;
const ERROR_LOG_LINES = 3;
const STACK_LOG_LINES = 8;

export const INLINE_SCREENSHOT_MAX_HEIGHT = 6000;
export const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"]);

export const tabParam = z.string().describe("Tab id from tabs_list or tab_open, for example t1.");
export const targetParam = z
  .string()
  .describe("Element to act on: a ref from the latest snapshot of this tab (e12, or f1e3 inside an iframe), or a Playwright selector such as #id, text=Sign in, or role=button[name=\"Save\"].");
export const includeSnapshotParam = z
  .boolean()
  .optional()
  .describe("Append a fresh snapshot of the page to the result, saving a separate snapshot call. Default false.");
export const includeDiffParam = z
  .boolean()
  .optional()
  .describe("Append only the snapshot lines the action added or removed, instead of a whole snapshot. Costs one extra snapshot before the action. Default false.");
export const timeoutParam = (fallback: number) =>
  z.number().int().min(100).max(120_000).optional().describe(`How long to wait before failing, in milliseconds. Default ${fallback}.`);
export const waitUntilParam = z
  .enum(["commit", "domcontentloaded", "load"])
  .optional()
  .describe("Navigation milestone to wait for. Default domcontentloaded; load also waits for images and subframes.");

export function defineTool<Shape extends z.ZodRawShape>(server: McpServer, deps: ToolDeps, spec: ToolSpec<Shape>) {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    callback: (input: unknown, extra: { sessionId?: string; signal: AbortSignal }) => Promise<unknown>,
  ) => void;

  register(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        readOnlyHint: spec.readOnly ?? false,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const requestId = newRequestId();
      const startedAt = performance.now();
      const owner = extra.sessionId ?? "stdio";
      const tabId = (input as { tab?: unknown }).tab;
      const tab = typeof tabId === "string" ? deps.manager.peekTab(tabId) : undefined;
      const moved = tab ? deps.manager.movedSinceSeen(tab) : undefined;
      const foreign = tab !== undefined && tab.owner !== owner && tab.owner !== UNCLAIMED_OWNER && tab.owner !== ORPHANED_OWNER;
      const notes = [foreign ? `Note: ${tab.id} belongs to another session.` : "", moved ? `Note: the tab moved to ${moved} since your last call.` : ""].filter(Boolean);
      const withNote = (text: string) => deps.redactor.redact([...notes, text].join("\n"));
      const record = (fields: Record<string, unknown>) =>
        deps.log.log(fields.ok ? "info" : "warn", "tool_call", {
          requestId,
          session: owner,
          tab: typeof tabId === "string" ? tabId : undefined,
          tool: spec.name,
          ms: Math.round(performance.now() - startedAt),
          ...fields,
          input: summarizeInput(input),
        });
      const endAction = tab ? deps.manager.beginAction(tab, spec.name, owner) : undefined;
      try {
        if (typeof tabId === "string") deps.manager.claimIfOrphaned(tabId, owner);
        const output = await spec.handler(input as z.infer<z.ZodObject<Shape>>, owner, extra.signal);
        const text = withNote(typeof output === "string" ? output : output.text);
        const images = typeof output === "string" ? [] : (output.images ?? []);
        record({ ok: true, images: images.length || undefined, result: deps.log.enabled("debug") ? text.slice(0, RESULT_LOG_CHARS) : undefined });
        return {
          content: [
            { type: "text", text },
            ...images.map((image) => ({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType })),
          ],
        };
      } catch (error) {
        const described = describeError(error);
        record({
          ok: false,
          error: described.split("\n").slice(0, ERROR_LOG_LINES).join("\n"),
          stack: error instanceof Error && !(error instanceof ToolError) ? error.stack?.split("\n").slice(0, STACK_LOG_LINES).join("\n") : undefined,
        });
        return { content: [{ type: "text", text: `${withNote(described)} [req ${requestId}]` }], isError: true };
      } finally {
        endAction?.();
        if (tab) deps.manager.markSeen(tab);
      }
    },
  );
}

export const NO_DOM_CHANGE = "No DOM change after the action.";
export const cancelled = () => new ToolError("The call was cancelled by the client.");

export async function clipToFile(store: OutputStore, kind: string, label: string, text: string, maxChars: number) {
  const clipped = clipHeadTail(text, maxChars);
  if (!clipped.truncated) return text;
  const file = await store.write(kind, store.uniqueName(label, "txt"), text);
  return `${clipped.text}\n[truncated: ${clipped.totalChars} chars total. Full output saved to ${file}.]`;
}

export function tabLine(tab: Tab, owner: string) {
  const ownership = tab.owner === owner ? "yours" : tab.owner === UNCLAIMED_OWNER ? "unclaimed" : tab.owner === ORPHANED_OWNER ? "orphaned" : "other client";
  return `${tab.id} [${ownership}] ${tab.page.url()}`;
}

export const PAGE_READ_TIMEOUT_MS = 15_000;

export function pageBound<T>(promise: Promise<T>, what: string, ms = PAGE_READ_TIMEOUT_MS) {
  return withTimeout(
    promise,
    ms,
    () => new ToolError(`${what} did not finish within ${ms / 1000} s; the page is not answering, so a script in it may be stuck.`, "Reload the tab with navigate, or close it with tab_close (force: true) and open a new one."),
  );
}
