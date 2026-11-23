import { expect, test } from "bun:test";
import type { BrowseResult } from "./run.ts";
import { askResultParts, renderAskResults, renderAskStats, renderBrowseDetails } from "./render.ts";
import { mergeBrowse } from "./escalation.ts";
import { absence, notAbsence, reportOf } from "../../tests/askFixtures.ts";

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
  expect(renderAskResults("q", report)).not.toMatch(/Nothing relevant in/);
});

for (const sentence of notAbsence)
  test(`a not_found browse keeps the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "a.md", outcome: "not_found" })]);
    expect(renderAskResults("Q?", merged).split("\n")).toContain(`- ${sentence} [a.md]`);
  });

for (const sentence of absence)
  test(`a not_found browse drops the read-phase line "${sentence}"`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "a.md", outcome: "not_found" })]);
    expect(renderAskResults("Q?", merged).split("\n")).not.toContain(`- ${sentence} [a.md]`);
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
  const text = renderAskResults("Q?", merged);
  expect(text).toMatch(/^- \[browsed\] B Pro costs 96 € per year when billed yearly \[b\.md\]$/m);
  expect(text).toMatch(/^Nothing relevant in: c\.md \(browsed: not_found\)$/m);
  expect(text).toMatch(/^Browsed 2 page\(s\):$/m);
  expect(text).toMatch(/^b\.md: found, 3 steps, 2 tool calls \(switched the Yearly toggle\)$/m);
  expect(text).toMatch(/^c\.md: not_found, 3 steps, 2 tool calls \(opened every tab\)$/m);
  expect(renderBrowseDetails(merged.browse?.results ?? [])).toMatch(
    /### b\.md[\s\S]*Outcome: found/,
  );
});

test("the stats name the browsing usage, which the answer text leaves out", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["b.md"], answers: [], notFound: ["b.md"] }]), [
    browsed({ lines: ["B Pro costs 96 € per year when billed yearly"] }),
  ]);
  expect(renderAskStats(merged, "fake", "m")).toMatch(
    /^Browsing usage: input tokens 300, output tokens 40\.$/m,
  );
});

test("the answer text leaves out the adapter and usage lines", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["b.md"], answers: [], notFound: ["b.md"] }]), [
    browsed({ lines: ["B Pro costs 96 € per year when billed yearly"] }),
  ]);
  expect(renderAskResults("Q?", merged)).not.toMatch(/usage|^Adapter:/im);
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
  const text = renderAskResults("Q?", merged);
  expect(text).toMatch(
    /^- \[browsed\] Notion Plus costs \$12 per seat per month when billed monthly \[notion\.md\]$/m,
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
  expect(renderAskResults("Q?", merged)).not.toMatch(/billing period is unclear/);
});

for (const outcome of ["blocked", "failed", "not_found"] as const)
  test(`a ${outcome} browse keeps the page's read-phase lines`, () => {
    const merged = mergeBrowse(notionRead(), [
      browsed({ source: "notion.md", outcome, lines: [] }),
    ]);
    expect(renderAskResults("Q?", merged)).toMatch(
      /^- The Notion Plus billing period is unclear \[notion\.md\]$/m,
    );
  });

test("a found browse replaces every read-phase line of its page", () => {
  const report = reportOf([
    {
      sources: ["boxes.md"],
      answers: ["- The Checkboxes page has no paragraphs and checkbox 2 is checked [boxes.md]"],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({ source: "boxes.md", lines: ["On the Checkboxes page, checkbox 2 is checked"] }),
  ]);
  expect(
    renderAskResults("Q?", merged)
      .split("\n")
      .filter((line) => line.startsWith("- ")),
  ).toStrictEqual(["- [browsed] On the Checkboxes page, checkbox 2 is checked [boxes.md]"]);
});

for (const outcome of ["timed_out", "failed", "no_report", "cancelled"] as const) {
  test(`a page whose browse ended ${outcome} is listed as not answered`, () => {
    const report = reportOf([
      {
        sources: ["a.md", "scroll.md"],
        answers: ["- A costs 5 € [a.md]"],
        notFound: ["scroll.md"],
      },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "scroll.md", outcome, lines: [] })]);
    expect(renderAskResults("Q?", merged)).toMatch(
      new RegExp(`^Not answered: scroll\\.md \\(browsed: ${outcome}\\)$`, "m"),
    );
  });

  test(`a page whose browse ended ${outcome} is not listed as nothing relevant`, () => {
    const report = reportOf([
      {
        sources: ["a.md", "scroll.md"],
        answers: ["- A costs 5 € [a.md]"],
        notFound: ["scroll.md"],
      },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "scroll.md", outcome, lines: [] })]);
    expect(renderAskResults("Q?", merged)).not.toMatch(/^Nothing relevant in/m);
  });
}

