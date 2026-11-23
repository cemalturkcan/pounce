import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { describeMissingTab, RANDOM_BASE_MIN, TabCounter, TabHistory } from "./tab-ids.ts";

const counterFile = z.object({ reserved: z.number() });
const historyFile = z.object({ tabs: z.array(z.json()) });

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
    expect(first).toMatch(/^t\d+$/);
    const start = Number(first.slice(1));
    expect([counter.next(), counter.next(), counter.next()]).toStrictEqual([
      `t${start + 1}`,
      `t${start + 2}`,
      `t${start + 3}`,
    ]);
    const saved = parseJsonOrThrow(
      await readFile(path.join(dir, "tab-counter.json"), "utf8"),
      counterFile,
    );
    expect(saved.reserved).toBe(start + 4);
    counter.next();
    counter.next();
    const grown = parseJsonOrThrow(
      await readFile(path.join(dir, "tab-counter.json"), "utf8"),
      counterFile,
    );
    expect(grown.reserved).toBe(start + 9);
  });
});

test("a restarted counter skips the rest of the reserved block", async () => {
  await withDir(async (dir) => {
    const before = new TabCounter(dir, { block: 10 });
    const used = [before.next(), before.next()].map((id) => Number(id.slice(1)));
    const after = new TabCounter(dir, { block: 10 });
    const next = Number(after.next().slice(1));
    expect(next).toBe((used[0] ?? 0) + 10);
  });
});

test("a missing or corrupt counter file starts from a random high base", async () => {
  await withDir(async (dir) => {
    const fresh = Number(new TabCounter(dir, { random: () => 0.5 }).next().slice(1));
    expect(fresh).toBeGreaterThanOrEqual(RANDOM_BASE_MIN);
    await writeFile(path.join(dir, "tab-counter.json"), "{not json");
    const recovered = Number(new TabCounter(dir, { random: () => 0 }).next().slice(1));
    expect(recovered).toBeGreaterThanOrEqual(RANDOM_BASE_MIN);
    await writeFile(path.join(dir, "tab-counter.json"), JSON.stringify({ reserved: -3 }));
    expect(Number(new TabCounter(dir).next().slice(1))).toBeGreaterThanOrEqual(RANDOM_BASE_MIN);
  });
});

test("a counter whose file cannot be written still hands out unique ids", async () => {
  await withDir(async (dir) => {
    const counter = new TabCounter(path.join(dir, "missing", "\0bad"), { block: 2 });
    const ids = new Set(Array.from({ length: 7 }, () => counter.next()));
    expect(ids.size).toBe(7);
  });
});

test("a missing tab that was at a data URL is described by its type and length", () => {
  const url = `data:text/html,${"x".repeat(500)}`;
  expect(describeMissingTab("t8", { id: "t8", url, end: "closed" })).toBe(
    `Tab t8 is not open (it was at data:text/html… (${url.length} chars)); it was closed.`,
  );
});

test("a missing tab is described with its last known url and title and how it ended", () => {
  expect(describeMissingTab("t5", undefined)).toBe("Tab t5 is not open.");
  expect(
    describeMissingTab("t5", {
      id: "t5",
      url: "https://shop.test/cart",
      title: "Cart",
      end: "closed",
    }),
  ).toBe('Tab t5 is not open (it was at https://shop.test/cart "Cart"); it was closed.');
  expect(
    describeMissingTab("t6", { id: "t6", url: "https://shop.test/", end: "closed-outside" }),
  ).toBe("Tab t6 is not open (it was at https://shop.test/); it was closed outside this session.");
  expect(
    describeMissingTab("t7", { id: "t7", url: "about:blank", title: "", end: "restart" }),
  ).toMatch(
    /^Tab t7 is not open \(it was at about:blank\); it was open before the daemon restarted, and tab ids are never reused\.$/,
  );
});

test("tab history keeps the most recent tabs in memory and across restarts", async () => {
  await withDir(async (dir) => {
    let live = [{ id: "t900", url: "https://live.test/", title: "Live" }];
    const history = new TabHistory(dir, () => live, { limit: 3 });
    for (const index of [1, 2, 3, 4])
      history.closed(
        { id: `t${index}`, url: `https://x.test/${index}`, title: `Page ${index}` },
        "closed",
      );
    expect(history.find("t1")).toBe(undefined);
    expect(history.find("t4")).toStrictEqual({
      id: "t4",
      url: "https://x.test/4",
      title: "Page 4",
      end: "closed",
    });
    history.flush();
    live = [];
    const reloaded = new TabHistory(dir, () => live, { limit: 3 });
    expect(reloaded.find("t2")).toBe(undefined);
    expect(reloaded.find("t3")?.end).toBe("closed");
    expect(reloaded.find("t900")).toStrictEqual({
      id: "t900",
      url: "https://live.test/",
      title: "Live",
      end: "restart",
    });
    const saved = parseJsonOrThrow(
      await readFile(path.join(dir, "tab-history.json"), "utf8"),
      historyFile,
    );
    expect(saved.tabs.length).toBe(3);
  });
});

test("a corrupt tab history file is ignored", async () => {
  await withDir(async (dir) => {
    await writeFile(path.join(dir, "tab-history.json"), "[1,");
    const history = new TabHistory(dir, () => []);
    expect(history.find("t1")).toBe(undefined);
    history.closed({ id: "t1", url: "https://x.test/" }, "closed-outside");
    expect(history.find("t1")?.end).toBe("closed-outside");
  });
});
