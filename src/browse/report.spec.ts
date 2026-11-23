import { expect, test } from "bun:test";
import type { AskToolUseBlock } from "../ask/adapter.ts";
import { checkReport, REPORT_TOOLS } from "./report.ts";

const FOOTER_LINE =
  'The footer reads "Powered by Elemental Selenium and Sauce Labs"; the Elemental Selenium link points to https://elementalselenium.com/ so its description was not read.';

const reportUse = (input: AskToolUseBlock["input"]): AskToolUseBlock => ({
  type: "tool_use",
  id: "r",
  name: "report",
  input,
});

const answered = (part: string, lines: string[]) => ({ part, outcome: "answered", lines });

const hoversReport = reportUse({
  parts: [
    answered("the heading and instruction", [
      'The page heading is "Hovers" with the instruction "Hover over the image for additional information"',
    ]),
    answered("what the first avatar shows on hover", [
      'Hovering the first avatar shows "name: user1" and a View profile link',
    ]),
    { part: "what Elemental Selenium offers", outcome: "blocked", lines: [FOOTER_LINE] },
  ],
  how: "hovered the first avatar; the Elemental Selenium link was refused as off-site",
});

function answerOf(use: AskToolUseBlock) {
  const checked = checkReport("answer", use);
  if (!checked.ok) throw new Error(checked.error);
  if (!("lines" in checked.value)) throw new Error("expected an answer report");
  return checked.value;
}

test("a line written under a part the page did not answer is dropped", () => {
  expect(answerOf(hoversReport).lines).not.toContain(FOOTER_LINE);
});

test("the lines of the answered parts are kept in order", () => {
  expect(answerOf(hoversReport).lines).toStrictEqual([
    'The page heading is "Hovers" with the instruction "Hover over the image for additional information"',
    'Hovering the first avatar shows "name: user1" and a View profile link',
  ]);
});

test("a report with some parts answered is partial", () => {
  expect(answerOf(hoversReport).status).toBe("partial");
});

test("a report with every part answered is found", () => {
  const use = reportUse({
    parts: [answered("the yearly price of Acme Pro", ["Acme Pro costs 96 € per year"])],
    how: "switched the toggle",
  });
  expect(answerOf(use).status).toBe("found");
});

test("a report with no part answered and one blocked part is blocked", () => {
  const use = reportUse({
    parts: [
      { part: "what Elemental Selenium offers", outcome: "blocked", lines: [FOOTER_LINE] },
      { part: "its price", outcome: "not_found", lines: [] },
    ],
    how: "the link was refused",
  });
  expect(answerOf(use)).toMatchObject({ status: "blocked", lines: [] });
});

test("a report with no part answered and none blocked is not_found", () => {
  const use = reportUse({
    parts: [{ part: "the delivery time", outcome: "not_found", lines: [] }],
    how: "read the page",
  });
  expect(answerOf(use).status).toBe("not_found");
});

test("a part marked answered without a line counts as not answered", () => {
  const use = reportUse({
    parts: [
      answered("the yearly price of Acme Pro", ["Acme Pro costs 96 € per year"]),
      answered("the yearly price of Acme Team", [" "]),
    ],
    how: "switched the toggle",
  });
  expect(answerOf(use).status).toBe("partial");
});

test("a report without parts is refused", () => {
  expect(checkReport("answer", reportUse({ parts: [], how: "read the page" })).ok).toBe(false);
});

test("the answer report tool asks for the parts of the question with their outcomes", () => {
  expect(REPORT_TOOLS.answer.description).toBe(
    "Finish the task: send the parts of the question, each with its outcome and the lines that answer it. Call it exactly once, as your last call.",
  );
});
