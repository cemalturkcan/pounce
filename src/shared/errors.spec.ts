import { expect, test } from "bun:test";
import { z } from "zod";
import { errorFrom, messageOf, describeError, ToolError } from "./errors.ts";

test("errorFrom returns a thrown Error unchanged", () => {
  const thrown = new TypeError("bad input");
  expect(errorFrom(thrown)).toBe(thrown);
});

test("errorFrom wraps a thrown non-Error with its text and keeps it as the cause", () => {
  const error = errorFrom("connection reset");
  expect({ message: error.message, cause: error.cause }).toStrictEqual({
    message: "connection reset",
    cause: "connection reset",
  });
});

test("messageOf reads the message of a thrown Error", () => {
  expect(messageOf(new Error("page closed"))).toBe("page closed");
});

test("messageOf turns a thrown non-Error into text", () => {
  expect(messageOf(404)).toBe("404");
});

test("describeError keeps the call log tail and adds a next step", () => {
  const error = new Error(
    [
      "locator.click: Timeout 1500ms exceeded.",
      "Call log:",
      "  - waiting for locator('#buy')",
      '  - <div class="overlay"> intercepts pointer events',
      "  - retrying click action",
    ].join("\n"),
  );
  const text = describeError(error);
  expect(text).toMatch(/^locator\.click: Timeout 1500ms exceeded\./);
  expect(text).toMatch(/intercepts pointer events/);
  expect(text).toMatch(/Another element covers the target/);
  expect(describeError(new ToolError("Bad input.", "Do this instead."))).toBe(
    "Bad input.\nDo this instead.",
  );
  expect(describeError("plain")).toBe("plain");
});

const interceptedClick = (target: string, covering: string) =>
  new Error(
    [
      "page.click: Timeout 1500ms exceeded.",
      "Call log:",
      "\u001B[2m  - waiting for locator('#yearly')\u001B[22m",
      `\u001B[2m    - locator resolved to ${target}\u001B[22m`,
      "\u001B[2m  - attempting click action\u001B[22m",
      "\u001B[2m    2 × waiting for element to be visible, enabled and stable\u001B[22m",
      "\u001B[2m      - element is visible, enabled and stable\u001B[22m",
      "\u001B[2m      - scrolling into view if needed\u001B[22m",
      "\u001B[2m      - done scrolling\u001B[22m",
      `\u001B[2m      - ${covering} intercepts pointer events\u001B[22m`,
      "\u001B[2m    - retrying click action\u001B[22m",
      "\u001B[2m    - waiting 20ms\u001B[22m",
    ].join("\n"),
  );

test("a click blocked by the target's own label is told to click that label", () => {
  const text = describeError(
    interceptedClick(
      '<input id="yearly" type="checkbox"/>',
      '<label for="yearly">Billed yearly</label>',
    ),
  );
  expect(text).toMatch(
    /^Its label covers the target: <label for="yearly">Billed yearly<\/label>\. Click that label instead/m,
  );
  expect(text).not.toMatch(/dismiss_overlays/);
});

test("a click blocked by an element inside a label is told to click the label", () => {
  const text = describeError(
    interceptedClick(
      '<input id="yearly" type="checkbox"/>',
      '<span>Yearly</span> from <label class="switch">…</label> subtree',
    ),
  );
  expect(text).toMatch(
    /^Its label covers the target: <span>Yearly<\/span> inside <label class="switch">…<\/label>\. Click that label instead/m,
  );
  expect(text).not.toMatch(/dismiss_overlays/);
});

test("a click blocked by another control's label names it and keeps dismiss_overlays", () => {
  const text = describeError(
    interceptedClick(
      '<input id="yearly" type="checkbox"/>',
      '<label for="newsletter">Send me news</label>',
    ),
  );
  expect(text).toMatch(
    /^Another control's label covers the target: <label for="newsletter">Send me news<\/label>\. Run dismiss_overlays/m,
  );
});

test("a click blocked by an overlay names it and suggests dismiss_overlays", () => {
  const text = describeError(
    interceptedClick('<button id="buy">Buy</button>', '<div class="overlay">…</div>'),
  );
  expect(text).toMatch(
    /^Another element covers the target: <div class="overlay">…<\/div>\. Run dismiss_overlays/m,
  );
});

test("describeError reports a schema mismatch with its first issue in the first line and one line per issue after it", () => {
  const mismatch = z
    .object({ jsonld: z.array(z.json()), url: z.string() })
    .safeParse({ jsonld: [Number.NaN], url: 7 });
  expect(describeError(mismatch.error)).toBe(
    "The data does not have the expected form: Invalid input at jsonld[0]\n✖ Invalid input: expected string, received number\n  → at url\n✖ Invalid input\n  → at jsonld[0]",
  );
});
