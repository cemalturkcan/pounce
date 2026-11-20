import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tab } from "./browser.ts";
import { describeError, recordFault, ToolError } from "./errors.ts";
import { logEvent } from "./log.ts";
import { timestampSlug } from "./output.ts";
import { runScript, serializeValue, type ScriptDeps } from "./script.ts";

const RECENT_LOG_LINES = 15;
const FINISHED_JOB_LIMIT = 50;

export type JobState = "running" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  label: string;
  state: JobState;
  startedAt: number;
  endedAt?: number;
  logFile: string;
  resultFile: string;
  logLines: number;
  recentLogs: string[];
  resultError?: string;
  failure?: string;
  controller: AbortController;
  finished: Promise<void>;
};

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private counter = 0;

  async start(deps: ScriptDeps, owner: string, tab: Tab | undefined, code: string, label: string) {
    this.counter += 1;
    const id = `j${this.counter}`;
    const dir = await deps.store.dir("jobs", `${timestampSlug()}-${id}`);
    const logFile = path.join(dir, "log.txt");
    const resultFile = path.join(dir, "result.txt");
    await mkdir(dir, { recursive: true });
    await writeFile(logFile, "");

    const controller = new AbortController();
    const job: Job = {
      id,
      label,
      state: "running",
      startedAt: Date.now(),
      logFile,
      resultFile,
      logLines: 0,
      recentLogs: [],
      controller,
      finished: Promise.resolve(),
    };

    let writes = Promise.resolve();
    const onLog = (line: string) => {
      const text = deps.redactor.redact(line);
      job.logLines += 1;
      job.recentLogs.push(text);
      if (job.recentLogs.length > RECENT_LOG_LINES) job.recentLogs.shift();
      writes = writes.then(() => appendFile(logFile, `${text}\n`)).catch(() => undefined);
    };

    const writeResult = async (text: string) => {
      try {
        await writeFile(resultFile, deps.redactor.redact(text));
      } catch (error) {
        job.resultError = describeError(error).split("\n")[0];
        recordFault(`job ${id} result`, error);
      }
    };
    job.finished = runScript(deps, owner, tab, code, { signal: controller.signal, onLog })
      .then(
        async (result) => {
          job.state = "done";
          await writeResult(serializeValue(result.value));
        },
        async (error: unknown) => {
          job.state = controller.signal.aborted ? "cancelled" : "failed";
          job.failure = describeError(error).split("\n").slice(0, 3).join("\n");
          await writeResult(describeError(error));
        },
      )
      .then(() => writes)
      .catch((error: unknown) => recordFault(`job ${id}`, error))
      .finally(() => {
        job.endedAt = Date.now();
        logEvent("job_end", { job: id, session: owner, tab: tab?.id, state: job.state, ms: job.endedAt - job.startedAt, logLines: job.logLines, error: job.failure }, job.state === "failed" ? "warn" : "info");
        this.trim();
      });
    logEvent("job_start", { job: id, session: owner, tab: tab?.id, label: label || undefined, codeChars: code.length });

    this.jobs.set(id, job);
    return job;
  }

  private trim() {
    const finished = [...this.jobs.values()].filter((job) => job.state !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - FINISHED_JOB_LIMIT))) this.jobs.delete(job.id);
  }

  get(id: string) {
    const job = this.jobs.get(id.trim());
    if (!job) {
      throw new ToolError(`No job ${id}.`, "Use jobs with action list to see known jobs; finished jobs are dropped after a server restart.");
    }
    return job;
  }

  list() {
    return [...this.jobs.values()];
  }

  cancel(id: string) {
    const job = this.get(id);
    if (job.state === "running") job.controller.abort();
    return job;
  }

  cancelAll() {
    for (const job of this.jobs.values()) if (job.state === "running") job.controller.abort();
  }
}

export function describeJob(job: Job, detailed: boolean) {
  const seconds = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  const head = `${job.id} ${job.state} ${seconds}s ${job.logLines} log lines${job.label ? ` — ${job.label}` : ""}`;
  if (!detailed) return head;
  const lines = [head, `Log: ${job.logFile}`];
  if (job.failure) lines.push(`Stopped: ${job.failure}`);
  if (job.resultError) lines.push(`The result could not be written to ${job.resultFile}: ${job.resultError}`);
  else if (job.state !== "running") lines.push(`Result: ${job.resultFile}`);
  if (job.recentLogs.length) lines.push("Recent log lines:", ...job.recentLogs);
  return lines.join("\n");
}
