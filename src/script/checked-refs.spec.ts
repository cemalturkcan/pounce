import { expect, test } from "bun:test";
import type { IssuedRef } from "../browser/ref.ts";
import { sameDocument } from "./checked-refs.ts";

const unplaced = (ref: string): IssuedRef => ({
  role: "button",
  name: ref,
  line: `- button "${ref}" [ref=${ref}]`,
  loads: 1,
  url: "https://example.test/",
  token: "1",
  path: [],
  bound: Promise.resolve(false),
});

test("two refs whose place a snapshot did not find are not one document", () => {
  expect(sameDocument(unplaced("e1"), unplaced("f1e1"))).toBe(false);
});
