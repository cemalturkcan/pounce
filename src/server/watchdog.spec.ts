import { expect, test } from "bun:test";
import { repeatUntil } from "../shared/async.ts";

test("the loop watchdog records a fault after the event loop was blocked", async () => {
  const { startLoopWatchdog } = await import("./watchdog.ts");
  const { recentFaults } = await import("../log/faults.ts");
  const stop = await startLoopWatchdog({ thresholdMs: 300, beatMs: 50 });
  try {
    const end = Date.now() + 1200;
    while (Date.now() < end) {}
    const fault = await repeatUntil(
      async () => recentFaults(20).find((entry) => entry.source === "event loop"),
      { delayMs: () => 50, giveUp: (attempts) => attempts >= 40 },
    );
    expect(fault).toBeDefined();
    expect(fault?.message).toMatch(/blocked for \d+ ms/);
  } finally {
    await stop();
  }
});
