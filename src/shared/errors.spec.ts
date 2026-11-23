import { expect, test } from "bun:test";
import { z } from "zod";
import {
  closedAfterInput,
  CoveredByOwnLabel,
  errorFrom,
  messageOf,
  describeError,
  describeScriptMessage,
  timedOutWithin,
  ToolError,
} from "./errors.ts";

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

const unmatched = (action: string, ...log: string[]) =>
  new Error([`${action}: Timeout 8000ms exceeded.`, "Call log:", ...log].join("\n"));

test("a timeout waiting for an element that never appeared says so in a plain sentence", () => {
  expect(describeError(unmatched("dragTo", "  - waiting for locator('#column-a')"))).toBe(
    "Nothing matched #column-a within 8 s.\nTake a snapshot to see the current page, then retry with a ref or selector from it.",
  );
});

test("a timeout waiting for the second element of an action names that element", () => {
  expect(
    describeError(
      unmatched(
        "dragTo",
        "  - waiting for locator('#a')",
        "  - performing move and down action",
        "  - waiting for locator('#nope')",
      ),
    ).split("\n")[0],
  ).toBe("Nothing matched #nope within 8 s.");
});

test("a timeout waiting for a locator the call resolved names the selector the call was given", () => {
  const given = 'p >> text="Nope" >> nth=1';
  const locator = "locator('p').locator('text=\"Nope\"').nth(1)";
  expect(
    describeError(
      unmatched("click", `  - waiting for ${locator}`),
      new Map([[locator, given]]),
    ).split("\n")[0],
  ).toBe(`Nothing matched ${given} within 8 s.`);
});

test("a timeout waiting for a locator built another way names it as written", () => {
  expect(
    describeError(unmatched("innerText", "  - waiting for getByText('Save').first()")).split(
      "\n",
    )[0],
  ).toBe("Nothing matched getByText('Save').first() within 8 s.");
});

test("a timeout waiting for a chained locator names the chain as the agent wrote it", () => {
  expect(
    describeError(unmatched("click", "  - waiting for locator('body').locator('#nope')")).split(
      "\n",
    )[0],
  ).toBe("Nothing matched body >> #nope within 8 s.");
});

test("a timeout waiting for a frame locator names the frame chain as the agent wrote it", () => {
  expect(
    describeError(
      unmatched("click", "  - waiting for locator('iframe').contentFrame().locator('#nope')"),
    ).split("\n")[0],
  ).toBe("Nothing matched iframe >> internal:control=enter-frame >> #nope within 8 s.");
});

test("a timeout waiting for a selector with an escaped quote shows the quote plainly", () => {
  expect(
    describeError(
      unmatched("click", "  - waiting for locator('button:has-text(\"Sa\\'v\")')"),
    ).split("\n")[0],
  ).toBe('Nothing matched button:has-text("Sa\'v") within 8 s.');
});

const strictViolation = (locator: string) =>
  new Error(
    [
      `waitFor: Error: strict mode violation: ${locator} resolved to 3 elements:`,
      "    1) <button>a</button> aka getByRole('button', { name: 'a' })",
      "    2) <button>b</button> aka getByRole('button', { name: 'b' })",
      "    3) <button>c</button> aka getByRole('button', { name: 'c' })",
      "",
      "Call log:",
      `\u001B[2m  - waiting for ${locator}\u001B[22m`,
    ].join("\n"),
  );

test("a selector that matched several elements is named with how many it matched", () => {
  expect(describeError(strictViolation("locator('button')")).split("\n")[0]).toBe(
    "The target button matched 3 elements, but the call acts on exactly one.",
  );
});

test("a selector that matched several elements names the selector the call was given", () => {
  const locator = "locator('body').locator('button')";
  expect(
    describeError(strictViolation(locator), new Map([[locator, "body button"]])).split("\n")[0],
  ).toBe("The target body button matched 3 elements, but the call acts on exactly one.");
});

test("a selector that matched several elements lists them without Playwright locators", () => {
  expect(describeError(strictViolation("locator('button')")).split("\n").slice(1, 4)).toEqual([
    "1) <button>a</button>",
    "2) <button>b</button>",
    "3) <button>c</button>",
  ]);
});

