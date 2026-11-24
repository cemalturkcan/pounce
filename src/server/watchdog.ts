import { Worker } from "node:worker_threads";
import { recordFault } from "../log/faults.ts";

type WatchdogOptions = { thresholdMs: number; beatMs?: number; label?: string };

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const beat = new BigInt64Array(workerData.buffer);
let stalledSince;
const check = () => {
  const last = Number(Atomics.load(beat, 0));
  const now = Date.now();
  if (stalledSince === undefined && now - last > workerData.thresholdMs) {
    stalledSince = last;
    try {
      writeSync(2, workerData.label + ": the event loop has been blocked for " + (now - last) + " ms; tool calls wait until it is free\\n");
    } catch {}
    return;
  }
  if (stalledSince !== undefined && now - last <= workerData.thresholdMs) {
    parentPort.postMessage({ blockedMs: last - stalledSince });
    stalledSince = undefined;
  }
};
setInterval(check, Math.max(10, Math.floor(workerData.thresholdMs / 4)));
`;

export async function startLoopWatchdog(options: WatchdogOptions) {
  const buffer = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(buffer);
  const touch = () => Atomics.store(beat, 0, BigInt(Date.now()));
  touch();
  const heartbeat = setInterval(touch, options.beatMs ?? 500);
  heartbeat.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      buffer,
      thresholdMs: options.thresholdMs,
      label: options.label ?? "pounce",
    },
  });
  worker.unref();
  worker.on("message", (message: { blockedMs: number }) => {
    recordFault(
      "event loop",
      new Error(
        `the event loop was blocked for ${message.blockedMs} ms; every tool call waited meanwhile`,
      ),
    );
  });
  worker.on("error", (error) => recordFault("event loop watchdog", error));
  await new Promise<void>((resolve) => worker.once("online", () => resolve()));
  return async () => {
    clearInterval(heartbeat);
    await worker.terminate();
  };
}
