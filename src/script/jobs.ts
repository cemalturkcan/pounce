import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordFault } from "../log/faults.ts";
import { describeError, ToolError } from "../shared/errors.ts";
import { logEvent } from "../log/logger.ts";
import {
  clipEnds,
  fieldPointer,
  keepEnds,
  returnedSentence,
  type StructuredValue,
  type TextEnds,
  timestampSlug,
  valueKind,
} from "../shared/output.ts";
import type { ScriptOutcome } from "./host.ts";
import { runScript, type ScriptDeps, type ScriptError, scriptErrorOf } from "./run.ts";
import { ORPHANED_OWNER, type Tab } from "../browser/tab.ts";

const RECENT_LOG_LINES = 15;
const FINISHED_JOB_LIMIT = 50;
export const JOB_VALUE_CHARS = 10_000;

export const JOB_STATES = ["queued", "running", "done", "failed", "cancelled"] as const;

type JobState = (typeof JOB_STATES)[number];

export type Job = {
  id: string;
  owner: string;
  tabId?: string;
  label: string;
  maxChars?: number;
  state: JobState;
  ahead?: Job;
  startedAt: number;
  endedAt?: number;
  logFile: string;
  resultFile: string;
  logLines: number;
  recentLogs: string[];
  returned?: TextEnds;
  value?: StructuredValue;
  undefined?: true;
  resultError?: string;
  failure?: string;
  error?: ScriptError;
  controller: AbortController;
  finished: Promise<void>;
};

export const jobOrphaned = (job: Job) => job.owner === ORPHANED_OWNER;

export const jobActive = (job: Job) => job.state === "queued" || job.state === "running";

export function queuedBehind(job: Job) {
  if (job.state !== "queued") return undefined;
  let ahead = job.ahead;
  while (ahead && !jobActive(ahead)) ahead = ahead.ahead;
  return ahead?.id;
}

export function listedJob(job: Job) {
  return {
    id: job.id,
    state: job.state,
    label: job.label || undefined,
    tab: job.tabId,
    orphaned: jobOrphaned(job) || undefined,
    queuedBehind: queuedBehind(job),
  };
}

const withoutLogs = (text: string) =>
  text.split(/\nLogs (?:so far|before the error):\n/)[0] ?? text;

function stopReason(cause: unknown) {
  const text =
    cause instanceof ToolError
      ? [withoutLogs(cause.message), cause.hint].filter(Boolean).join("\n")
      : withoutLogs(describeError(cause));
  return text.split("\n").slice(0, 3).join("\n");
}

export const keptValue = (returned: string) => keepEnds(returned, JOB_VALUE_CHARS);

type ResultRecord = { value: StructuredValue } | { undefined: true } | { error: ScriptError };

function resultRecord(outcome: ScriptOutcome): ResultRecord {
  if (outcome.undefined) return { undefined: true };
  return { value: outcome.value === undefined ? outcome.returned : outcome.value };
}

