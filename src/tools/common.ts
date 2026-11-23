import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type BrowserManager, DRAW_WAIT_MS } from "../browser/manager.ts";
import { explainPolicyBlock } from "../browser/chrome-policy.ts";
import { describeError, ToolError } from "../shared/errors.ts";
import type { JobRunner } from "../script/jobs.ts";
import { type Logger, newRequestId, summarizeInput } from "../log/logger.ts";
import {
  clipHeadTail,
  fieldPointer,
  type OutputStore,
  type Redactor,
  shownUrl,
  type StructuredFields,
} from "../shared/output.ts";
import type { SecretStore } from "../shared/secrets.ts";
import type { Notifier } from "../shared/notify.ts";
import type { ToolCallExtra, ToolCallResult } from "../shared/tool-call.ts";
import { drainEvents, ORPHANED_OWNER, type Tab, UNCLAIMED_OWNER } from "../browser/tab.ts";
import { DIALOG_TOOK_OVER, dialogBlocked, dialogLine, raceDialog } from "../browser/dialogs.ts";
import { type CallScope, inCallScope } from "../shared/call-scope.ts";
import { type Point, viewportOf } from "../page/human.ts";
import type { AskAdapterSource } from "../ask/adapter-source.ts";
import type { Recordings } from "../browser/recording.ts";

export type ToolDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  jobs: JobRunner;
  ask: AskAdapterSource;
  log: Logger;
  notify: Notifier;
  recordings: Recordings;
};

type ToolImage = { data: Buffer; mimeType: string };
type ToolOutput = string | { text: string; images?: ToolImage[] };

export type ToolFields = NonNullable<Parameters<typeof z.object>[0]>;

export type ToolInput<Fields extends ToolFields> = z.infer<z.ZodObject<Fields>>;

type StructuredOutput<Output extends ToolFields> = {
  text: string;
  structuredText?: string;
  payloadFrame?: (shown: string) => string;
  images?: ToolImage[];
  data: z.infer<z.ZodObject<Output>>;
};

type ToolSpec<Fields extends ToolFields, Output extends ToolFields | undefined> = {
  name: string;
  title: string;
  description: string;
  input: Fields;
  output?: Output;
  payload?: Output extends ToolFields ? (keyof Output & string)[] : never;
  readOnly?: boolean;
  destructive?: boolean;
  runsWithDialog?: boolean;
  racesDialogs?: boolean;
  handler: (
    input: ToolInput<Fields>,
    owner: string,
    signal: AbortSignal,
    call: { requestId: string },
  ) => Promise<Output extends ToolFields ? StructuredOutput<Output> : ToolOutput>;
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

export const tabParam = z.string().describe("Tab id from navigate or tabs, for example t482913.");
export const targetParam = z
  .string()
  .describe(
    'Element to act on: a ref from the latest snapshot of this tab (such as e12 or f2e12; the f number names the document, which is new after every navigation or reload and different inside an iframe; a ref acts only on the very element the snapshot showed, while it is still on the page with the same role and name and the tab and its iframe are on the same document and address, hash included, and fails otherwise), or a Playwright selector such as #id, text=Sign in, or role=button[name="Save"].',
  );
export const pointParams = {
  x: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Horizontal viewport coordinate in CSS pixels (as in snapshot boxes), with y, instead of target: for canvas, maps, charts and widgets without refs.",
    ),
  y: z
    .number()
    .min(0)
    .optional()
    .describe("Vertical viewport coordinate in CSS pixels, with x, instead of target."),
};

export async function chosenAim(
  tab: Tab,
  input: { target?: string; x?: number; y?: number },
): Promise<{ point: Point } | { target: string }> {
  const { target, x, y } = input;
  if (target !== undefined && x === undefined && y === undefined) return { target };
  if (target !== undefined || x === undefined || y === undefined)
    throw new ToolError("Give either target or x and y.");
  const viewport = await viewportOf(tab.page);
  if (x >= viewport.width || y >= viewport.height)
    throw new ToolError(
      `The point (${x}, ${y}) is outside the viewport of ${viewport.width}x${viewport.height}.`,
      "Use coordinates inside the visible viewport, such as from snapshot boxes; scroll first to reach other parts of the page.",
    );
  return { point: { x, y } };
}

export const includeSnapshotParam = z
  .boolean()
  .optional()
  .describe(
    "Append a fresh snapshot of the page to the result, saving a separate snapshot call; after a page load it waits briefly for the page's requests and content to settle first. Default false.",
  );
export const includeDiffParam = z
  .boolean()
  .optional()
  .describe(
    "Append only the snapshot lines the action added or removed, instead of a whole snapshot. Costs one extra snapshot before the action. Default false.",
  );
