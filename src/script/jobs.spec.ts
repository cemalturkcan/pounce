import { afterAll, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserManager } from "../browser/manager.ts";
import type { Page } from "playwright-core";
import { ORPHANED_OWNER, type Tab } from "../browser/tab.ts";
import { NoSecretStore } from "../shared/secrets.ts";
import { clipHeadTail, OutputStore, Redactor } from "../shared/output.ts";
import { describeJob, type Job, JobRunner, keptValue, listedJob, queuedBehind } from "./jobs.ts";
import type { ScriptDeps } from "./run.ts";
import { waitForJob } from "../tools/script.ts";

function finishedJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "j1",
    owner: "session",
    label: "",
    state: "done",
    startedAt: 0,
    endedAt: 1000,
    logFile: "/out/jobs/j1/log.txt",
    resultFile: "/out/jobs/j1/result.txt",
    logLines: 0,
    recentLogs: [],
    controller: new AbortController(),
    finished: Promise.resolve(),
    ...overrides,
  };
}

test("a clipped value whose result file could not be written says that the rest was not saved", () => {
  const job = finishedJob({
    returned: keptValue("x".repeat(30_000)),
    resultError: "EACCES: permission denied",
  });
  expect(describeJob(job, true)).toContain(
    "[truncated: 30000 chars total. The full output could not be saved.]",
  );
});

test("the pointed text of a clipped value whose result file could not be written says it was not saved", () => {
  const job = finishedJob({
    returned: keptValue("x".repeat(30_000)),
    resultError: "EACCES: permission denied",
  });
  expect(describeJob(job, true, { pointed: true })).toContain(
    "Returned 30000 chars as text; a preview in value, the rest could not be saved.",
  );
});

test("a clipped value names the result file that holds all of it", () => {
  const job = finishedJob({ returned: keptValue("x".repeat(30_000)) });
  expect(describeJob(job, true)).toContain(
    "[truncated: 30000 chars total. Full output saved to /out/jobs/j1/result.txt.]",
  );
});

test("a short value is shown whole", () => {
  const job = finishedJob({ returned: keptValue("42") });
  expect(describeJob(job, true)).toContain("Returned: 42");
});

const longValue = Array.from({ length: 5000 }, (_value, index) => `row ${index}`).join("\n");

test("a long value clipped to a small max_chars shows what clipping the whole value shows", () => {
  const job = finishedJob({ returned: keptValue(longValue) });
  expect(describeJob(job, true, { maxChars: 2000 })).toContain(
    `Returned: ${clipHeadTail(longValue, 2000).text}\n`,
  );
});

test("a long value is clipped to the kept 10000 chars for a larger max_chars", () => {
  const job = finishedJob({ returned: keptValue(longValue) });
  expect(describeJob(job, true, { maxChars: 50_000 })).toContain(
    `Returned: ${clipHeadTail(longValue, 10_000).text}\n[truncated: ${longValue.length} chars total.`,
  );
});

const outputRoot = mkdtempSync(path.join(tmpdir(), "web-agent-jobs-"));

afterAll(() => rm(outputRoot, { recursive: true, force: true }));

type ScriptManager = Pick<
  BrowserManager,
  "beginWork" | "holdRendering" | "untilDrawn" | "tabOf"
> & {
  config: Pick<BrowserManager["config"], "engine">;
  ensureContext: () => Promise<object>;
};

function fakeDeps(): ScriptDeps {
  const manager: ScriptManager = {
    config: { engine: "patchright" },
    ensureContext: async () => ({}),
    holdRendering: () => () => undefined,
    untilDrawn: async () => true,
    tabOf: () => undefined,
    beginWork: () => () => undefined,
  };
  return {
    // SAFETY: a job reaches only these members of the manager for a script that makes no browser call
    manager: manager as BrowserManager,
    store: new OutputStore(outputRoot),
    secrets: new NoSecretStore(),
    redactor: new Redactor(),
  };
}

type ClosablePage = Pick<Page, "isClosed"> & {
  once: (event: "close", listener: () => void) => void;
  off: (event: "close", listener: () => void) => void;
};

class FakePage {
  closed = false;
  private readonly events = new EventEmitter();

