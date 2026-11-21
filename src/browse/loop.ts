import { z } from "zod";
import {
  type AskAdapter,
  type AskImageBlock,
  type AskMessage,
  type AskTextBlock,
  type AskToolDefinition,
  type AskToolResultBlock,
  type AskToolUseBlock,
  type AskUsage,
  type AskUserBlock,
  type ConverseReply,
  converseLogged,
  firstErrorLine,
  addUsage,
} from "../ask/adapter.ts";
import { AskSetupError } from "../ask/errors.ts";
import {
  type BrowseOutcome,
  type BrowseResult,
  type BrowseToolCall,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../ask/run.ts";
import { untilAborted, withDeadline } from "../shared/async.ts";
import type { TranscriptWriter } from "./transcript.ts";
import type { AskMode } from "../ask/types.ts";
import type { BrowseInput } from "./tool-table.ts";
import { type Checked, checkReport, type Report, REPORT_TOOLS } from "./report.ts";
import { describeError } from "../shared/errors.ts";
import { logEvent } from "../log/logger.ts";

export type ToolExecution = {
  content: (AskTextBlock | AskImageBlock)[];
  isError: boolean;
  blocked?: string;
};

export interface BrowseExecutor {
  tools: AskToolDefinition[];
  validate(use: AskToolUseBlock): Checked<BrowseInput>;
  run(name: string, input: BrowseInput, signal: AbortSignal): Promise<ToolExecution>;
  newTabsNote(): string | undefined;
  currentUrl(): string | undefined;
  close(): Promise<void>;
}

export type BrowseOptions = {
  mode: AskMode;
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

const TOOL_GUARD_MS = 120_000;
const CLOSE_GRACE_MS = 5000;
const MAX_PAUSES = 5;
const STALL_NOTE_AT = 3;
const STALL_STOP_AT = 6;
const TARGET_CHARS = 200;

const NUDGE = "Call report now with what you found, or status not_found.";
const STEP_LIMIT_NUDGE = "Step limit reached: call report now.";
const STALL_NOTE =
  "This is the third identical call with no change; try something else or call report.";

const jsonObject = z.record(z.string(), z.unknown());

function canonicalInput(use: AskToolUseBlock) {
  return (
    JSON.stringify(use.input, (_key, value) => {
      const object = jsonObject.safeParse(value);
      if (!object.success) return value;
      return Object.fromEntries(
        Object.entries(object.data).toSorted(([left], [right]) => (left < right ? -1 : 1)),
      );
    }) ?? "null"
  );
}

const optionalText = z.string().optional().catch(undefined);
const targetFields = z
  .object({
    target: optionalText,
    url: optionalText,
    query: optionalText,
    key: optionalText,
    tab: optionalText,
  })
  .catch({});

function targetOf(use: AskToolUseBlock) {
  const fields = targetFields.parse(use.input);
  const value = [fields.target, fields.url, fields.query, fields.key, fields.tab].find(
    (candidate) => candidate !== undefined,
  );
  return value?.slice(0, TARGET_CHARS);
}

const textBlock = (text: string): AskTextBlock => ({ type: "text", text });
const errorResult = (toolUseId: string, text: string): AskToolResultBlock => ({
  type: "tool_result",
  toolUseId,
  content: [textBlock(text)],
  isError: true,
});
const changed = (execution: ToolExecution) =>
  execution.content.some(
    (part) => part.type === "text" && /^(The page changed|Navigated to)/m.test(part.text),
  );

class Stopped extends Error {}

export async function runBrowse(
  adapter: AskAdapter,
  executor: BrowseExecutor,
  options: BrowseOptions,
): Promise<BrowseResult> {
  const startedAt = Date.now();
  const pageTimeout =
    options.pageTimeoutMs === undefined ? undefined : AbortSignal.timeout(options.pageTimeoutMs);
  const signal = pageTimeout ? AbortSignal.any([options.signal, pageTimeout]) : options.signal;
  const tools = [...executor.tools, REPORT_TOOLS[options.mode]];
  const names = tools.map((tool) => tool.name);
  const messages: AskMessage[] = [{ role: "user", content: [textBlock(options.firstMessage)] }];
  const usage: AskUsage = {};
  const result: BrowseResult = {
    source: options.source,
    url: options.url,
    outcome: "failed",
    lines: [],
    steps: 0,
    toolCalls: [],
    ms: 0,
  };
  const conversationId = `${options.log.requestId}-${options.log.page}`;
  let nudged = false;
  let pauses = 0;
  let finalTurn = false;
  let stall = { key: "", count: 0 };

  logEvent("browse_page_start", {
    requestId: options.log.requestId,
    page: options.log.page,
    url: options.url,
    tab: options.log.tab,
    reason: options.log.reason,
  });

  const end = (outcome: BrowseOutcome, error?: string) => {
    result.outcome = outcome;
    if (error) result.error = error;
    return result;
  };

  const stoppedOutcome = (timedOut: boolean): BrowseOutcome =>
    options.signal.aborted
      ? "cancelled"
      : timedOut || pageTimeout?.aborted
        ? "timed_out"
        : "failed";

  const applyReport = (report: Report) => {
    result.how = report.how;
    if ("lines" in report) result.lines = report.lines.map((line) => line.trim()).filter(Boolean);
    if ("issues" in report) result.issues = report.issues;
    return end(report.status);
  };

  const execute = async (
    use: AskToolUseBlock,
  ): Promise<{ block: AskToolResultBlock; execution?: ToolExecution }> => {
    if (!names.includes(use.name)) {
      result.toolCalls.push({ name: use.name, error: "unknown tool" });
      return {
        block: errorResult(use.id, `Unknown tool ${use.name}. Tools: ${names.join(", ")}.`),
      };
    }
    const target = targetOf(use);
    const call: BrowseToolCall = { name: use.name };
    if (target) call.target = target;
    result.toolCalls.push(call);
    const checked = executor.validate(use);
    if (!checked.ok) {
      call.error = checked.error;
      return { block: errorResult(use.id, checked.error) };
    }
    let execution: ToolExecution;
    const guard = AbortSignal.timeout(TOOL_GUARD_MS);
    const toolSignal = AbortSignal.any([signal, guard]);
    try {
      execution = await untilAborted(
        executor.run(use.name, checked.value, toolSignal),
        toolSignal,
        () =>
          signal.aborted
            ? new Stopped("stopped")
            : new Error(`${use.name} did not finish within ${TOOL_GUARD_MS / 1000} s.`),
      );
    } catch (cause) {
      if (cause instanceof Stopped) throw cause;
      call.error = firstErrorLine(cause);
      return { block: errorResult(use.id, describeError(cause)) };
    }
    if (execution.blocked) {
      call.blocked = execution.blocked;
      logEvent("browse_blocked", {
        requestId: options.log.requestId,
        page: options.log.page,
        tool: use.name,
        reason: execution.blocked,
      });
      return {
        block: errorResult(
          use.id,
          `Refused: ${execution.blocked}. This path is closed; look for the information another way or report what you have.`,
        ),
      };
    }
    if (execution.isError)
      call.error = execution.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("\n")
        .split("\n")[0];
    const block: AskToolResultBlock = {
      type: "tool_result",
      toolUseId: use.id,
      content: execution.content,
    };
    if (execution.isError) block.isError = true;
    return { block, execution };
  };

  const converse = async () => {
    const modelTimeout =
      options.modelTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(options.modelTimeoutMs);
    const modelSignal = modelTimeout ? AbortSignal.any([signal, modelTimeout]) : signal;
    const input = {
      system: options.system,
      tools,
      messages: [...messages],
      model: options.model,
      maxTokens: options.maxTokens,
      signal: modelSignal,
      conversationId,
    };
    const turnStartedAt = Date.now();
    result.steps += 1;
    try {
      const reply: ConverseReply = await untilAborted(
        converseLogged(adapter, input, {
          tool: "ask_pages.browse",
          call: result.steps,
          requestId: options.log.requestId,
          page: options.log.page,
          step: result.steps,
        }),
        modelSignal,
        () => new Stopped("stopped"),
      );
      await options.capture?.turn({ input, reply, ms: Date.now() - turnStartedAt });
      return {
        reply: { ...reply, content: reply?.content ?? [] },
        timedOut: modelTimeout?.aborted === true,
      };
    } catch (cause) {
      await options.capture?.turn({
        input,
        error: firstErrorLine(cause),
        ms: Date.now() - turnStartedAt,
      });
      if (cause instanceof AskSetupError) throw cause;
      if (signal.aborted || modelTimeout?.aborted)
        return { stopped: stoppedOutcome(modelTimeout?.aborted === true) };
      return { error: firstErrorLine(cause) };
    }
  };

  const runUses = async (
    uses: AskToolUseBlock[],
    index: number,
    blocks: AskUserBlock[],
    notes: string[],
  ): Promise<BrowseResult | undefined> => {
    const use = uses[index];
    if (!use) return undefined;
    if (use.name === "report") {
      const checked = checkReport(options.mode, use);
      if (checked.ok) {
        const skipped = uses.slice(index + 1).map((other) => other.name);
        if (skipped.length)
          logEvent("skipped_after_report", {
            requestId: options.log.requestId,
            page: options.log.page,
            tools: skipped,
          });
        return applyReport(checked.value);
      }
      result.toolCalls.push({ name: "report", error: checked.error });
      blocks.push(errorResult(use.id, checked.error));
      return runUses(uses, index + 1, blocks, notes);
    }
    if (finalTurn) return end("step_limit");
    const { block, execution } = await execute(use);
    blocks.push(block);
    const key = `${use.name} ${canonicalInput(use)}`;
    stall =
      execution && changed(execution)
        ? { key: "", count: 0 }
        : { key, count: stall.key === key ? stall.count + 1 : 1 };
    if (stall.count >= STALL_STOP_AT)
      return end("no_report", "the same call kept changing nothing");
    if (stall.count === STALL_NOTE_AT) notes.push(STALL_NOTE);
    return runUses(uses, index + 1, blocks, notes);
  };

  const loop = async (): Promise<BrowseResult> => {
    if (signal.aborted) return end(stoppedOutcome(false));
    const called = await converse();
    if ("stopped" in called) return end(called.stopped ?? "failed");
    if ("error" in called) return end("failed", called.error);
    const { reply, timedOut } = called;
    addUsage(usage, reply.usage);
    const content = reply.content;
    const stop = reply.stopReason;
    if (stop === "max_tokens")
      return end(
        "cut_off",
        options.maxTokens < DEFAULT_MAX_OUTPUT_TOKENS
          ? "the reply hit the output limit; raise max_output_tokens"
          : "the reply hit the output limit",
      );
    if (stop === "model_context_window_exceeded")
      return end("context_full", "the conversation outgrew the model's context window");
    if (stop === "refusal") return end("refused", "the model refused (stop reason refusal)");
    if (stop === "interrupted")
      return end(timedOut ? "timed_out" : "failed", "the model's reply was interrupted");
    const uses = content.filter((block): block is AskToolUseBlock => block.type === "tool_use");
    if (uses.length) {
      messages.push({ role: "assistant", content });
      pauses = 0;
      const blocks: AskUserBlock[] = [];
      const notes: string[] = [];
      const finished = await runUses(uses, 0, blocks, notes);
      if (finished) return finished;
      if (finalTurn) return end("step_limit");
      const tabsNote = executor.newTabsNote();
      if (tabsNote) notes.push(tabsNote);
      if (options.maxSteps !== undefined && result.steps >= options.maxSteps) {
        finalTurn = true;
        notes.push(STEP_LIMIT_NUDGE);
      }
      messages.push({ role: "user", content: [...blocks, ...notes.map(textBlock)] });
      return loop();
    }
    if (content.length) messages.push({ role: "assistant", content });
    if (stop === "pause_turn") {
      pauses += 1;
      if (pauses > MAX_PAUSES) return end("failed", `the model paused ${pauses} times in a row`);
      return loop();
    }
    if (finalTurn) return end("step_limit");
    if (nudged) return end("no_report", "the model stopped without calling report");
    nudged = true;
    messages.push({ role: "user", content: [textBlock(NUDGE)] });
    return loop();
  };

  try {
    await loop();
  } catch (cause) {
    if (cause instanceof AskSetupError) throw cause;
    if (cause instanceof Stopped) end(stoppedOutcome(false));
    else end("failed", firstErrorLine(cause));
  } finally {
    result.finalUrl = executor.currentUrl();
    await withDeadline(executor.close(), CLOSE_GRACE_MS).catch(() => undefined);
    result.ms = Date.now() - startedAt;
    if (Object.keys(usage).length) result.usage = usage;
    if (options.capture) result.transcript = options.capture.dir;
    logEvent("browse_page_end", {
      requestId: options.log.requestId,
      page: options.log.page,
      outcome: result.outcome,
      steps: result.steps,
      toolCalls: result.toolCalls.length,
      usage: result.usage,
      ms: result.ms,
      finalUrl: result.finalUrl,
    });
  }
  await options.capture?.finish(result).catch(() => undefined);
  return result;
}