for (const outcome of ["timed_out", "failed", "no_report", "cancelled"] as const) {
  test(`a hint-escalated page that read fine and whose browse ended ${outcome} with no lines is listed as not answered`, () => {
    const report = reportOf([
      { sources: ["a.md", "h.md"], answers: ["- A is 5 [a.md]"], notFound: [] },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "h.md", outcome, lines: [] })]);
    expect(askResultParts("Q?", merged).notAnswered).toEqual(["h.md"]);
  });
}

test("a hint-escalated page whose browse ended timed_out shows in the Not answered line", () => {
  const report = reportOf([
    { sources: ["a.md", "h.md"], answers: ["- A is 5 [a.md]"], notFound: [] },
  ]);
  const merged = mergeBrowse(report, [browsed({ source: "h.md", outcome: "timed_out" })]);
  expect(renderAskResults("Q?", merged)).toMatch(/^Not answered: h\.md \(browsed: timed_out\)$/m);
});

test("a partial browse replaces every read-phase line of its page", () => {
  const report = reportOf([
    {
      sources: ["hovers.md"],
      answers: [
        "- The Hovers page heading reads Hovers [hovers.md]",
        "- Hovering the first avatar shows name: user1 [hovers.md]",
      ],
      notFound: [],
    },
  ]);
  const merged = mergeBrowse(report, [
    browsed({
      source: "hovers.md",
      outcome: "partial",
      lines: [
        "The Hovers page heading reads Hovers",
        "Hovering the first avatar shows name: user1",
      ],
    }),
  ]);
  expect(
    renderAskResults("Q?", merged)
      .split("\n")
      .filter((line) => line.startsWith("- ")),
  ).toStrictEqual([
    "- [browsed] The Hovers page heading reads Hovers [hovers.md]",
    "- [browsed] Hovering the first avatar shows name: user1 [hovers.md]",
  ]);
});

test("a page whose browse ended partial is listed as partly answered", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({
      source: "notion.md",
      outcome: "partial",
      lines: ["Notion Plus costs $10 per seat per month when billed yearly"],
    }),
  ]);
  expect(renderAskResults("Q?", merged)).toMatch(
    /^Partly answered: notion\.md \(browsed: partial\)$/m,
  );
});

test("a page whose browse found everything is not listed as partly answered", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({
      source: "notion.md",
      lines: ["Notion Plus costs $12 per seat per month when billed monthly"],
    }),
  ]);
  expect(renderAskResults("Q?", merged)).not.toMatch(/^Partly answered/m);
});

for (const outcome of ["timed_out", "failed", "no_report", "cancelled"] as const) {
  test(`a page with answer lines whose browse ended ${outcome} is listed as partly answered`, () => {
    const merged = mergeBrowse(notionRead(), [browsed({ source: "notion.md", outcome })]);
    expect(renderAskResults("Q?", merged)).toMatch(
      new RegExp(`^Partly answered: notion\\.md \\(browsed: ${outcome}\\)$`, "m"),
    );
  });

  test(`a page with answer lines whose browse ended ${outcome} is not listed as not answered`, () => {
    const merged = mergeBrowse(notionRead(), [browsed({ source: "notion.md", outcome })]);
    expect(renderAskResults("Q?", merged)).not.toMatch(/^Not answered/m);
  });
}

