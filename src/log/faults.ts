import { messageOf } from "../shared/errors.ts";
import { logEvent } from "./logger.ts";

const FAULT_LIMIT = 20;
const STACK_LINES = 12;

type Fault = { time: string; source: string; message: string };

const faults: Fault[] = [];

function stackOf(cause: unknown) {
  return cause instanceof Error
    ? cause.stack?.split("\n").slice(0, STACK_LINES).join("\n")
    : undefined;
}

function pushFault(source: string, cause: unknown) {
  const message = (stackOf(cause) ?? messageOf(cause)).split("\n").slice(0, 3).join(" | ");
  faults.push({ time: new Date().toISOString(), source, message: message.slice(0, 500) });
  if (faults.length > FAULT_LIMIT) faults.splice(0, faults.length - FAULT_LIMIT);
}

export function recordFault(source: string, cause: unknown) {
  pushFault(source, cause);
  logEvent(
    "fault",
    {
      source,
      error: messageOf(cause),
      stack: stackOf(cause),
    },
    "error",
  );
}

export function recentFaults(limit = 5) {
  return faults.slice(-limit);
}

let guardsInstalled = false;

export function installProcessGuards(label: string) {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on("unhandledRejection", (reason) => {
    pushFault("unhandled rejection", reason);
    logEvent(
      "unhandled_rejection",
      {
        message: `${label}: unhandled rejection kept the server running`,
        error: messageOf(reason),
        stack: stackOf(reason),
      },
      "error",
    );
  });
  process.on("uncaughtException", (error) => {
    pushFault("uncaught exception", error);
    logEvent(
      "uncaught_exception",
      {
        message: `${label}: uncaught exception kept the server running`,
        error: messageOf(error),
        stack: stackOf(error),
      },
      "error",
    );
  });
}