  isClosed() {
    return this.closed;
  }

  once(event: "close", listener: () => void) {
    this.events.once(event, listener);
  }

  off(event: "close", listener: () => void) {
    this.events.off(event, listener);
  }

  close() {
    this.closed = true;
    this.events.emit("close");
  }
}

function fakeTab(id = "t1", page: ClosablePage = new FakePage()) {
  // SAFETY: a job reads only the id and the page's closed state and close event of its tab for a script that makes no browser call
  return { id, page } as Tab;
}

const endsAt = "await sleep(400); return Date.now();";
const startsAt = "return Date.now();";

async function settled(job: Job) {
  await job.finished;
  return job;
}

test("a job on a tab where another job runs is queued", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, startsAt, "");
  expect(second.state).toBe("queued");
  await settled(first);
  await settled(second);
});

test("a queued job names the job it waits behind", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, startsAt, "");
  expect(queuedBehind(second)).toBe(first.id);
  await settled(second);
});

test("a queued job starts only after the earlier job on its tab ended", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, startsAt, "");
  await settled(second);
  expect(Number(second.value)).toBeGreaterThanOrEqual(Number(first.value));
});

test("a job on another tab is not held back", async () => {
  const runner = new JobRunner();
  const first = await runner.start(fakeDeps(), "a", fakeTab("t1"), endsAt, "");
  const second = await runner.start(fakeDeps(), "a", fakeTab("t2"), startsAt, "");
  expect(second.state).toBe("running");
  await settled(first);
  await settled(second);
});

test("a job with no tab is not held back", async () => {
  const runner = new JobRunner();
  const first = await runner.start(fakeDeps(), "a", fakeTab(), endsAt, "");
  const second = await runner.start(fakeDeps(), "a", undefined, startsAt, "");
  expect(second.state).toBe("running");
  await settled(first);
  await settled(second);
});

test("two jobs started on one tab at the same moment run one after the other", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const [, second] = await Promise.all([
    runner.start(fakeDeps(), "a", tab, endsAt, ""),
    runner.start(fakeDeps(), "b", tab, startsAt, ""),
  ]);
  expect(second.state).toBe("queued");
  await settled(second);
});

test("cancelling a queued job ends it as cancelled", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, "log('ran');", "");
  runner.cancel(second.id);
  await settled(second);
  expect(second.state).toBe("cancelled");
  await settled(first);
});

test("a cancelled queued job never runs", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, "log('ran');", "");
  runner.cancel(second.id);
  await settled(first);
  await Bun.sleep(200);
  expect(second.logLines).toBe(0);
});

test("a job behind a cancelled queued job still waits for the running one", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, startsAt, "");
  const third = await runner.start(fakeDeps(), "c", tab, startsAt, "");
  runner.cancel(second.id);
  await settled(third);
  expect(Number(third.value)).toBeGreaterThanOrEqual(Number(first.value));
});

test("a job behind a cancelled queued job names the running one", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, startsAt, "");
  const third = await runner.start(fakeDeps(), "c", tab, startsAt, "");
  runner.cancel(second.id);
  expect(queuedBehind(third)).toBe(first.id);
  await settled(third);
});

test("a queued job starts when the earlier job failed", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  await runner.start(fakeDeps(), "a", tab, "await sleep(200); throw new Error('broken');", "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  await settled(second);
  expect(second.state).toBe("done");
});

test("a queued job starts when the earlier job was cancelled", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, "await sleep(20000);", "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  runner.cancel(first.id);
  await settled(second);
  expect(second.state).toBe("done");
});

test("a queued job whose tab closed fails instead of starting", async () => {
  const runner = new JobRunner();
  const page = new FakePage();
  const tab = fakeTab("t1", page);
  await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  page.closed = true;
  await settled(second);
  expect(second.failure).toStartWith(`Tab t1 was closed before job ${second.id} started.`);
});

const longJob = "await sleep(20000);";