test("the partly answered list follows the answer lines", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({ source: "notion.md", outcome: "timed_out" }),
  ]);
  const lines = renderAskResults("Q?", merged).split("\n");
  expect(lines.slice(1, 6)).toStrictEqual([
    "",
    "- A costs 5 € [a.md]",
    "- The Notion Plus billing period is unclear [notion.md]",
    "",
    "Partly answered: notion.md (browsed: timed_out)",
  ]);
});

test("the nothing relevant header is left out when only unfinished pages remain", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["c.md"], answers: [], notFound: ["c.md"] }]), [
    browsed({ source: "c.md", outcome: "timed_out" }),
  ]);
  expect(renderAskResults("Q?", merged)).not.toMatch(/No page had anything relevant/);
});

test("the nothing relevant header stays when no page had answers or unfinished browses", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["c.md"], answers: [], notFound: ["c.md"] }]), [
    browsed({ source: "c.md", outcome: "not_found" }),
  ]);
  expect(renderAskResults("Q?", merged)).toMatch(/^No page had anything relevant\.$/m);
});

test("the no issues header is left out when a page was not fully checked", () => {
  const report = reportOf([{ sources: ["s.md"], answers: [], notFound: ["s.md"] }], "review");
  const merged = mergeBrowse(report, [browsed({ source: "s.md", outcome: "timed_out" })]);
  expect(renderAskResults("Check", merged)).not.toMatch(/No page had issues/);
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
  expect(renderAskResults("Q?", merged)).not.toMatch(/shows no monthly price/);
});

for (const outcome of ["not_found", "blocked"] as const)
  test(`lines of a ${outcome} browse report are not answers and the page stays in Nothing relevant in`, () => {
    const report = reportOf([
      { sources: ["a.md", "c.md"], answers: ["- A costs 5 € [a.md]"], notFound: ["c.md"] },
    ]);
    const merged = mergeBrowse(report, [
      browsed({
        source: "c.md",
        outcome,
        lines: ["The monthly price of C could not be read because the link leads off-site"],
      }),
    ]);
    const text = renderAskResults("Q?", merged);
    expect(text).toMatch(
      new RegExp(`^Nothing relevant in: c\\.md \\(browsed: ${outcome}\\)$`, "m"),
    );
  });

for (const outcome of ["not_found", "blocked"] as const)
  test(`a page whose read-phase line only stated absence and whose browse ended ${outcome} is listed as nothing relevant`, () => {
    const report = reportOf([
      {
        sources: ["a.md", "linear.md"],
        answers: [
          "- A costs 5 € [a.md]",
          "- The page shows no monthly price for Linear [linear.md]",
        ],
        notFound: [],
      },
    ]);
    const merged = mergeBrowse(report, [browsed({ source: "linear.md", outcome })]);
    const text = renderAskResults("Q?", merged);
    expect(text).toMatch(
      new RegExp(`^Nothing relevant in: linear\\.md \\(browsed: ${outcome}\\)$`, "m"),
    );
  });

test("29: browsed review issues are merged by severity and a clean interaction counts as OK", () => {
  const report = reportOf(
    [
      {
        sources: ["s.md", "t.md", "u.md"],
        answers: ["- [low] u.md, footer: icons low"],
        notFound: [],
      },
    ],
    "review",
  );
  const merged = mergeBrowse(report, [
    browsed({
      source: "s.md",
      issues: [{ severity: "high", where: "card 2 details (hover)", issue: "text overflows" }],
    }),
    browsed({ source: "t.md", issues: [] }),
  ]);
  const text = renderAskResults("Check", merged);
  const lines = text.split("\n");
  expect(
    lines.indexOf("- [high] [browsed] s.md, card 2 details (hover): text overflows"),
  ).toBeLessThan(lines.indexOf("- [low] u.md, footer: icons low"));
  expect(text).toMatch(/^No issues in: t\.md$/m);
});

test("a review page browsed only partly without issues is listed as not fully checked", () => {
  const merged = mergeBrowse(
    reportOf([{ sources: ["p.md"], answers: [], notFound: [] }], "review"),
    [browsed({ source: "p.md", outcome: "partial", issues: [] })],
  );
  expect(renderAskResults("Check", merged)).toMatch(/^Not fully checked: p\.md$/m);
});

