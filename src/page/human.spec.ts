import { describe, expect, test } from "bun:test";
import { sleep } from "../shared/async.ts";
import {
  aimAt,
  aimWithin,
  clampPoint,
  glide,
  holdDelay,
  keyGap,
  keyHold,
  mayClosePage,
  type Point,
  settleDelay,
  startPoint,
  trajectory,
} from "./human.ts";

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const constant = (value: number) => () => value;

const from: Point = { x: 10, y: 10 };
const to: Point = { x: 400, y: 300 };

function offLine(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return (
    Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy)
  );
}

function along(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / Math.hypot(dx, dy);
}

const duration = (end: Point) =>
  trajectory(from, end, constant(0.5)).reduce((sum, step) => sum + step.delay, 0);

describe("trajectory", () => {
  test("samples many intermediate points", () => {
    expect(trajectory(from, to, seeded(1)).length).toBeGreaterThan(10);
  });

  test("ends close to the target", () => {
    const last = trajectory(from, to, seeded(2)).at(-1)?.point ?? from;
    expect(Math.hypot(last.x - to.x, last.y - to.y)).toBeLessThan(40);
  });

  test("waits 8 to 18 ms before each point", () => {
    const delays = trajectory(from, to, seeded(4)).map((step) => step.delay);
    expect(delays.every((delay) => delay >= 8 && delay <= 18)).toBe(true);
  });

  test("returns no points for a move shorter than 2 px", () => {
    expect(trajectory(from, { x: 11, y: 10 }, seeded(5))).toStrictEqual([]);
  });

  test("bows away from the straight line", () => {
    const furthest = Math.max(
      ...trajectory(from, to, constant(0.7)).map((step) => offLine(step.point, from, to)),
    );
    expect(furthest).toBeGreaterThan(20);
  });

  test("takes longer for a longer move", () => {
    expect(duration({ x: 900, y: 10 })).toBeGreaterThan(duration({ x: 60, y: 10 }));
  });

  test("overshoots a far target and comes back when the dice say so", () => {
    const far: Point = { x: 610, y: 10 };
    const distance = Math.hypot(far.x - from.x, far.y - from.y);
    const reach = Math.max(
      ...trajectory(from, far, constant(0.1)).map((step) => along(step.point, from, far)),
    );
    expect(reach).toBeGreaterThan(distance);
  });

  test("rounds coordinates to a tenth of a pixel", () => {
    const coordinates = trajectory(from, to, seeded(6)).flatMap((step) => [
      step.point.x,
      step.point.y,
    ]);
    expect(coordinates.every((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-6)).toBe(
      true,
    );
  });
});

describe("glide", () => {
  test("sums to the requested delta", () => {
    const total = glide(0, 600, seeded(7)).reduce((sum, frame) => sum + frame.y, 0);
    expect(total).toBeCloseTo(600, 6);
  });

  test("sends a short scroll in one frame", () => {
    expect(glide(0, 10, seeded(8))).toStrictEqual([{ x: 0, y: 10 }]);
  });

  test("starts fast and eases out", () => {
    const frames = glide(0, 800, seeded(9));
    expect((frames[0]?.y ?? 0) > (frames.at(-1)?.y ?? 0)).toBe(true);
  });
});

describe("clampPoint", () => {
  test("keeps a point inside the viewport", () => {
    expect(clampPoint({ x: -5, y: 900 }, { width: 800, height: 600 })).toStrictEqual({
      x: 0,
      y: 599,
    });
  });

  test("only removes negative coordinates when the viewport is unknown", () => {
    expect(clampPoint({ x: -5, y: 9000 }, undefined)).toStrictEqual({ x: 0, y: 9000 });
  });
});

describe("aimAt", () => {
  const box = { x: 100, y: 100, width: 80, height: 30 };

  test("lands off the exact center", () => {
    const aim = aimAt({}, box, constant(0.9));
    expect(aim).not.toStrictEqual({ x: 140, y: 115 });
  });

  test("keeps the same offset for the same target", () => {
    const state = {};
    const first = aimAt(state, box, seeded(10));
    expect(aimAt(state, box, seeded(11))).toStrictEqual(first);
  });

  test("stays inside a tiny element", () => {
    const tiny = { x: 50, y: 50, width: 2, height: 2 };
    const aim = aimAt({}, tiny, constant(1));
    expect(aim.x >= 50 && aim.x <= 52 && aim.y >= 50 && aim.y <= 52).toBe(true);
  });
});

describe("startPoint", () => {
  test("starts from the last pointer position", () => {
    expect(startPoint({ x: 5, y: 6 }, to, undefined, seeded(12))).toStrictEqual({ x: 5, y: 6 });
  });

  test("starts near the target on a page with no pointer yet", () => {
    const start = startPoint(undefined, to, undefined, seeded(13));
    expect(Math.abs(start.x - to.x) <= 260 && Math.abs(start.y - to.y) <= 180).toBe(true);
  });
});

describe("timing", () => {
  test("settles 45 to 130 ms before a press right after arriving", () => {
    expect(settleDelay(0, constant(0))).toBe(45);
  });

  test("does not settle again after a long rest on the target", () => {
    expect(settleDelay(2000, constant(1))).toBeLessThanOrEqual(0);
  });

  test("holds a press 60 to 140 ms", () => {
    expect(holdDelay(0, constant(1))).toBe(140);
  });

  test("spaces key presses 30 to 110 ms apart", () => {
    expect(keyGap(10, constant(0))).toBe(20);
  });

  test("holds a key 20 to 70 ms", () => {
    expect(keyHold(constant(1))).toBe(70);
  });

  test("adds no gap before the first key of a pause", () => {
    expect(keyGap(Number.POSITIVE_INFINITY, constant(1))).toBe(0);
  });
});

const COVERED = '<div id="cover"> intercepts pointer events';

async function coveredUntilOutOfTime(remaining: () => number) {
  if (remaining() < 100)
    throw Object.assign(new Error(`Timeout ${remaining()}ms exceeded.`), {
      name: "TimeoutError",
    });
  await sleep(30);
  return { problem: COVERED };
}

async function crashing(): Promise<{ problem: string }> {
  throw new Error("the page crashed");
}

describe("aimWithin", () => {
  test("a check that runs out of time after the deadline reports the last problem it found", async () => {
    await expect(aimWithin(300, coveredUntilOutOfTime)).rejects.toThrow(
      /intercepts pointer events/,
    );
  });

  test("an error before any problem was found is thrown as it is", async () => {
    await expect(aimWithin(250, crashing)).rejects.toThrow(/the page crashed/);
  });

  test("returns the point once a check finds one", async () => {
    expect(await aimWithin(250, async () => ({ point: { x: 3, y: 4 } }))).toStrictEqual({
      x: 3,
      y: 4,
    });
  });
});

const CLOSED = "mouse.move: Target page, context or browser has been closed";

function closingPage() {
  const page = { closed: false, isClosed: () => page.closed };
  return page;
}

describe("mayClosePage", () => {
  test("a page that closes after the input was sent counts as done", async () => {
    const page = closingPage();
    await mayClosePage(page, async (sending) => {
      sending();
      page.closed = true;
      throw new Error(CLOSED);
    });
    expect(page.isClosed()).toBe(true);
  });

  test("a page that closes before the input was sent reports the tab closed before the input", async () => {
    const page = closingPage();
    await expect(
      mayClosePage(page, async () => {
        page.closed = true;
        throw new Error(CLOSED);
      }),
    ).rejects.toThrow(/^The tab closed before the input was sent\.$/);
  });

  test("a page already closed when the input is sent reports the tab closed before the input", async () => {
    const page = closingPage();
    await expect(
      mayClosePage(page, async (sending) => {
        page.closed = true;
        sending();
        throw new Error(CLOSED);
      }),
    ).rejects.toThrow(/^The tab closed before the input was sent\.$/);
  });

  test("a failure on a page that stays open is thrown as it is", async () => {
    await expect(
      mayClosePage(closingPage(), async (sending) => {
        sending();
        throw new Error(CLOSED);
      }),
    ).rejects.toThrow(CLOSED);
  });
});
