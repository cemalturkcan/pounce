import { expect, test } from "bun:test";
import type { BrowseResult } from "./run.ts";
import { renderAskResults, renderBrowseDetails } from "./render.ts";
import { mergeBrowse } from "./escalation.ts";
import {
  absence,
  notAbsence,
  reportOf,
  uncertainOnly,
  uncertainWithFact,
} from "../../tests/askFixtures.ts";

test("a page answered in one call is dropped from another call's NOT FOUND list", () => {
  const report = {
    batches: [
      {
        index: 1,
        sources: ["a.md", "b.md"],
        answers: ["- fact [a.md]"],
        notFound: ["b.md"],
        ms: 1,
      },
      {
        index: 2,
        sources: ["a.md", "b.md"],
        answers: ["- other [b.md]"],
        notFound: ["a.md"],
        ms: 1,
      },
    ],
    empty: [],
    clipped: [],
  };
  expect(renderAskResults("q", report, "fake", "haiku")).not.toMatch(/Nothing relevant in/);
});

for (const sentence of notAbsence)
  test(`a not_found browse keeps the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "a.md", outcome: "not_found" })]);
    expect(renderAskResults("Q?", merged, "fake", "m").split("\n")).toContain(
      `- ${sentence} [a.md]`,
    );
  });

for (const sentence of absence)
  test(`a not_found browse drops the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "a.md", outcome: "not_found" })]);
    expect(renderAskResults("Q?", merged, "fake", "m").split("\n")).not.toContain(
      `- ${sentence} [a.md]`,
    );
  });

const browsed = (over: Partial<BrowseResult>): BrowseResult => ({
  source: "b.md",
  url: "https://b.test/",
  outcome: "found",
  lines: [],
  steps: 3,
  toolCalls: [{ name: "find" }, { name: "click" }],
  ms: 1200,
  usage: { input_tokens: 300, output_tokens: 40 },
  ...over,
});

test("29: browsed lines cite the original page, which leaves Nothing relevant in, and not_found keeps it there", () => {
  const report = reportOf([
    {
      sources: ["a.md", "b.md", "c.md"],
      answers: ["- A costs 5 € [a.md]"],
      notFound: ["b.md", "c.md"],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({
      lines: ["B Pro costs 96 € per year when billed yearly"],
      how: "switched the Yearly toggle",
    }),
    browsed({ source: "c.md", outcome: "not_found", lines: [], how: "opened every tab" }),
  ]);
  const text = renderAskResults("Q?", merged, "fake", "m");
  expect(text).toMatch(/^- B Pro costs 96 € per year when billed yearly \[b\.md\]$/m);
  expect(text).toMatch(/^Nothing relevant in: c\.md \(browsed: not_found\)$/m);
  expect(text).toMatch(/^Browsed 2 page\(s\):$/m);
  expect(text).toMatch(/^b\.md: found, 3 steps, 2 tool calls \(switched the Yearly toggle\)$/m);
  expect(text).toMatch(/^c\.md: not_found, 3 steps, 2 tool calls \(opened every tab\)$/m);
  expect(text).toMatch(/^Browsing usage: input tokens 600, output tokens 80\.$/m);
  expect(renderBrowseDetails(merged.browse?.results ?? [])).toMatch(
    /### b\.md[\s\S]*Outcome: found/,
  );
});

const notionRead = () =>
  reportOf([
    {
      sources: ["a.md", "notion.md"],
      answers: ["- A costs 5 € [a.md]", "- The Notion Plus billing period is unclear [notion.md]"],
      notFound: [],
    },
  ]);

test("a found browse replaces the read-phase line that left the fact unclear", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({
      source: "notion.md",
      outcome: "found",
      lines: ["Notion Plus costs $12 per seat per month when billed monthly"],
    }),
  ]);
  const text = renderAskResults("Q?", merged, "fake", "m");
  expect(text).toMatch(
    /^- Notion Plus costs \$12 per seat per month when billed monthly \[notion\.md\]$/m,
  );
  expect(text).not.toMatch(/billing period is unclear/);
  expect(text).toMatch(/^- A costs 5 € \[a\.md\]$/m);
});

test("a partial browse replaces the read-phase line that left the fact unclear", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({
      source: "notion.md",
      outcome: "partial",
      lines: ["Notion Plus costs $10 per seat per month when billed yearly"],
    }),
  ]);
  expect(renderAskResults("Q?", merged, "fake", "m")).not.toMatch(/billing period is unclear/);
});

test("a found browse keeps an unclear read-phase line that also carries a fact", () => {
  const report = reportOf([
    {
      sources: ["acme.md"],
      answers: ["- Acme Pro costs $16 per month, unclear whether taxes are included [acme.md]"],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({ source: "acme.md", lines: ["Acme Pro prices exclude VAT"] }),
  ]);
  expect(renderAskResults("Q?", merged, "fake", "m")).toMatch(
    /^- Acme Pro costs \$16 per month, unclear whether taxes are included \[acme\.md\]$/m,
  );
});

for (const sentence of uncertainOnly)
  test(`a found browse replaces the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["acme.md"], answers: [`- ${sentence} [acme.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [
      browsed({ source: "acme.md", lines: ["Acme Pro includes SSO when billed yearly"] }),
    ]);
    expect(renderAskResults("Q?", merged, "fake", "m").split("\n")).not.toContain(
      `- ${sentence} [acme.md]`,
    );
  });