type TabLine = { last: Job; turn: Promise<void> };

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly lines = new Map<string, TabLine>();
  private counter = 0;

  async start(
    deps: ScriptDeps,
    owner: string,
    tab: Tab | undefined,
    code: string,
    label: string,
    maxChars?: number,
  ) {
    this.counter += 1;
    const id = `j${this.counter}`;
    const dir = path.join(deps.store.root, "jobs", `${timestampSlug()}-${id}`);
    const logFile = path.join(dir, "log.txt");
    const resultFile = path.join(dir, "result.txt");
    const line = tab ? this.lines.get(tab.id) : undefined;
    const ended = Promise.withResolvers<void>();
    const controller = new AbortController();
    const job: Job = {
      id,
      owner,
      tabId: tab?.id,
      label,
      maxChars,
      state: "queued",
      ahead: line?.last,
      startedAt: Date.now(),
      logFile,
      resultFile,
      logLines: 0,
      recentLogs: [],
      controller,
      finished: ended.promise,
    };
    this.jobs.set(id, job);
    const endWork = deps.manager.beginWork(owner);
    const prepared = mkdir(dir, { recursive: true }).then(() => writeFile(logFile, ""));

    let writes = Promise.resolve();
    const onLog = (text: string) => {
      const redacted = deps.redactor.redact(text);
      job.logLines += 1;
      job.recentLogs.push(redacted);
      if (job.recentLogs.length > RECENT_LOG_LINES) job.recentLogs.shift();
      writes = writes.then(() => appendFile(logFile, `${redacted}\n`)).catch(() => undefined);
    };

    const writeResult = async (record: ResultRecord) => {
      try {
        await writeFile(resultFile, deps.redactor.redact(JSON.stringify(record, null, 2)));
      } catch (cause) {
        job.resultError = describeError(cause).split("\n")[0];
        recordFault(`job ${id} result`, cause);
      }
    };
    const stop = (state: "failed" | "cancelled", cause: unknown) => {
      job.state = state;
      job.failure = stopReason(cause);
      job.error = scriptErrorOf(cause);
      return writeResult({ error: job.error });
    };
    const end = (state: "failed" | "cancelled", cause: unknown) => {
      job.state = state;
      return settle(prepared.then(() => stop(state, cause)));
    };
    const tabClosed = () =>
      end(
        "failed",
        new ToolError(
          `Tab ${tab?.id} was closed before job ${id} started.`,
          "Nothing was run; start the job again on an open tab.",
        ),
      );
    const onTabClose = () => {
      if (job.state === "queued") void tabClosed();
    };
    const close = () => {
      tab?.page.off("close", onTabClose);
      endWork();
      job.endedAt = Date.now();
      logEvent(
        "job_end",
        {
          job: id,
          session: owner,
          tab: tab?.id,
          state: job.state,
          ms: job.endedAt - job.startedAt,
          logLines: job.logLines,
          error: job.failure,
        },
        job.state === "failed" ? "warn" : "info",
      );
      this.trim();
      ended.resolve();
    };
    const settle = (work: Promise<unknown>) =>
      work
        .then(() => writes)
        .catch((cause: unknown) => recordFault(`job ${id}`, cause))
        .finally(close);

    const run = () => {
      tab?.page.off("close", onTabClose);
      job.state = "running";
      job.ahead = undefined;
      job.startedAt = Date.now();
      logEvent("job_start", {
        job: id,
        session: owner,
        tab: tab?.id,
        label: label || undefined,
        codeChars: code.length,
      });
      return runScript(deps, owner, tab, code, { signal: controller.signal, onLog }).then(
        async (result) => {
          job.state = "done";
          job.returned = keptValue(deps.redactor.redact(result.returned));
          if (job.returned.totalChars <= JOB_VALUE_CHARS) job.value = result.value;
          job.undefined = result.undefined;
          await writeResult(resultRecord(result));
        },
        (cause: unknown) => stop(controller.signal.aborted ? "cancelled" : "failed", cause),
      );
    };
    const take = () => {
      if (job.state !== "queued") return undefined;
      if (tab?.page.isClosed()) return tabClosed();
      return settle(run());
    };

    controller.signal.addEventListener(
      "abort",
      () => {
        if (job.state === "queued")
          void end("cancelled", new ToolError(`Job ${id} was cancelled before it started.`));
      },
      { once: true },
    );

    tab?.page.once("close", onTabClose);
    const turn = (line ? line.turn.then(() => prepared) : prepared)
      .then(take)
      .catch(() => undefined);
    if (tab) {
      const entry = { last: job, turn };
      this.lines.set(tab.id, entry);
      void turn.finally(() => {
        if (this.lines.get(tab.id) === entry) this.lines.delete(tab.id);
      });
    }

    try {
      await prepared;
    } catch (cause) {
      job.state = "failed";
      tab?.page.off("close", onTabClose);
      this.jobs.delete(id);
      endWork();
      ended.resolve();
      throw cause;
    }
    if (job.ahead)
      logEvent("job_queued", { job: id, session: owner, tab: tab?.id, behind: job.ahead.id });
    return job;
  }

  private trim() {
    const finished = [...this.jobs.values()].filter((job) => !jobActive(job));
    for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_JOB_LIMIT)))
      this.jobs.delete(job.id);
  }

  get(id: string) {
    const job = this.jobs.get(id.trim());
    if (!job) {
      throw new ToolError(
        `No job ${id}.`,
        "Call run_script with no code and no job to list known jobs; jobs are dropped after a server restart.",
      );
    }
    return job;
  }

  list() {
    return [...this.jobs.values()];
  }

  cancel(id: string) {
    const job = this.get(id);
    if (jobActive(job)) job.controller.abort();
    return job;
  }

  orphanJobsOf(owner: string) {
    for (const job of this.jobs.values()) if (job.owner === owner) job.owner = ORPHANED_OWNER;
  }

  cancelAll() {
    for (const job of this.jobs.values()) if (jobActive(job)) job.controller.abort();
  }
}