export const humanParam = z
  .boolean()
  .optional()
  .describe(
    "Move the mouse along curved paths, press and type with human timing instead of instant input; use it on sites with behavioral bot detection, after a CAPTCHA or challenge appeared, or when a flow rejects instant input. Slower. Default false.",
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

type HandlerOutput =
  | ToolOutput
  | {
      text: string;
      structuredText?: string;
      payloadFrame?: (shown: string) => string;
      images?: ToolImage[];
      data: StructuredFields;
    };

function isPlainText(output: HandlerOutput): output is string {
  return typeof output === "string";
}

function outputParts(output: HandlerOutput) {
  if (isPlainText(output))
    return {
      text: output,
      structuredText: undefined,
      payloadFrame: undefined,
      images: [],
      data: undefined,
    };
  return {
    text: output.text,
    structuredText: "structuredText" in output ? output.structuredText : undefined,
    payloadFrame: "payloadFrame" in output ? output.payloadFrame : undefined,
    images: output.images ?? [],
    data: "data" in output ? output.data : undefined,
  };
}

function pointedText(
  text: string,
  payloads: string[] | undefined,
  frame: ((shown: string) => string) | undefined,
  data: StructuredFields | undefined,
) {
  const payload = payloads?.find((name) => data?.[name] !== undefined);
  if (payload === undefined || frame === undefined) return text;
  return frame(fieldPointer(payload));
}

const tabField = z.object({ tab: z.string().optional() });
const handlerNotes = z.array(z.string()).optional();
const parentField = z.object({ parentRequestId: z.string().optional() });

type CallOutcome =
  | { ok: true; images: number | undefined; result: string | undefined }
  | { ok: false; error: string; stack: string | undefined };

export function defineTool<
  Fields extends ToolFields,
  Output extends ToolFields | undefined = undefined,
>(server: McpServer, deps: ToolDeps, spec: ToolSpec<Fields, Output>) {
  const inputSchema = z.strictObject(spec.input);
  server.registerTool<AnySchema, typeof inputSchema>(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema,
      outputSchema:
        spec.output &&
        z
          .object(spec.output)
          .partial()
          .extend({ text: z.string(), notes: z.array(z.string()).optional() }),
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
        moved ? `Note: the tab moved to ${shownUrl(moved)} since your last call.` : "",
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
      const takeover = new AbortController();
      const scope: CallScope = {
        signal: AbortSignal.any([extra.signal, takeover.signal]),
        steps: [],
      };
      let running: Promise<HandlerOutput> | undefined;
      try {
        if (tabId !== undefined) deps.manager.claimIfOrphaned(tabId, owner);
        if (tab?.dialog && !spec.runsWithDialog) throw dialogBlocked(tab, tab.dialog, spec.name);
        const { signal } = scope;
        const drawn = tab && !tab.dialog ? deps.manager.untilDrawn(tab) : Promise.resolve(true);
        running = drawn.then((ready) => {
          if (!ready && tab)
            notes.push(
              `Note: ${tab.id} had not drawn a frame within ${DRAW_WAIT_MS / 1000} s when this call started, so the page may have missed it; if the result shows no effect, try again.`,
            );
          signal.throwIfAborted();
          return inCallScope(scope, () => spec.handler(input, owner, signal, { requestId }));
        });
        const output =
          tab && spec.racesDialogs !== false
            ? await raceDialog(tab, running, (dialog) => {
                const acting = scope.acting ? `It opened after ${scope.acting}.` : "";
                const done = scope.steps.length
                  ? `Done before the dialog:\n${scope.steps.join("\n")}`
                  : "";
                takeover.abort(new ToolError(DIALOG_TOOK_OVER));
                return [dialogLine(dialog), acting, done, ...drainEvents(tab)]
                  .filter(Boolean)
                  .join("\n");
              })
            : await running;
        const { text: rawText, structuredText, payloadFrame, images, data } = outputParts(output);
        notes.push(...(scope.notes ?? []));
        const text = withNote(rawText);
        const allNotes = [...notes, ...(handlerNotes.safeParse(data?.notes).data ?? [])];
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
          structuredContent: spec.output && {
            ...(data && deps.redactor.redactFields(data)),
            notes: allNotes.length ? allNotes.map((note) => deps.redactor.redact(note)) : undefined,
            text: deps.redactor.redact(
              [
                ...(allNotes.length ? [fieldPointer("notes")] : []),
                structuredText ?? pointedText(rawText, spec.payload, payloadFrame, data),
              ].join("\n"),
            ),
          },
        };
      } catch (cause) {
        notes.push(...(scope.notes ?? []));
        const base = describeError(cause, scope.selectors);
        const policy = await explainPolicyBlock(base, deps.manager.config.chromePolicyDirs).catch(
          () => undefined,
        );
        const described = policy ? `${base}\n${policy}` : base;
        const failed = cause instanceof ToolError ? cause.cause : cause;
        record({
          ok: false,
          error: described.split("\n").slice(0, ERROR_LOG_LINES).join("\n"),
          stack:
            failed instanceof Error && !(failed instanceof ToolError)
              ? failed.stack?.split("\n").slice(0, STACK_LOG_LINES).join("\n")
              : undefined,
        });
        const text = `${withNote(described)} [req ${requestId}]`;
        const data = cause instanceof ToolError ? cause.data : undefined;
        return {
          content: [{ type: "text" as const, text }],
          isError: true,
          structuredContent: spec.output && data && { ...deps.redactor.redactFields(data), text },
        };
      } finally {
        if (takeover.signal.aborted && running && endAction)
          void running.then(endAction, endAction);
        else endAction?.();
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
  if (!clipped.truncated) return { text, preview: text, totalChars: text.length, file: undefined };
  const file = await store.write(kind, store.uniqueName(label, "txt"), text);
  return {
    text: `${clipped.text}\n[truncated: ${clipped.totalChars} chars total. Full output saved to ${file}.]`,
    preview: clipped.text,
    totalChars: clipped.totalChars,
    file,
  };
}

export const TAB_OWNERSHIPS = ["yours", "unclaimed", "orphaned", "other client"] as const;

export function tabOwnership(tab: Tab, owner: string): (typeof TAB_OWNERSHIPS)[number] {
  if (tab.owner === owner) return "yours";
  if (tab.owner === UNCLAIMED_OWNER) return "unclaimed";
  if (tab.owner === ORPHANED_OWNER) return "orphaned";
  return "other client";
}
