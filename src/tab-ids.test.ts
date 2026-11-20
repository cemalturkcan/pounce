import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { describeMissingTab, RANDOM_BASE_MIN, TabCounter, TabHistory } from "./tab-ids.ts";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "web-agent-tab-ids-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("tab ids keep counting in the tN format and reserve numbers in blocks", async () => {
  await withDir(async (dir) => {
    const counter = new TabCounter(dir, { block: 5 });
    const first = counter.next();
    assert.match(first, /^t\d+$/);
    const start = Number(first.slice(1));
    assert.deepEqual([counter.next(), counter.next(), counter.next()], [`t${start + 1}`, `t${start + 2}`, `t${start + 3}`]);
    const saved = JSON.parse(await readFile(path.join(dir, "tab-counter.json"), "utf8")) as { reserved: number };
    assert.equal(saved.reserved, start + 4);
    counter.next();
    counter.next();
    const grown = JSON.parse(await readFile(path.join(dir, "tab-counter.json"), "utf8")) as { reserved: number };
    assert.equal(grown.reserved, start + 9);
  });
});

test("a restarted counter skips the rest of the reserved block", async () => {
  await withDir(async (dir) => {
    const before = new TabCounter(dir, { block: 10 });
    const used = [before.next(), before.next()].map((id) => Number(id.slice(1)));
    const after = new TabCounter(dir, { block: 10 });
    const next = Number(after.next().slice(1));
    assert.equal(next, (used[0] ?? 0) + 10);
  });
});

test("a missing or corrupt counter file starts from a random high base", async () => {
  await withDir(async (dir) => {
    const fresh = Number(new TabCounter(dir, { random: () => 0.5 }).next().slice(1));
    assert.ok(fresh >= RANDOM_BASE_MIN, String(fresh));
    await writeFile(path.join(dir, "tab-counter.json"), "{not json");
    const recovered = Number(new TabCounter(dir, { random: () => 0 }).next().slice(1));
    assert.ok(recovered >= RANDOM_BASE_MIN, String(recovered));
    await writeFile(path.join(dir, "tab-counter.json"), JSON.stringify({ reserved: -3 }));
    assert.ok(Number(new TabCounter(dir).next().slice(1)) >= RANDOM_BASE_MIN);
  });
});

test("a counter whose file cannot be written still hands out unique ids", async () => {
  await withDir(async (dir) => {
    const counter = new TabCounter(path.join(dir, "missing", "\0bad"), { block: 2 });
    const ids = new Set(Array.from({ length: 7 }, () => counter.next()));
    assert.equal(ids.size, 7);
  });
});

test("a missing tab is described with its last known url and title and how it ended", () => {
  assert.equal(describeMissingTab("t5", undefined), "Tab t5 is not open.");
  assert.equal(
    describeMissingTab("t5", { id: "t5", url: "https://shop.test/cart", title: "Cart", end: "closed" }),
    'Tab t5 is not open (it was at https://shop.test/cart "Cart"); it was closed.',
  );
  assert.equal(
    describeMissingTab("t6", { id: "t6", url: "https://shop.test/", end: "closed-outside" }),
    "Tab t6 is not open (it was at https://shop.test/); it was closed outside this session.",
  );
  assert.match(describeMissingTab("t7", { id: "t7", url: "about:blank", title: "", end: "restart" }), /^Tab t7 is not open \(it was at about:blank\); it was open before the daemon restarted, and tab ids are never reused\.$/);
});

test("tab history keeps the most recent tabs in memory and across restarts", async () => {
  await withDir(async (dir) => {
    let live = [{ id: "t900", url: "https://live.test/", title: "Live" }];
    const history = new TabHistory(dir, () => live, { limit: 3 });
    for (const index of [1, 2, 3, 4]) history.closed({ id: `t${index}`, url: `https://x.test/${index}`, title: `Page ${index}` }, "closed");
    assert.equal(history.find("t1"), undefined);
    assert.deepEqual(history.find("t4"), { id: "t4", url: "https://x.test/4", title: "Page 4", end: "closed" });
    history.flush();
    live = [];
    const reloaded = new TabHistory(dir, () => live, { limit: 3 });
    assert.equal(reloaded.find("t2"), undefined);
    assert.equal(reloaded.find("t3")?.end, "closed");
    assert.deepEqual(reloaded.find("t900"), { id: "t900", url: "https://live.test/", title: "Live", end: "restart" });
    const saved = JSON.parse(await readFile(path.join(dir, "tab-history.json"), "utf8")) as { tabs: unknown[] };
    assert.equal(saved.tabs.length, 3);
  });
});

test("a corrupt tab history file is ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "tab-history.json"), "[1,");
    const history = new TabHistory(dir, () => []);
    assert.equal(history.find("t1"), undefined);
    history.closed({ id: "t1", url: "https://x.test/" }, "closed-outside");
    assert.equal(history.find("t1")?.end, "closed-outside");
  });
});
