import { expect, test } from "bun:test";
import {
  buildMatcher,
  cutSubtree,
  findInSnapshot,
  interactiveOnly,
  limitDepth,
  topLevelRefs,
} from "./snapshot.ts";

const SNAPSHOT = [
  "- generic [ref=e1]:",
  '  - heading "Shop" [level=1] [ref=e2]',
  "  - navigation [ref=e3]:",
  '    - link "Cart" [ref=e4] [cursor=pointer]:',
  "      - /url: /cart",
  "  - main [ref=e5]:",
  '    - textbox "Search" [ref=e6]',
  '    - button "Add to cart" [ref=e7]',
  "    - iframe [ref=e8]:",
  '      - button "Pay" [ref=f1e2]',
].join("\n");

test("interactiveOnly keeps a flat list of actionable elements", () => {
  expect(interactiveOnly(SNAPSHOT)).toBe(
    [
      '- link "Cart" [ref=e4] [cursor=pointer]',
      '- textbox "Search" [ref=e6]',
      '- button "Add to cart" [ref=e7]',
      '- button "Pay" [ref=f1e2]',
    ].join("\n"),
  );
});

test("findInSnapshot returns matches with their ancestors and counts overflow", () => {
  const found = findInSnapshot(SNAPSHOT, buildMatcher("pay", false), 10);
  expect(found.matches).toBe(1);
  expect(found.text).toBe(
    [
      "- generic [ref=e1]:",
      "  - main [ref=e5]:",
      "    - iframe [ref=e8]:",
      '      - button "Pay" [ref=f1e2]',
    ].join("\n"),
  );
  const limited = findInSnapshot(SNAPSHOT, buildMatcher("^\\s*- (button|link)", true), 1);
  expect(limited.matches).toBe(3);
  expect(limited.shown).toBe(1);
});

test("scoped snapshot helpers cut a subtree and keep its refs", () => {
  expect(cutSubtree(SNAPSHOT, "e5")).toBe(
    [
      "- main [ref=e5]:",
      '  - textbox "Search" [ref=e6]',
      '  - button "Add to cart" [ref=e7]',
      "  - iframe [ref=e8]:",
      '    - button "Pay" [ref=f1e2]',
    ].join("\n"),
  );
  expect(cutSubtree(SNAPSHOT, "e4")).toBe(
    ['- link "Cart" [ref=e4] [cursor=pointer]:', "  - /url: /cart"].join("\n"),
  );
  expect(cutSubtree(SNAPSHOT, "e99")).toBe(undefined);
  expect(limitDepth(cutSubtree(SNAPSHOT, "e5") ?? "", 1)).toBe("- main [ref=e5]:");
  expect(
    topLevelRefs(
      ['  - textbox "A" [ref=e3]', "    - text: x", '  - button "B" [ref=e9]'].join("\n"),
    ),
  ).toStrictEqual(["e3", "e9"]);
});
