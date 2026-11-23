import { expect, test } from "bun:test";
import { describeNotLoaded } from "./ask-documents.ts";

test("a page that did not load from a data URL is named by its type and length", () => {
  const url = `data:text/html,${"x".repeat(500)}`;
  expect(describeNotLoaded({ url, reason: "timed out" })).toBe(
    `Not loaded: data:text/html… (${url.length} chars) — timed out`,
  );
});
