import vm from "node:vm";
import { z } from "zod";
import { type Callable, callable, type ScriptGuard } from "./guard.ts";

const SYNC_SLICE_MS = 10_000;
const PUMP_INTERVAL_MS = 10;
const NOOP_SCRIPT = new vm.Script("undefined");
const ENTER_KEY = Symbol.for("web-agent-mcp.enter");
const ENTER_SCRIPT = new vm.Script('globalThis[Symbol.for("web-agent-mcp.enter")]()');

const ADOPT_SOURCE =
  "((Promise) => (pending) => new Promise((resolve, reject) => pending.then(resolve, reject)))(Promise)";

const vmTimeout = z.object({ code: z.literal("ERR_SCRIPT_EXECUTION_TIMEOUT") });

export class ScriptClock {
  private readonly context: vm.Context;
  private readonly guard: ScriptGuard;
  private readonly deadline?: number;
  private readonly timeoutMs?: number;
  private depth = 0;
  private pumpQueued = false;
  private finished = false;
  private readonly fallback: NodeJS.Timeout;
  private entering?: () => void;
  private readonly adopter: Callable<unknown>;

  constructor(context: vm.Context, guard: ScriptGuard, timeoutMs?: number) {
    this.context = context;
    this.adopter = callable.parse(vm.runInContext(ADOPT_SOURCE, context));
    Object.defineProperty(context, ENTER_KEY, { value: () => this.entering?.() });
    this.guard = guard;
    this.timeoutMs = timeoutMs;
    this.deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    this.fallback = setInterval(() => this.pump(), PUMP_INTERVAL_MS);
  }

  private limit() {
    const remaining =
      this.deadline === undefined ? Number.POSITIVE_INFINITY : this.deadline - Date.now();
    return Math.max(1, Math.floor(Math.min(SYNC_SLICE_MS, remaining)));
  }

  private stopFor(limit: number) {
    if (this.deadline !== undefined && Date.now() >= this.deadline - 1) {
      this.guard.halt({
        reason: "timeout",
        message: `run_script timed out after ${this.timeoutMs} ms.`,
      });
      return;
    }
    this.guard.halt({
      reason: "blocked",
      message: `run_script was stopped: its code ran for ${Math.round(limit / 1000)} s without awaiting anything, which blocks the whole server.`,
    });
  }

  run(script: vm.Script) {
    const limit = this.limit();
    let timedOut = false;
    this.depth += 1;
    try {
      const completion: unknown = script.runInContext(this.context, { timeout: limit });
      return completion;
    } catch (cause) {
      timedOut = vmTimeout.safeParse(cause).success;
      throw cause;
    } finally {
      this.depth -= 1;
      if (timedOut) this.stopFor(limit);
    }
  }

  enter<Result>(fn: Callable<Result>, args: unknown[]) {
    if (this.depth === 0 && (this.finished || this.guard.stopped)) return undefined;
    return this.bounded(() => fn(...args));
  }

  bounded<Result>(fn: () => Result) {
    if (this.depth > 0) return fn();
    let result: Result | undefined;
    this.entering = () => {
      result = fn();
    };
    try {
      this.run(ENTER_SCRIPT);
      return result;
    } finally {
      this.entering = undefined;
    }
  }

  adopt<Result>(pending: Promise<Result>) {
    // SAFETY: ADOPT_SOURCE returns a promise of the script's realm that settles exactly as pending does.
    return this.adopter(pending) as Promise<Result>;
  }

  pump() {
    if (this.depth > 0 || this.finished) return;
    try {
      this.run(NOOP_SCRIPT);
    } catch {
      return;
    }
  }

  queuePump() {
    if (this.pumpQueued || this.finished) return;
    this.pumpQueued = true;
    setImmediate(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  finish() {
    this.finished = true;
    clearInterval(this.fallback);
  }
}
