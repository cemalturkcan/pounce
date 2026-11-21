import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BrowserManager } from "../browser/manager.ts";
import { explainPolicyBlock } from "../browser/chrome-policy.ts";
import { describeError, ToolError } from "../shared/errors.ts";
import type { JobRunner } from "../script/jobs.ts";
import { type Logger, newRequestId, summarizeInput } from "../log/logger.ts";
import { clipHeadTail, type OutputStore, type Redactor } from "../shared/output.ts";
import type { SecretStore } from "../shared/secrets.ts";
import type { Notifier } from "../shared/notify.ts";
import type { ToolCallExtra, ToolCallResult } from "../shared/tool-call.ts";
import { ORPHANED_OWNER, type Tab, UNCLAIMED_OWNER } from "../browser/tab.ts";
import type { AskAdapterSource } from "../ask/adapter-source.ts";

export type ToolDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  jobs: JobRunner;
  ask: AskAdapterSource;
  log: Logger;
  notify: Notifier;
};

type ToolImage = { data: Buffer; mimeType: string };
type ToolOutput = string | { text: string; images?: ToolImage[] };

export type ToolFields = NonNullable<Parameters<typeof z.object>[0]>;

export type ToolInput<Fields extends ToolFields> = z.infer<z.ZodObject<Fields>>;

type ToolSpec<Fields extends ToolFields> = {
  name: string;
  title: string;
  description: string;
  input: Fields;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (
    input: ToolInput<Fields>,
    owner: string,
    signal: AbortSignal,
    call: { requestId: string },
  ) => Promise<ToolOutput>;
};

const toolArguments = z.record(z.string(), z.unknown());
export type ToolArguments = z.infer<typeof toolArguments>;
export type ToolCallback = {
  schema: z.ZodObject<ToolFields>;
  call(input: ToolArguments, extra: ToolCallExtra): Promise<ToolCallResult>;
};

const RESULT_LOG_CHARS = 500;
const ERROR_LOG_LINES = 3;
const STACK_LOG_LINES = 8;

export const INLINE_SCREENSHOT_MAX_HEIGHT = 6000;
export const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
]);

export const tabParam = z.string().describe("Tab id from tabs_list or tab_open, for example t1.");
export const targetParam = z
  .string()
  .describe(
    'Element to act on: a ref from the latest snapshot of this tab (such as e12 or f2e12; the f number names the document, which is new after every navigation or reload and different inside an iframe), or a Playwright selector such as #id, text=Sign in, or role=button[name="Save"].',
  );
export const includeSnapshotParam = z
  .boolean()
  .optional()
  .describe(
    "Append a fresh snapshot of the page to the result, saving a separate snapshot call. Default false.",
  );
export const includeDiffParam = z
  .boolean()
  .optional()
  .describe(
    "Append only the snapshot lines the action added or removed, instead of a whole snapshot. Costs one extra snapshot before the action. Default false.",
  );
export const timeoutParam = (fallback: number) =>
  z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .optional()
    .describe(`How long to wait before failing, in milliseconds. Default ${fallback}.`);
export const waitUntilParam = z
  .enum(["commit", "domcontentloaded", "load"])
  .optional()
  .describe(
    "Navigation milestone to wait for. Default domcontentloaded; load also waits for images and subframes.",
  );

function isPlainText(output: ToolOutput): output is string {
  return typeof output === "string";
}

function outputParts(output: ToolOutput) {
  if (isPlainText(output)) return { text: output, images: [] };
  return { text: output.text, images: output.images ?? [] };
}

const tabField = z.object({ tab: z.string().optional() });
const parentField = z.object({ parentRequestId: z.string().optional() });

type CallOutcome =
  | { ok: true; images: number | undefined; result: string | undefined }
  | { ok: false; error: string; stack: string | undefined };

export function defineTool<Fields extends ToolFields>(
  server: McpServer,
  deps: ToolDeps,
  spec: ToolSpec<Fields>,
) {
  const inputSchema = z.object(spec.input);
  server.registerTool<AnySchema, typeof inputSchema>(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema,
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
      const tabId = tabField.safeParse(input).data?.tab;
      const tab = tabId === undefined ? undefined : deps.manager.peekTab(tabId);
      const moved = tab ? deps.manager.movedSinceSeen(tab) : undefined;
      const foreign =
        tab !== undefined &&
        tab.owner !== owner &&
        tab.owner !== UNCLAIMED_OWNER &&
        tab.owner !== ORPHANED_OWNER;
      const notes = [
        foreign ? `Note: ${tab.id} belongs to another session.` : "",
        moved ? `Note: the tab moved to ${moved} since your last call.` : "",
      ].filter(Boolean);
      const withNote = (text: string) => deps.redactor.redact([...notes, text].join("\n"));
      const record = (outcome: CallOutcome) =>
        deps.log.log(outcome.ok ? "info" : "warn", "tool_call", {
          requestId,
          parent: parentField.safeParse(extra).data?.parentRequestId,
          session: owner,
          tab: tabId,
          tool: spec.name,
          ms: Math.round(performance.now() - startedAt),
          ...outcome,
          input: summarizeInput(input),
        });
      const endAction = tab ? deps.manager.beginAction(tab, spec.name, owner) : undefined;
      const endWork = deps.manager.beginWork(owner);
      try {
        if (tabId !== undefined) deps.manager.claimIfOrphaned(tabId, owner);
        const output = await spec.handler(input, owner, extra.signal, {
          requestId,
        });
        const { text: rawText, images } = outputParts(output);
        const text = withNote(rawText);
        record({
          ok: true,
          images: images.length || undefined,
          result: deps.log.enabled("debug") ? text.slice(0, RESULT_LOG_CHARS) : undefined,
        });
        return {
          content: [
            { type: "text" as const, text },
            ...images.map((image) => ({
              type: "image" as const,
              data: image.data.toString("base64"),
              mimeType: image.mimeType,
            })),
          ],
        };
      } catch (cause) {
        const base = describeError(cause);
        const policy = await explainPolicyBlock(base, deps.manager.config.chromePolicyDirs).catch(
          () => undefined,
        );
        const described = policy ? `${base}\n${policy}` : base;
        record({
          ok: false,
          error: described.split("\n").slice(0, ERROR_LOG_LINES).join("\n"),
          stack:
            cause instanceof Error && !(cause instanceof ToolError)
              ? cause.stack?.split("\n").slice(0, STACK_LOG_LINES).join("\n")
              : undefined,
        });
        return {
          content: [{ type: "text" as const, text: `${withNote(described)} [req ${requestId}]` }],
          isError: true,
        };
      } finally {
        endAction?.();
        if (tab) deps.manager.markSeen(tab);
        endWork();
      }
    },
  );
}

export const NO_DOM_CHANGE = "No DOM change after the action.";

export async function clipToFile(
  store: OutputStore,
  kind: string,
  label: string,
  text: string,
  maxChars: number,
) {
  const clipped = clipHeadTail(text, maxChars);
  if (!clipped.truncated) return text;
  const file = await store.write(kind, store.uniqueName(label, "txt"), text);
  return `${clipped.text}\n[truncated: ${clipped.totalChars} chars total. Full output saved to ${file}.]`;
}

export function tabLine(tab: Tab, owner: string) {
  const ownership =
    tab.owner === owner
      ? "yours"
      : tab.owner === UNCLAIMED_OWNER
        ? "unclaimed"
        : tab.owner === ORPHANED_OWNER
          ? "orphaned"
          : "other client";
  return `${tab.id} [${ownership}] ${tab.page.url()}`;
}