for (const sentence of uncertainWithFact)
  test(`a found browse keeps the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["acme.md"], answers: [`- ${sentence} [acme.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [
      browsed({ source: "acme.md", lines: ["Acme Pro prices exclude VAT"] }),
    ]);
    expect(renderAskResults("Q?", merged, "fake", "m").split("\n")).toContain(
      `- ${sentence} [acme.md]`,
    );
  });

for (const outcome of ["blocked", "failed", "not_found"] as const)
  test(`a ${outcome} browse keeps the page's read-phase lines`, () => {
    const merged = mergeBrowse(notionRead(), [
      browsed({ source: "notion.md", outcome, lines: [] }),
    ]);
    expect(renderAskResults("Q?", merged, "fake", "m")).toMatch(
      /^- The Notion Plus billing period is unclear \[notion\.md\]$/m,
    );
  });

test("a partial browse with fewer lines keeps the earlier facts it does not resolve", () => {
  const report = reportOf([
    {
      sources: ["acme.md"],
      answers: [
        "- Acme Starter costs $8 per month when billed yearly [acme.md]",
        "- Acme Pro costs $16 per month when billed yearly [acme.md]",
        "- The page shows no monthly price for Acme [acme.md]",
      ],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({
      source: "acme.md",
      outcome: "partial",
      lines: ["Acme Starter costs $10 per month when billed monthly"],
    }),
  ]);
  const text = renderAskResults("Q?", merged, "fake", "m");
  expect(text).toMatch(/^- Acme Pro costs \$16 per month when billed yearly \[acme\.md\]$/m);
});

test("a found browse drops the read-phase line that only said the fact was missing", () => {
  const report = reportOf([
    {
      sources: ["acme.md"],
      answers: [
        "- Acme Pro costs $16 per month when billed yearly [acme.md]",
        "- The page shows no monthly price for Acme [acme.md]",
      ],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({ source: "acme.md", lines: ["Acme Pro costs $20 per month when billed monthly"] }),
  ]);
  expect(renderAskResults("Q?", merged, "fake", "m")).not.toMatch(/shows no monthly price/);
});

test("lines of a not_found browse report are not answers and the page stays in Nothing relevant in", () => {
  const report = reportOf([
    { sources: ["a.md", "c.md"], answers: ["- A costs 5 € [a.md]"], notFound: ["c.md"] },
  ]);
  const merged = mergeBrowse(report, [
    browsed({
      source: "c.md",
      outcome: "not_found",
      lines: ["The monthly price of C was not found after switching the toggle"],
    }),
  ]);
  const text = renderAskResults("Q?", merged, "fake", "m");
  expect(text).not.toMatch(/^- The monthly price of C/m);
  expect(text).toMatch(/^Nothing relevant in: c\.md \(browsed: not_found\)$/m);
});

test("a page whose read-phase line only stated absence and whose browse found nothing is listed as nothing relevant", () => {
  const report = reportOf([
    {
      sources: ["a.md", "linear.md"],
      answers: ["- A costs 5 € [a.md]", "- The page shows no monthly price for Linear [linear.md]"],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [browsed({ source: "linear.md", outcome: "not_found" })]);
  const text = renderAskResults("Q?", merged, "fake", "m");
  expect(text).not.toMatch(/shows no monthly price/);
  expect(text).toMatch(/^Nothing relevant in: linear\.md \(browsed: not_found\)$/m);
});

test("29: browsed review issues are merged by severity and a clean interaction counts as OK", () => {
  const report = reportOf(
    [{ sources: ["s.md", "t.md"], answers: ["- [low] s.md, footer: icons low"], notFound: [] }],
    "review",
  );
  const merged = mergeBrowse(report, [
    browsed({
      source: "s.md",
      issues: [{ severity: "high", where: "card 2 details (hover)", issue: "text overflows" }],
    }),
    browsed({ source: "t.md", issues: [] }),
  ]);
  const text = renderAskResults("Check", merged, "fake", "m");
  const lines = text.split("\n");
  expect(lines.indexOf("- [high] s.md, card 2 details (hover): text overflows")).toBeLessThan(
    lines.indexOf("- [low] s.md, footer: icons low"),
  );
  expect(text).toMatch(/^No issues in: t\.md$/m);
});

test("the skipped note replaces the Browsed block when the adapter cannot use tools", () => {
  const merged = mergeBrowse(
    reportOf([{ sources: ["a.md"], answers: [], notFound: ["a.md"] }]),
    [],
    "Browsing skipped: the adapter fake does not support tool use (no converse()).",
  );
  expect(renderAskResults("Q?", merged, "fake", "m")).toMatch(
    /^Browsing skipped: the adapter fake does not support tool use \(no converse\(\)\)\.$/m,
  );
});
