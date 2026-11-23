import { expect, test } from "bun:test";
import { sleep, untilAborted } from "../shared/async.ts";
import { cancelled } from "../shared/errors.ts";
import { decodeWebStorage, inTurn } from "./storage.ts";

test("a web storage key named __proto__ is kept as an entry", () => {
  const entries = decodeWebStorage([
    ["__proto__", "polluted"],
    ["theme", "dark"],
  ]);
  expect(Object.entries(entries)).toStrictEqual([
    ["__proto__", "polluted"],
    ["theme", "dark"],
  ]);
});

test("a key the page never stored reads as missing even when Object.prototype has it", () => {
  const entries = decodeWebStorage([["theme", "dark"]]);
  expect(entries.constructor).toBeUndefined();
});

const never = new Promise<never>(() => undefined);

const stuckUntilEnded = (signal: AbortSignal) => () => untilAborted(never, signal, cancelled);

test("a turn on a tab runs once the stuck turn before it has ended its call", async () => {
  const tab = {};
  const stuck = new AbortController();
  void inTurn(tab, stuck.signal, stuckUntilEnded(stuck.signal)).catch(() => undefined);
  const later = inTurn(tab, new AbortController().signal, async () => "read");
  stuck.abort();
  expect(await later).toBe("read");
});

test("a turn cancelled while it waits ends at once", async () => {
  const tab = {};
  const running = new AbortController().signal;
  void inTurn(tab, running, stuckUntilEnded(running));
  const waiting = new AbortController();
  const cancelledTurn = inTurn(tab, waiting.signal, async () => "read");
  waiting.abort();
  expect(await cancelledTurn.then(String, () => "ended")).toBe("ended");
});

test("a turn waits for an earlier turn still running even when a turn between them was cancelled", async () => {
  const tab = {};
  const order: string[] = [];
  const first = inTurn(tab, new AbortController().signal, async () => {
    await sleep(30);
    order.push("first");
  });
  const between = new AbortController();
  void inTurn(tab, between.signal, async () => order.push("between")).catch(() => undefined);
  between.abort();
  await inTurn(tab, new AbortController().signal, async () => order.push("third"));
  await first;
  expect(order).toStrictEqual(["first", "third"]);
});
