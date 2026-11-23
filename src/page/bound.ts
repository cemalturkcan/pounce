import { withTimeout } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";

const PAGE_READ_TIMEOUT_MS = 15_000;

export function pageBound<T>(promise: Promise<T>, what: string, ms = PAGE_READ_TIMEOUT_MS) {
  return withTimeout(
    promise,
    ms,
    () =>
      new ToolError(
        `${what} did not finish within ${ms / 1000} s; the page is not answering, so a script in it may be stuck.`,
        "Reload the tab with navigate, or close it with tabs (close, force: true) and open a new one.",
      ),
  );
}