export const jobElapsedMs = (job: Job) => (job.endedAt ?? Date.now()) - job.startedAt;

export const jobValueClipped = (job: Job, maxChars: number) =>
  job.returned !== undefined && job.returned.totalChars > Math.min(maxChars, JOB_VALUE_CHARS);

type JobView = { maxChars?: number; pointed?: boolean };

function shownField(view: JobView, field: string, value: string) {
  return view.pointed ? fieldPointer(field) : value;
}

function returnedLines(job: Job, view: JobView) {
  if (job.returned === undefined) return [];
  const clipped = clipEnds(
    job.returned,
    Math.min(view.maxChars ?? JOB_VALUE_CHARS, JOB_VALUE_CHARS),
  );
  if (view.pointed) {
    const kind = job.undefined
      ? "undefined"
      : job.value === undefined
        ? undefined
        : valueKind(job.value);
    return [
      returnedSentence(
        kind,
        clipped.truncated ? clipped.totalChars : undefined,
        job.resultError === undefined,
      ),
    ];
  }
  if (!clipped.truncated)
    return [
      `Returned: ${job.value === undefined ? clipped.text : shownField(view, "value", clipped.text)}`,
    ];
  const kept = job.resultError
    ? "The full output could not be saved."
    : `Full output saved to ${shownField(view, "resultFile", job.resultFile)}.`;
  return [`Returned: ${clipped.text}`, `[truncated: ${clipped.totalChars} chars total. ${kept}]`];
}

export function describeJob(job: Job, detailed: boolean, view: JobView = {}) {
  const seconds = Math.round(jobElapsedMs(job) / 1000);
  const behind = queuedBehind(job);
  const queued = behind ? `${job.state} behind ${behind}` : job.state;
  const state = jobOrphaned(job) ? `${queued} (orphaned)` : queued;
  const head = `${job.id} ${state} ${seconds}s ${job.logLines} log lines${job.label ? ` — ${job.label}` : ""}`;
  if (!detailed) return head;
  const lines = [head, `Log: ${shownField(view, "logFile", job.logFile)}`];
  if (job.failure) lines.push(`Stopped: ${shownField(view, "error", job.failure)}`);
  if (job.resultError)
    lines.push(
      `The result could not be written to ${shownField(view, "resultFile", job.resultFile)}: ${job.resultError}`,
    );
  else if (!jobActive(job)) lines.push(`Result: ${shownField(view, "resultFile", job.resultFile)}`);
  lines.push(...returnedLines(job, view));
  if (job.recentLogs.length)
    lines.push(
      ...(view.pointed
        ? [`Recent log lines: ${fieldPointer("recentLogs")}`]
        : ["Recent log lines:", ...job.recentLogs]),
    );
  return lines.join("\n");
}
