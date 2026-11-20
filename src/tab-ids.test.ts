import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RANDOM_BASE_MIN, TabCounter } from "./tab-ids.ts";

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
