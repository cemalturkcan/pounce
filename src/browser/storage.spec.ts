import { expect, test } from "bun:test";
import { decodeWebStorage } from "./storage.ts";

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
