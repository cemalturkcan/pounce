import { expect, test } from "bun:test";
import { BROWSE_SYSTEM, browseFirstMessage, browseSystem } from "./prompt.ts";
import { REPORT_TOOLS } from "./report.ts";

const input = {
  mode: "answer" as const,
  source: "a.md",
  tab: "t1",
  url: "https://acme.test/pricing",
  found: ["- Acme Starter costs $8 per month [a.md]"],
  sites: ["acme.test"],
  question: "What does each plan cost?",
};

test("the first message lists the unclear lines apart from what was found", () => {
  const message = browseFirstMessage({
    ...input,
    unclear: ["- Acme Pro costs $16 per month, unclear whether taxes are included [a.md]"],
  });
  expect(message).toContain(
    "Found so far:\n- Acme Starter costs $8 per month [a.md]\nUnclear so far:\n- Acme Pro costs $16 per month, unclear whether taxes are included [a.md]\n",
  );
});

test("the first message has no unclear section when nothing was unclear", () => {
  expect(browseFirstMessage(input)).not.toContain("Unclear so far");
});

test("the browsing prompt asks an answered part to repeat the first reader's facts, since they are replaced", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /When a part is answered, your lines replace the first reader's lines for this page, so also write the facts it found that are still true/,
  );
});

test("the browsing prompt says the lines of a part that is not answered are dropped", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Only the lines of answered parts reach the agent; the lines of a not_found or blocked part are dropped/,
  );
});

test("the browsing prompt shows a blocked part after a refused off-site link", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /\{"part": "what Acme Labs offers", "outcome": "blocked", "lines": \[\]\}/,
  );
});

test("the browsing prompt keeps facts of an unrelated page out of the start page's lines", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Facts found only on a page unrelated to the start page's subject do not answer a part for it/,
  );
});

test("the report part outcome names a refused action as blocked", () => {
  expect(JSON.stringify(REPORT_TOOLS.answer.inputSchema)).toMatch(
    /blocked: a sign-in wall, a CAPTCHA or a refused action kept you from it/,
  );
});

test("the report lines say a link label never answers a part", () => {
  expect(JSON.stringify(REPORT_TOOLS.answer.inputSchema)).toMatch(
    /A link label or the name of the place it points to never answers a part/,
  );
});

test("the review browsing prompt keeps the first reviewer's issues unless one is dropped with quoted evidence", () => {
  expect(browseSystem("review")).toMatch(
    /The issues found so far stay in the result unless you drop one in dropped, with its number and the page text that shows it is not real/,
  );
});

test("the review browsing prompt asks to drop an issue found so far that it doubts even without page text to quote", () => {
  expect(browseSystem("review")).toMatch(
    /When your check leaves you doubting an issue found so far, drop it in dropped even when no page text shows it; without a quote it stays, marked as disputed\./,
  );
});

test("the review browsing prompt asks issues to hold only what the first message did not list", () => {
  expect(browseSystem("review")).toMatch(/issues holds only what the first message did not list/);
});

test("the review browsing prompt keeps broken images, 404 links and error states as issues unless the request says otherwise", () => {
  expect(browseSystem("review")).toMatch(
    /broken images, links that lead to a 404 or error page and error states are issues even when the page seems to exist to show them, unless the request says to leave them out/,
  );
});

test("the review first message asks to check the issues found so far", () => {
  const message = browseFirstMessage({
    ...input,
    mode: "review",
    found: ["- [high] a.md, image cards: the first two images are broken"],
  });
  expect(message).toMatch(/check the issues found so far/);
});

test("the review first message numbers the issues found so far", () => {
  const message = browseFirstMessage({
    ...input,
    mode: "review",
    found: [
      "- [high] a.md, image cards: the first two images are broken",
      "- [low] a.md, footer: icons sit low",
    ],
  });
  expect(message).toContain(
    "Issues found so far:\n1. [high] a.md, image cards: the first two images are broken\n2. [low] a.md, footer: icons sit low\n",
  );
});

test("the browsing prompt says every line must answer its part", () => {
  expect(BROWSE_SYSTEM).toMatch(/Every line must answer its part/);
});

test("the browsing prompt shows a footer label as a wrong line in a worked counter-example", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Counter-example, for "What does Acme Labs offer\?" on a page whose footer reads "Powered by Acme Labs"/,
  );
});

test("the report lines say only an answered part keeps its lines", () => {
  expect(JSON.stringify(REPORT_TOOLS.answer.inputSchema)).toMatch(
    /Only an answered part has lines: the lines of a part that is not_found or blocked are dropped/,
  );
});

test("the browsing prompt keeps the search on pages reached from the start page", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Lines come only from the page in <page> and pages you reached from it while pursuing this question about it/,
  );
});

test("the browsing prompt makes a start page with nothing for the question not_found without exploring other sections", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /When the page in <page> has nothing for the question, report every part not_found without exploring unrelated sections of the site/,
  );
});

test("the browsing prompt asks for a count tag on lines that count items", () => {
  expect(BROWSE_SYSTEM).toMatch(/\{count N: list items under "<heading>"\}/);
});

test("the report tool asks for a count tag on lines that count items", () => {
  expect(JSON.stringify(REPORT_TOOLS.answer.inputSchema)).toMatch(/count tag/);
});

test("the browsing prompt names a fact's own subject when it is not the asked one", () => {
  expect(BROWSE_SYSTEM).toContain(
    "Answer exactly what the question asks about. When a page's fact belongs to a broader, narrower or neighbouring subject (another place, entity, period, version or unit), name that subject in the line; never present it as the answer for the asked subject.",
  );
});

test("the browsing prompt keeps a line as short as the question allows", () => {
  expect(BROWSE_SYSTEM).toContain(
    "A line is as short as the question allows: a number question gets the number, its unit and its subject, with no restating of the question and no background.",
  );
});

test("the browsing prompt checks the language of every line before reporting", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Before you call report, check every line once more: it is in the language of the question, also when the pages you read are in another language/,
  );
});

test("the browsing prompt keeps the how sentence out of the lines", () => {
  expect(BROWSE_SYSTEM).toMatch(/how is for the logs only and never one of the lines/);
});

test("the report lines are asked for in the language of the question", () => {
  expect(JSON.stringify(REPORT_TOOLS.answer.inputSchema)).toMatch(
    /each in the language of the question, naming its subject/,
  );
});
