import { z } from "zod";
import { type AskAdapter, type AskImageBlock, type AskMessage, type AskTextBlock, type AskToolDefinition, type AskToolResultBlock, type AskToolUseBlock, type AskUsage, type AskUserBlock, type ConverseReply, converseLogged } from "./ask-adapter.ts";
import { AskSetupError, DEFAULT_MAX_OUTPUT_TOKENS } from "./ask.ts";
import { untilAborted, withDeadline } from "./async.ts";
import type { TranscriptWriter } from "./browse-capture.ts";
import { describeError } from "./errors.ts";
import { logEvent } from "./log.ts";

export type ToolExecution = { content: (AskTextBlock | AskImageBlock)[]; isError: boolean; blocked?: string };

export interface BrowseExecutor {
  tools: AskToolDefinition[];
  validate(name: string, input: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  run(name: string, input: unknown, signal: AbortSignal): Promise<ToolExecution>;
  newTabsNote(): string | undefined;
  currentUrl(): string | undefined;
  close(): Promise<void>;
}

export type BrowseMode = "answer" | "review";
export type BrowseStatus = "found" | "partial" | "not_found" | "blocked";
export type BrowseOutcome = BrowseStatus | "no_report" | "refused" | "cut_off" | "context_full" | "step_limit" | "timed_out" | "cancelled" | "failed";
export type BrowseIssue = { severity: "high" | "medium" | "low"; where: string; issue: string };
export type BrowseToolCall = { name: string; target?: string; error?: string; blocked?: string };

export type BrowseResult = {
  source: string;
  url: string;
  finalUrl?: string;
  outcome: BrowseOutcome;
  lines: string[];
  issues?: BrowseIssue[];
  how?: string;
  steps: number;
  toolCalls: BrowseToolCall[];
  usage?: AskUsage;
  ms: number;
  error?: string;
  transcript?: string;
};

export type BrowseOptions = {
  mode: BrowseMode;
  source: string;
  url: string;
  system: string;
  firstMessage: string;
  model: string;
  maxTokens: number;
  maxSteps?: number;
  modelTimeoutMs?: number;
  pageTimeoutMs?: number;
  signal: AbortSignal;
  log: { requestId: string; page: string; tab?: string; reason?: string };
  capture?: TranscriptWriter;
};

export const TOOL_GUARD_MS = 120_000;
export const CLOSE_GRACE_MS = 5000;
const MAX_PAUSES = 5;
const STALL_NOTE_AT = 3;
const STALL_STOP_AT = 6;
const TARGET_CHARS = 200;

export const NUDGE = "Call report now with what you found, or status not_found.";
export const STEP_LIMIT_NUDGE = "Step limit reached: call report now.";
export const STALL_NOTE = "This is the third identical call with no change; try something else or call report.";

const status = z.enum(["found", "partial", "not_found", "blocked"]).describe("found: everything the task asks for this page; partial: some of it; not_found: the page and the pages it links to do not show it; blocked: a sign-in wall, a CAPTCHA or a refused action stands in the way.");
const how = z.string().describe("One short English sentence on what you did, for the logs.");

export const REPORT_SCHEMAS = {
  answer: z.strictObject({
    status,
    lines: z.array(z.string()).describe("The facts, one per entry, each naming its subject and keeping the conditions the page attaches."),
    how,
  }),
  review: z.strictObject({
    status,
    issues: z
      .array(
        z.strictObject({
          severity: z.enum(["high", "medium", "low"]).describe("high for unmistakable breakage, medium when visibly wrong but usable, low for polish."),
          where: z.string().describe("The place in words a developer can find, including the interaction."),
          issue: z.string().describe("What is wrong and, when the page makes it clear, what it should look like."),
        }),
      )
      .describe("What a visitor would see as broken after the interaction; empty when it looks right."),
    how,
  }),
} as const;

const REPORT_DESCRIPTION = "Finish the task: send the facts you found for this page with a status. Call it exactly once, as your last call.";
const REVIEW_REPORT_DESCRIPTION = "Finish the task: send the issues you found after the interaction with a status. Call it exactly once, as your last call.";

export const REPORT_TOOLS: Record<BrowseMode, AskToolDefinition> = {
  answer: { name: "report", description: REPORT_DESCRIPTION, inputSchema: z.toJSONSchema(REPORT_SCHEMAS.answer, { io: "input" }) as Record<string, unknown> },
  review: { name: "report", description: REVIEW_REPORT_DESCRIPTION, inputSchema: z.toJSONSchema(REPORT_SCHEMAS.review, { io: "input" }) as Record<string, unknown> },
};

export function validateWith(schema: z.ZodType, input: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "input";
    const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
    return `${where}: ${issue.message}${keys}`;
  });
  return { ok: false, error: `Invalid input: ${issues.join("; ")}` };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function targetOf(input: unknown) {
  if (!input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  const value = [fields.target, fields.url, fields.query, fields.key, fields.tab].find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value.slice(0, TARGET_CHARS) : undefined;
}

function firstLine(error: unknown) {
  return describeError(error).split("\n")[0] ?? "";
}

function addUsage(total: AskUsage, usage: AskUsage | undefined) {
  for (const [key, value] of Object.entries(usage ?? {})) if (typeof value === "number" && Number.isFinite(value)) total[key] = (total[key] ?? 0) + value;
}

const textBlock = (text: string): AskTextBlock => ({ type: "text", text });
const errorResult = (toolUseId: string, text: string): AskToolResultBlock => ({ type: "tool_result", toolUseId, content: [textBlock(text)], isError: true });
const changed = (execution: ToolExecution) => execution.content.some((part) => part.type === "text" && /^(The page changed|Navigated to)/m.test(part.text));

class Stopped extends Error {}

export async function runBrowse(adapter: AskAdapter, executor: BrowseExecutor, options: BrowseOptions): Promise<BrowseResult> {
  const startedAt = Date.now();
  const pageTimeout = options.pageTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.pageTimeoutMs);
  const signal = pageTimeout ? AbortSignal.any([options.signal, pageTimeout]) : options.signal;
  const tools = [...executor.tools, REPORT_TOOLS[options.mode]];
  const names = tools.map((tool) => tool.name);
  const messages: AskMessage[] = [{ role: "user", content: [textBlock(options.firstMessage)] }];
  const usage: AskUsage = {};
  const result: BrowseResult = { source: options.source, url: options.url, outcome: "failed", lines: [], steps: 0, toolCalls: [], ms: 0 };
  const conversationId = `${options.log.requestId}-${options.log.page}`;
  let nudged = false;
  let pauses = 0;
  let finalTurn = false;
  let stall = { key: "", count: 0 };

  logEvent("browse_page_start", { requestId: options.log.requestId, page: options.log.page, url: options.url, tab: options.log.tab, reason: options.log.reason });

  const end = (outcome: BrowseOutcome, error?: string) => {
    result.outcome = outcome;
    if (error) result.error = error;
    return result;
  };

  const stoppedOutcome = (timedOut: boolean): BrowseOutcome => (options.signal.aborted ? "cancelled" : timedOut || pageTimeout?.aborted ? "timed_out" : "failed");

  const applyReport = (value: unknown) => {
    const report = value as { status: BrowseStatus; lines?: string[]; issues?: BrowseIssue[]; how: string };
    result.how = report.how;
    if (report.lines) result.lines = report.lines.map((line) => line.trim()).filter(Boolean);
    if (report.issues) result.issues = report.issues;
    return end(report.status);
  };

  const execute = async (use: AskToolUseBlock): Promise<{ block: AskToolResultBlock; execution?: ToolExecution }> => {
    if (!names.includes(use.name)) {
      result.toolCalls.push({ name: use.name, error: "unknown tool" });
      return { block: errorResult(use.id, `Unknown tool ${use.name}. Tools: ${names.join(", ")}.`) };
    }
    const target = targetOf(use.input);
    const call: BrowseToolCall = { name: use.name, ...(target ? { target } : {}) };
    result.toolCalls.push(call);
    const checked = executor.validate(use.name, use.input);
    if (!checked.ok) {
      call.error = checked.error;
      return { block: errorResult(use.id, checked.error) };
    }
    let execution: ToolExecution;
    const guard = AbortSignal.timeout(TOOL_GUARD_MS);
    const toolSignal = AbortSignal.any([signal, guard]);
    try {
      execution = await untilAborted(executor.run(use.name, checked.value, toolSignal), toolSignal, () =>
        signal.aborted ? new Stopped("stopped") : new Error(`${use.name} did not finish within ${TOOL_GUARD_MS / 1000} s.`),
      );
    } catch (error) {
      if (error instanceof Stopped) throw error;
      call.error = firstLine(error);
      return { block: errorResult(use.id, describeError(error)) };
    }
    if (execution.blocked) {
      call.blocked = execution.blocked;
      logEvent("browse_blocked", { requestId: options.log.requestId, page: options.log.page, tool: use.name, reason: execution.blocked });
      return { block: errorResult(use.id, `Refused: ${execution.blocked}. This path is closed; look for the information another way or report what you have.`) };
    }
    if (execution.isError) call.error = execution.content.map((part) => (part.type === "text" ? part.text : "")).join("\n").split("\n")[0];
    return { block: { type: "tool_result", toolUseId: use.id, content: execution.content, ...(execution.isError ? { isError: true } : {}) }, execution };
  };

  const converse = async () => {
    const modelTimeout = options.modelTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.modelTimeoutMs);
    const modelSignal = modelTimeout ? AbortSignal.any([signal, modelTimeout]) : signal;
    const input = { system: options.system, tools, messages: [...messages], model: options.model, maxTokens: options.maxTokens, signal: modelSignal, conversationId };
    const turnStartedAt = Date.now();
    result.steps += 1;
    try {
      const reply: ConverseReply = await untilAborted(
        converseLogged(adapter, input, { tool: "ask_pages.browse", call: result.steps, requestId: options.log.requestId, page: options.log.page, step: result.steps }),
        modelSignal,
        () => new Stopped("stopped"),
      );
      await options.capture?.turn({ input, reply, ms: Date.now() - turnStartedAt });
      return { reply: { ...reply, content: reply?.content ?? [] }, timedOut: modelTimeout?.aborted === true };
    } catch (error) {
      await options.capture?.turn({ input, error: firstLine(error), ms: Date.now() - turnStartedAt });
      if (error instanceof AskSetupError) throw error;
      if (signal.aborted || modelTimeout?.aborted) return { stopped: stoppedOutcome(modelTimeout?.aborted === true) };
      return { error: firstLine(error) };
    }
  };

  const loop = async (): Promise<BrowseResult> => {
    for (;;) {
      if (signal.aborted) return end(stoppedOutcome(false));
      const called = await converse();
      if ("stopped" in called) return end(called.stopped ?? "failed");
      if ("error" in called) return end("failed", called.error);
      const { reply, timedOut } = called;
      addUsage(usage, reply.usage);
      const content = reply.content;
      const stop = reply.stopReason;
      if (stop === "max_tokens") return end("cut_off", options.maxTokens < DEFAULT_MAX_OUTPUT_TOKENS ? "the reply hit the output limit; raise max_output_tokens" : "the reply hit the output limit");
      if (stop === "model_context_window_exceeded") return end("context_full", "the conversation outgrew the model's context window");
      if (stop === "refusal") return end("refused", "the model refused (stop reason refusal)");
      if (stop === "interrupted") return end(timedOut ? "timed_out" : "failed", "the model's reply was interrupted");
      const uses = content.filter((block): block is AskToolUseBlock => block.type === "tool_use");
      if (uses.length) {
        messages.push({ role: "assistant", content });
        pauses = 0;
        const blocks: AskUserBlock[] = [];
        const notes: string[] = [];
        for (const [index, use] of uses.entries()) {
          if (use.name === "report") {
            const checked = validateWith(REPORT_SCHEMAS[options.mode], use.input);
            if (checked.ok) {
              const skipped = uses.slice(index + 1).map((other) => other.name);
              if (skipped.length) logEvent("skipped_after_report", { requestId: options.log.requestId, page: options.log.page, tools: skipped });
              return applyReport(checked.value);
            }
            result.toolCalls.push({ name: "report", error: checked.error });
            blocks.push(errorResult(use.id, checked.error));
            continue;
          }
          if (finalTurn) return end("step_limit");
          const { block, execution } = await execute(use);
          blocks.push(block);
          if (!execution) continue;
          const key = `${use.name} ${canonical(use.input)}`;
          stall = changed(execution) ? { key: "", count: 0 } : { key, count: stall.key === key ? stall.count + 1 : 1 };
          if (stall.count >= STALL_STOP_AT) return end("no_report", "the same call kept changing nothing");
          if (stall.count === STALL_NOTE_AT) notes.push(STALL_NOTE);
        }
        if (finalTurn) return end("step_limit");
        const tabsNote = executor.newTabsNote();
        if (tabsNote) notes.push(tabsNote);
        if (options.maxSteps !== undefined && result.steps >= options.maxSteps) {
          finalTurn = true;
          notes.push(STEP_LIMIT_NUDGE);
        }
        messages.push({ role: "user", content: [...blocks, ...notes.map(textBlock)] });
        continue;
      }
      if (content.length) messages.push({ role: "assistant", content });
      if (stop === "pause_turn") {
        pauses += 1;
        if (pauses > MAX_PAUSES) return end("failed", `the model paused ${pauses} times in a row`);
        continue;
      }
      if (finalTurn) return end("step_limit");
      if (nudged) return end("no_report", "the model stopped without calling report");
      nudged = true;
      messages.push({ role: "user", content: [textBlock(NUDGE)] });
    }
  };

  try {
    await loop();
  } catch (error) {
    if (error instanceof AskSetupError) throw error;
    if (error instanceof Stopped) end(stoppedOutcome(false));
    else end("failed", firstLine(error));
  } finally {
    result.finalUrl = executor.currentUrl();
    await withDeadline(executor.close(), CLOSE_GRACE_MS).catch(() => undefined);
    result.ms = Date.now() - startedAt;
    if (Object.keys(usage).length) result.usage = usage;
    if (options.capture) result.transcript = options.capture.dir;
    logEvent("browse_page_end", { requestId: options.log.requestId, page: options.log.page, outcome: result.outcome, steps: result.steps, toolCalls: result.toolCalls.length, usage: result.usage, ms: result.ms, finalUrl: result.finalUrl });
  }
  await options.capture?.finish(result).catch(() => undefined);
  return result;
}