test("a selector that matched several elements ends with the way to pick one", () => {
  expect(describeError(strictViolation("locator('button')")).split("\n").at(-1)).toBe(
    "The selector matched several elements. Use a ref from snapshot, or a more specific selector.",
  );
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

test("a click blocked by an element inside the target's own label is told to click the label", () => {
  const text = describeError(
    new CoveredByOwnLabel(
      interceptedClick('<input id="basic-toggle" type="checkbox"/>', '<div class="thumb"></div>'),
      '<label for="basic-toggle" class="switch">…</label>',
    ),
  );
  expect(text).toMatch(
    /^Its label covers the target: <div class="thumb"><\/div> inside <label for="basic-toggle" class="switch">…<\/label>\. Click that label instead/m,
  );
});

test("a click blocked inside the target's own label does not suggest dismiss_overlays", () => {
  const text = describeError(
    new CoveredByOwnLabel(
      interceptedClick('<input id="basic-toggle" type="checkbox"/>', '<div class="thumb"></div>'),
      '<label for="basic-toggle" class="switch">…</label>',
    ),
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

test("describeError reads an HTTP error status with an empty body as no network failure", () => {
  const text = describeError(
    new Error("page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://example.test/missing"),
  );
  expect(text).toMatch(/HTTP error status and an empty body; this is not a network failure/);
});

test("describeError keeps the network wording for a network failure", () => {
  const text = describeError(new Error("page.goto: net::ERR_CONNECTION_RESET at https://x.test/"));
  expect(text).toMatch(/failed at the network level/);
});

const unresolved = new Error(
  [
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.test/",
    "Call log:",
    '  - navigating to "https://x.test/", waiting until "domcontentloaded"',
  ].join("\n"),
);

test("describeError says in a plain sentence which URL a navigation could not load, with the error code", () => {
  expect(describeError(unresolved).split("\n")[0]).toBe(
    "Could not load https://x.test/ (net::ERR_NAME_NOT_RESOLVED).",
  );
});

test("describeError names a data URL a navigation could not load by its short form", () => {
  const url = `data:text/html,${"x".repeat(500)}`;
  expect(describeError(new Error(`page.goto: net::ERR_ABORTED at ${url}`)).split("\n")[0]).toBe(
    `Could not load data:text/html… (${url.length} chars) (net::ERR_ABORTED).`,
  );
});

test("describeError leaves the call log out of a failed navigation", () => {
  expect(describeError(unresolved)).not.toMatch(/Call log|navigating to/);
});

test("describeError tells the next step for a host name that does not resolve", () => {
  expect(describeError(unresolved)).toMatch(
    /The host name does not resolve: check the URL for a typo, or whether the site exists\./,
  );
});

const closedClick = (...log: string[]) =>
  new Error(
    [
      "locator.click: Target page, context or browser has been closed",
      "Call log:",
      "  - waiting for locator('#finish')",
      ...log,
    ].join("\n"),
  );

test("a page that closed after the click was performed is closed after input", () => {
  expect(closedAfterInput(closedClick("  - done scrolling", "  - performing click action"))).toBe(
    true,
  );
});

test("a page that closed after a key press reached its element is closed after input", () => {
  expect(
    closedAfterInput(
      new Error(
        [
          "locator.press: Target page, context or browser has been closed",
          "Call log:",
          "  - waiting for locator('#name')",
          '  - elementHandle.press("Enter")',
        ].join("\n"),
      ),
    ),
  ).toBe(true);
});

test("a page that closed after the click was performed is closed after input in a colored call log", () => {
  expect(closedAfterInput(closedClick("\u001b[2m    - performing click action\u001b[22m"))).toBe(
    true,
  );
});

test("a page that closed while the click still waited for its element is not closed after input", () => {
  expect(
    closedAfterInput(closedClick("  - waiting for element to be visible, enabled and stable")),
  ).toBe(false);
});

test("a page that closed during typing into its element is closed after input", () => {
  expect(
    closedAfterInput(
      new Error(
        [
          "locator.pressSequentially: Target page, context or browser has been closed",
          "Call log:",
          "  - waiting for locator('#name')",
          '  - elementHandle.type("done")',
        ].join("\n"),
      ),
    ),
  ).toBe(true);
});

test("a direct mouse or keyboard error alone is no evidence that the input was sent", () => {
  expect(
    closedAfterInput(new Error("mouse.move: Target page, context or browser has been closed")),
  ).toBe(false);
});

test("a failure other than a closed page is not closed after input", () => {
  expect(closedAfterInput(new Error("locator.click: Timeout 1500ms exceeded."))).toBe(false);
});

test("timedOutWithin reports the given timeout in place of a fractional one", () => {
  expect(
    timedOutWithin(new Error("scrollIntoViewIfNeeded: Timeout 301.0560000000005ms exceeded."), 1000)
      .message,
  ).toBe("scrollIntoViewIfNeeded: Timeout 1000ms exceeded.");
});

test("describeError names a fractional timeout of an unmatched target in whole milliseconds", () => {
  expect(
    describeError(
      new Error(
        "locator.click: Timeout 633.7340000000004ms exceeded.\nCall log:\n  - waiting for locator('#go')",
      ),
    ).split("\n")[0],
  ).toBe("Nothing matched #go within 0.634 s.");
});

const clickTimeout =
  "locator.click: Timeout 500ms exceeded.\nCall log:\n\u001b[2m  - waiting for locator('#missing')\u001b[22m\n";
const missingSentence = "Nothing matched #missing within 0.5 s.";
const snapshotAdvice =
  "Take a snapshot to see the current page, then retry with a ref or selector from it.";

test("describeScriptMessage gives a quoted browser call it no longer tracks in its described form", () => {
  expect(describeScriptMessage(`step 2: ${clickTimeout}`, [])).toBe(
    describeScriptMessage(`step 2: ${clickTimeout}`, [
      { text: clickTimeout, cause: new Error(clickTimeout) },
    ]),
  );
});

test("describeScriptMessage keeps the script's line after an untracked browser call before its advice", () => {
  expect(describeScriptMessage(`step 2: ${clickTimeout}\nwhile checking out`, [])).toBe(
    `step 2: ${missingSentence}\nwhile checking out\n${snapshotAdvice}`,
  );
});

test("describeScriptMessage describes each untracked browser call a message quotes", () => {
  expect(describeScriptMessage(`${clickTimeout}\nthen ${clickTimeout}`, [])).toBe(
    `${missingSentence}\nthen ${missingSentence}\n${snapshotAdvice}`,
  );
});

test("describeScriptMessage puts a quoted tool error's hint after the script's sentence", () => {
  const lost = new ToolError("Tab t9 is not open.", "List tabs with tabs.");
  expect(
    describeScriptMessage("step 2: Tab t9 is not open. (gave up)", [
      { text: lost.message, cause: lost },
    ]),
  ).toBe("step 2: Tab t9 is not open. (gave up)\nList tabs with tabs.");
});

test("describeScriptMessage puts a quoted browser call's advice after the script's sentence", () => {
  expect(
    describeScriptMessage(`step 2: ${clickTimeout} (gave up)`, [
      { text: clickTimeout, cause: new Error(clickTimeout) },
    ]),
  ).toBe(`step 2: ${missingSentence} (gave up)\n${snapshotAdvice}`);
});

test("describeScriptMessage puts the advice of every quoted call after the script's sentence", () => {
  const lost = new ToolError("Tab t9 is not open.", "List tabs with tabs.");
  expect(
    describeScriptMessage(`${clickTimeout}; ${lost.message}`, [
      { text: clickTimeout, cause: new Error(clickTimeout) },
      { text: lost.message, cause: lost },
    ]),
  ).toBe(`${missingSentence}; Tab t9 is not open.\n${snapshotAdvice}\nList tabs with tabs.`);
});

test("describeScriptMessage keeps the script's line after a quoted browser call before its advice", () => {
  expect(
    describeScriptMessage(`step 2: ${clickTimeout}\nwhile checking out`, [
      { text: clickTimeout, cause: new Error(clickTimeout) },
    ]),
  ).toBe(`step 2: ${missingSentence}\nwhile checking out\n${snapshotAdvice}`);
});

test("describeScriptMessage puts a quoted strict mode violation's advice after the script's sentence", () => {
  const violation = strictViolation("locator('button')");
  expect(
    describeScriptMessage(`step 2: ${violation.message} (gave up)`, [
      { text: violation.message, cause: violation },
    ])
      .split("\n")
      .at(-1),
  ).toBe(
    "The selector matched several elements. Use a ref from snapshot, or a more specific selector.",
  );
});