test("a queued job fails as soon as its tab closes", async () => {
  const runner = new JobRunner();
  const page = new FakePage();
  const tab = fakeTab("t1", page);
  const first = await runner.start(fakeDeps(), "a", tab, longJob, "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  page.close();
  await Bun.sleep(100);
  expect(second.state).toBe("failed");
  runner.cancel(first.id);
  await settled(first);
});

test("waiting on a queued job whose tab closes returns its failure", async () => {
  const runner = new JobRunner();
  const page = new FakePage();
  const tab = fakeTab("t1", page);
  const first = await runner.start(fakeDeps(), "a", tab, longJob, "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  const waited = waitForJob(second, 2000, new AbortController().signal);
  page.close();
  expect((await waited).text).toContain(`Tab t1 was closed before job ${second.id} started.`);
  runner.cancel(first.id);
  await settled(first);
});

test("another session may cancel a running job", async () => {
  const runner = new JobRunner();
  const job = await runner.start(fakeDeps(), "a", fakeTab(), longJob, "");
  runner.cancel(job.id);
  await settled(job);
  expect(job.state).toBe("cancelled");
});

test("another session may cancel a queued job", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  const first = await runner.start(fakeDeps(), "a", tab, longJob, "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  runner.cancel(second.id);
  await settled(second);
  expect(second.state).toBe("cancelled");
  runner.cancel(first.id);
  await settled(first);
});

test("cancelling all jobs ends a queued job as cancelled", async () => {
  const runner = new JobRunner();
  const tab = fakeTab();
  await runner.start(fakeDeps(), "a", tab, endsAt, "");
  const second = await runner.start(fakeDeps(), "b", tab, "return 1;", "");
  runner.cancelAll();
  await settled(second);
  expect(second.state).toBe("cancelled");
});

test("a queued job's line names the job it waits behind", () => {
  const job = finishedJob({ id: "j2", state: "queued", ahead: finishedJob({ state: "running" }) });
  expect(describeJob(job, false)).toStartWith("j2 queued behind j1 ");
});

test("a queued job's status shows its log file and the job it waits behind", () => {
  const job = finishedJob({ id: "j2", state: "queued", ahead: finishedJob({ state: "running" }) });
  expect(describeJob(job, true)).toBe(
    "j2 queued behind j1 1s 0 log lines\nLog: /out/jobs/j1/log.txt",
  );
});

test("a job whose session has ended is listed as orphaned", async () => {
  const runner = new JobRunner();
  const job = await runner.start(fakeDeps(), "a", fakeTab(), longJob, "");
  runner.orphanJobsOf("a");
  expect(describeJob(job, false)).toStartWith(`${job.id} running (orphaned) `);
  runner.cancel(job.id);
  await settled(job);
});

test("a queued orphaned job's line names the job it waits behind", () => {
  const job = finishedJob({
    id: "j2",
    owner: ORPHANED_OWNER,
    state: "queued",
    ahead: finishedJob({ state: "running" }),
  });
  expect(describeJob(job, false)).toStartWith("j2 queued behind j1 (orphaned) ");
});

class LateFailingPage extends FakePage {
  failLater() {
    return Bun.sleep(100).then(() => Promise.reject(new Error("late failure")));
  }
}

test("a browser call failing after its job ended is appended to the job's log", async () => {
  const runner = new JobRunner();
  const job = await runner.start(
    fakeDeps(),
    "a",
    fakeTab("t1", new LateFailingPage()),
    "page.failLater(); return 1;",
    "",
  );
  await settled(job);
  await Bun.sleep(300);
  expect(await readFile(job.logFile, "utf8")).toBe(
    "A browser call the script did not await failed after it ended: late failure\n",
  );
});

test("a listed job of an ended session is marked orphaned", () => {
  const job = finishedJob({ owner: ORPHANED_OWNER, state: "running" });
  expect(listedJob(job).orphaned).toBe(true);
});

test("a listed job of a live session leaves orphaned out", () => {
  expect(listedJob(finishedJob()).orphaned).toBeUndefined();
});

test("a listed job without a label leaves label out", () => {
  expect(listedJob(finishedJob()).label).toBeUndefined();
});

test("a listed queued job names the job it waits behind", () => {
  const job = finishedJob({ id: "j2", state: "queued", ahead: finishedJob({ state: "running" }) });
  expect(listedJob(job).queuedBehind).toBe("j1");
});
