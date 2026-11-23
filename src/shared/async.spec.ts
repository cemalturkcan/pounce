import { describe, expect, test } from "bun:test";
import {
  inSequence,
  repeatUntil,
  runPool,
  sleep,
  TIMED_OUT,
  untilAborted,
  withDeadline,
} from "./async.ts";

describe("inSequence", () => {
  test("returns the step results in item order", async () => {
    const results = await inSequence([30, 10, 20], async (ms, index) => {
      await sleep(ms);
      return `${index}:${ms}`;
    });
    expect(results).toStrictEqual(["0:30", "1:10", "2:20"]);
  });

  test("starts each step only after the previous one finished", async () => {
    const events: string[] = [];
    await inSequence(["a", "b", "c"], async (item) => {
      events.push(`start ${item}`);
      await sleep(5);
      events.push(`end ${item}`);
    });
    expect(events).toStrictEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
  });

  test("stops at the first failing step and rejects with its error", async () => {
    const seen: number[] = [];
    const run = inSequence([1, 2, 3], async (item) => {
      seen.push(item);
      if (item === 2) throw new Error("step 2 failed");
      return item;
    });
    await expect(run).rejects.toThrow("step 2 failed");
    expect(seen).toStrictEqual([1, 2]);
  });

  test("resolves to an empty list for no items", async () => {
    expect(await inSequence([], async () => 1)).toStrictEqual([]);
  });
});

describe("repeatUntil", () => {
  test("returns the first defined value an attempt yields", async () => {
    const attempts: number[] = [];
    const value = await repeatUntil(async (attempt) => {
      attempts.push(attempt);
      return attempt === 2 ? "ready" : undefined;
    });
    expect({ value, attempts }).toStrictEqual({ value: "ready", attempts: [0, 1, 2] });
  });

  test("keeps falsy values other than undefined as results", async () => {
    expect(await repeatUntil(async () => false)).toBe(false);
  });

  test("waits the fixed delay between attempts", async () => {
    const started = performance.now();
    await repeatUntil(async (attempt) => (attempt === 2 ? attempt : undefined), {
      delayMs: () => 20,
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(38);
  });

  test("passes the finished attempt count to a computed delay", async () => {
    const asked: number[] = [];
    await repeatUntil(async (attempt) => (attempt === 3 ? attempt : undefined), {
      delayMs: (attempts) => {
        asked.push(attempts);
        return 0;
      },
    });
    expect(asked).toStrictEqual([1, 2, 3]);
  });

  test("resolves to undefined once giveUp holds after a miss", async () => {
    const attempts: number[] = [];
    const value = await repeatUntil(
      async (attempt) => {
        attempts.push(attempt);
        return undefined;
      },
      { giveUp: (made) => made >= 3 },
    );
    expect({ value, attempts }).toStrictEqual({ value: undefined, attempts: [0, 1, 2] });
  });

  test("rejects when the signal aborts during a delay", async () => {
    const controller = new AbortController();
    const run = repeatUntil(async () => undefined, {
      delayMs: () => 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(run).rejects.toThrow(/abort/i);
  });

  test("rejects with the error an attempt throws", async () => {
    const run = repeatUntil(async () => {
      throw new Error("attempt failed");
    });
    await expect(run).rejects.toThrow("attempt failed");
  });
});

test("deadline, abort and pool helpers", async () => {
  expect(await withDeadline(new Promise(() => undefined), 20)).toBe(TIMED_OUT);
  expect(await withDeadline(Promise.resolve(5), 20)).toBe(5);
  const controller = new AbortController();
  const waiting = untilAborted(
    new Promise(() => undefined),
    controller.signal,
    () => new Error("stopped"),
  );
  controller.abort();
  await expect(waiting).rejects.toThrow(/stopped/);
  let active = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    active -= 1;
    return value * 2;
  });
  expect(results).toStrictEqual([2, 4, 6, 8, 10]);
  expect(peak).toBe(2);
});

const pagesOn = (host: string, count: number) =>
  Array.from({ length: count }, (_unused, index) => ({ host, name: `${host}${index}` }));

async function startTimes(items: { host: string; name: string }[], concurrency: number) {
  const began = Date.now();
  const starts = new Map<string, number>();
  await runPool(
    items,
    concurrency,
    async (item, _index, started) => {
      starts.set(item.name, Date.now() - began);
      started();
      await sleep(5);
    },
    undefined,
    { gapMs: 200, keyOf: (item) => item.host },
  );
  return starts;
}

describe("runPool pacing", () => {
  test("spaces consecutive starts with the same key by the gap", async () => {
    const starts = await startTimes(pagesOn("a", 2), 2);
    expect((starts.get("a1") ?? 0) - (starts.get("a0") ?? 0)).toBeGreaterThanOrEqual(190);
  });

  test("starts an item with another key without waiting for a paced one", async () => {
    const starts = await startTimes([...pagesOn("a", 2), ...pagesOn("b", 1)], 1);
    expect(starts.get("b0") ?? Infinity).toBeLessThan(starts.get("a1") ?? 0);
  });

  test("counts the gap from when the work says it started", async () => {
    const began = Date.now();
    const starts: number[] = [];
    await runPool(
      ["a1", "a2"],
      2,
      async (_item, _index, started) => {
        starts.push(Date.now() - began);
        await sleep(100);
        started();
      },
      undefined,
      { gapMs: 200, keyOf: (item) => item.slice(0, 1) },
    );
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(290);
  });

  test("starts the next item with the same key only after the previous one finished", async () => {
    const began = Date.now();
    const starts: number[] = [];
    await runPool(
      ["a1", "a2"],
      2,
      async (_item, _index, started) => {
        starts.push(Date.now() - began);
        started();
        await sleep(150);
      },
      undefined,
      { gapMs: 0, keyOf: (item) => item.slice(0, 1) },
    );
    expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(140);
  });

  test("still returns the results in item order", async () => {
    const results = await runPool(
      ["a1", "a2", "b1"],
      1,
      async (item) => item.toUpperCase(),
      undefined,
      { gapMs: 50, keyOf: (item) => item.slice(0, 1) },
    );
    expect(results).toStrictEqual(["A1", "A2", "B1"]);
  });
});
