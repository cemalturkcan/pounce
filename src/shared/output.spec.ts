import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { inSequence } from "./async.ts";
import { clipHeadTail, clipWindow, OutputStore, Redactor, slugify } from "./output.ts";

test("clipHeadTail keeps both ends on line boundaries", () => {
  const text = Array.from({ length: 100 }, (_value, index) => `line ${index}`).join("\n");
  const clipped = clipHeadTail(text, 200);
  expect(clipped.truncated).toBe(true);
  expect(clipped.totalChars).toBe(text.length);
  expect(clipped.text).toMatch(/^line 0\n/);
  expect(clipped.text).toMatch(/line 99$/);
  expect(clipped.text).toMatch(/chars omitted/);
  expect(clipHeadTail("short", 200).truncated).toBe(false);
});

test("clipWindow pages through text", () => {
  const first = clipWindow("abcdefghij", 0, 4);
  expect([first.text, first.end, first.hasMore]).toStrictEqual(["abcd", 4, true]);
  const last = clipWindow("abcdefghij", 8, 4);
  expect([last.text, last.end, last.hasMore]).toStrictEqual(["ij", 10, false]);
  expect(clipWindow("abc", 99, 4).text).toBe("");
});

test("Redactor masks registered values and ignores trivial ones", () => {
  const redactor = new Redactor();
  redactor.register("site:password", "hunter2-long");
  redactor.register("site:pin", "12");
  expect(redactor.redact("value=hunter2-long and 12")).toBe("value=<secret:site:password> and 12");
});

test("Redactor masks JSON-escaped and URL-encoded forms", () => {
  const redactor = new Redactor();
  const value = 'p@ss "word"/ä &x';
  redactor.register("site:password", value);
  expect(redactor.redact(JSON.stringify({ password: value }))).toBe(
    '{"password":"<secret:site:password>"}',
  );
  expect(redactor.redact(`a=${encodeURIComponent(value)}&b=1`)).toBe(
    "a=<secret:site:password>&b=1",
  );
  expect(redactor.redact(`a=${encodeURIComponent(value).replace(/%20/g, "+")}`)).toBe(
    "a=<secret:site:password>",
  );
});

test("Redactor drops values once their time to live has passed", () => {
  let now = 1000;
  const redactor = new Redactor(() => now);
  redactor.register("site:otp", "123456", 120_000);
  expect(redactor.redact("code 123456")).toBe("code <secret:site:otp>");
  now += 120_001;
  expect(redactor.redact("order 123456")).toBe("order 123456");
});

test("OutputStore redacts text files unless raw, and prune keeps durable kinds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-store-"));
  try {
    const redactor = new Redactor();
    redactor.register("site:password", "pw-secret-9");
    const store = new OutputStore(root, redactor);
    expect(await readFile(await store.write("evaluate", "a.txt", "x pw-secret-9 y"), "utf8")).toBe(
      "x <secret:site:password> y",
    );
    expect(
      await readFile(await store.write("har", "a.har", "pw-secret-9", { raw: true }), "utf8"),
    ).toBe("pw-secret-9");
    expect(
      (
        await readFile(await store.write("screenshots", "a.bin", Buffer.from("pw-secret-9")))
      ).toString(),
    ).toBe("pw-secret-9");
    await inSequence(
      ["pages", "downloads", "cookies", "har", "extract", "snapshots", "collect"],
      async (kind) => {
        await mkdir(path.join(root, kind), { recursive: true });
        const file = path.join(root, kind, "old.txt");
        await writeFile(file, "old");
        const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        await utimes(file, old, old);
      },
    );
    await store.prune();
    await inSequence(["pages", "downloads", "cookies", "har", "extract"], async (kind) =>
      expect(
        await readdir(path.join(root, kind)).then((names) => names.includes("old.txt")),
      ).toStrictEqual(true),
    );
    await inSequence(["snapshots", "collect"], async (kind) =>
      expect(await readdir(path.join(root, kind))).toStrictEqual([]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slugify makes file-safe names", () => {
  expect(slugify("https://Example.com/a/b?c=1")).toBe("example-com-a-b-c-1");
  expect(slugify("???")).toBe("page");
});