test("the skipped note replaces the Browsed block when the adapter cannot use tools", () => {
  const merged = mergeBrowse(
    reportOf([{ sources: ["a.md"], answers: [], notFound: ["a.md"] }]),
    [],
    "Browsing skipped: the adapter fake does not support tool use (no converse()).",
  );
  expect(renderAskResults("Q?", merged)).toMatch(
    /^Browsing skipped: the adapter fake does not support tool use \(no converse\(\)\)\.$/m,
  );
});

const answerLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

test("the answer text lists the answer lines, browsed tag included", () => {
  const merged = mergeBrowse(
    reportOf([
      { sources: ["a.md", "b.md"], answers: ["- A costs 5 € [a.md]"], notFound: ["b.md"] },
    ]),
    [browsed({ lines: ["B Pro costs 96 € per year"], how: "switched the toggle" })],
  );
  expect(answerLines(renderAskResults("Q?", merged))).toEqual([
    "- A costs 5 € [a.md]",
    "- [browsed] B Pro costs 96 € per year [b.md]",
  ]);
});

test("the answer parts list the pages with nothing relevant as plain source names", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["c.md"], answers: [], notFound: ["c.md"] }]), [
    browsed({ source: "c.md", outcome: "not_found" }),
  ]);
  expect(askResultParts("Q?", merged).nothingRelevant).toEqual(["c.md"]);
});

test("the answer parts list pages whose browsing did not finish as not answered", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["c.md"], answers: [], notFound: ["c.md"] }]), [
    browsed({ source: "c.md", outcome: "timed_out" }),
  ]);
  const parts = askResultParts("Q?", merged);
  expect([parts.notAnswered, parts.nothingRelevant]).toEqual([["c.md"], []]);
});

test("the answer parts list partly answered pages as plain source names", () => {
  const merged = mergeBrowse(notionRead(), [
    browsed({
      source: "notion.md",
      outcome: "partial",
      lines: ["Notion Plus costs $10 per seat per month when billed yearly"],
    }),
  ]);
  expect(askResultParts("Q?", merged).partlyAnswered).toEqual(["notion.md"]);
});

test("the answer parts keep review issue lines sorted as rendered", () => {
  const report = reportOf(
    [
      {
        sources: ["a.md"],
        answers: ["- [low] a.md, footer: small gap", "- [high] a.md, header: overlap"],
        notFound: [],
      },
    ],
    "review",
  );
  expect(answerLines(renderAskResults("Check", report))).toEqual([
    "- [high] a.md, header: overlap",
    "- [low] a.md, footer: small gap",
  ]);
});

test("the answer parts text equals the rendered text", () => {
  const report = reportOf([{ sources: ["a.md"], answers: ["- x [a.md]"], notFound: [] }]);
  expect(askResultParts("Q?", report).text).toBe(renderAskResults("Q?", report));
});

const reviewRead = () =>
  reportOf(
    [
      {
        sources: ["s.md", "t.md"],
        answers: [
          "- [high] s.md, image cards: the first two images are broken",
          "- [medium] s.md, footer: two broken icons below the footer",
          "- [low] t.md, header: logo sits 2px low",
        ],
        notFound: [],
      },
    ],
    "review",
  );

test("a found review browse adds its issues to the first-pass issue lines of its page", () => {
  const merged = mergeBrowse(reviewRead(), [
    browsed({
      source: "s.md",
      issues: [{ severity: "high", where: "card 2 (hover)", issue: "the details text overflows" }],
    }),
  ]);
  expect(answerLines(renderAskResults("Check", merged))).toEqual([
    "- [high] s.md, image cards: the first two images are broken",
    "- [high] [browsed] s.md, card 2 (hover): the details text overflows",
    "- [medium] s.md, footer: two broken icons below the footer",
    "- [low] t.md, header: logo sits 2px low",
  ]);
});

test("a found review browse with no issues keeps the first-pass issue lines of its page", () => {
  const merged = mergeBrowse(reviewRead(), [browsed({ source: "s.md", issues: [] })]);
  expect(answerLines(renderAskResults("Check", merged))).toContain(
    "- [high] s.md, image cards: the first two images are broken",
  );
});

test("a found review browse with no issues leaves a page with first-pass issues out of No issues", () => {
  const merged = mergeBrowse(reviewRead(), [browsed({ source: "s.md", issues: [] })]);
  expect(renderAskResults("Check", merged)).not.toMatch(/^No issues in:/m);
});

test("a review browse that dropped a first-pass issue with evidence leaves it out of the issue lines", () => {
  const merged = mergeBrowse(reviewRead(), [
    browsed({
      source: "s.md",
      issues: [],
      dropped: [
        {
          issue: "- [medium] s.md, footer: two broken icons below the footer",
          evidence: "Follow us on Mastodon",
        },
      ],
    }),
  ]);
  expect(answerLines(renderAskResults("Check", merged))).toEqual([
    "- [high] s.md, image cards: the first two images are broken",
    "- [low] t.md, header: logo sits 2px low",
  ]);
});

test("a review browse that dropped a first-pass issue lists it with the quoted evidence", () => {
  const merged = mergeBrowse(reviewRead(), [
    browsed({
      source: "s.md",
      issues: [],
      dropped: [
        {
          issue: "- [medium] s.md, footer: two broken icons below the footer",
          evidence: "Follow us on Mastodon",
        },
      ],
    }),
  ]);
  expect(renderAskResults("Check", merged)).toContain(
    'Dropped by browsing:\n[medium] s.md, footer: two broken icons below the footer (the page shows "Follow us on Mastodon")',
  );
});

test("a review browse that disputed a first-pass issue without evidence keeps it marked", () => {
  const merged = mergeBrowse(reviewRead(), [
    browsed({
      source: "s.md",
      issues: [],
      disputed: ["- [high] s.md, image cards: the first two images are broken"],
    }),
  ]);
  expect(answerLines(renderAskResults("Check", merged))).toContain(
    "- [high] s.md, image cards: the first two images are broken [browse disagreed, without evidence on the page]",
  );
});

test("a blocked review browse keeps the first-pass issue lines of its page", () => {
  const merged = mergeBrowse(reviewRead(), [browsed({ source: "s.md", outcome: "blocked" })]);
  expect(answerLines(renderAskResults("Check", merged))).toContain(
    "- [high] s.md, image cards: the first two images are broken",
  );
});

test("a review page with a first-pass issue is not listed under No issues when another call found it clean", () => {
  const report = reportOf(
    [
      { sources: ["s.md"], answers: [], notFound: ["s.md"] },
      {
        sources: ["s.md"],
        answers: ["- [high] s.md, header: menu overlaps the logo"],
        notFound: [],
      },
    ],
    "review",
  );
  expect(askResultParts("Check", report).noIssues).toEqual([]);
});

test("the review answer parts list clean pages as noIssues and leave nothingRelevant empty", () => {
  const report = reportOf(
    [{ sources: ["s.md", "t.md"], answers: ["- [low] s.md, footer: gap"], notFound: ["t.md"] }],
    "review",
  );
  const parts = askResultParts("Check", report);
  expect([parts.noIssues, parts.nothingRelevant]).toEqual([["t.md"], []]);
});

test("the answer-mode parts leave noIssues empty", () => {
  const merged = mergeBrowse(reportOf([{ sources: ["c.md"], answers: [], notFound: ["c.md"] }]), [
    browsed({ source: "c.md", outcome: "not_found" }),
  ]);
  expect(askResultParts("Q?", merged).noIssues).toEqual([]);
});

test("the pointed answers frame points to the browsed field instead of listing each browse", () => {
  const report = reportOf([{ sources: ["b.md"], answers: ["- fact [b.md]"], notFound: [] }]);
  const merged = mergeBrowse(report, [browsed({ source: "b.md", how: "opened the toggle" })]);
  expect(askResultParts("Q?", merged).answersFrame("(answers)").split("\n")).toContain(
    "Browsed 1 page(s): (browsed in the browsed field)",
  );
});
