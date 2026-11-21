import { expect, test } from "bun:test";
import { selectEscalations } from "./escalation.ts";
import { absence, notAbsence, reportOf } from "../../tests/askFixtures.ts";

test("28: selectEscalations takes NOT FOUND and HIDDEN pages, skips answered pages and failed calls, and all takes every read page", () => {
  const report = reportOf([
    {
      sources: ["a.md", "b.md", "c.md"],
      answers: ["- A costs 5 € [a.md]"],
      notFound: ["b.md", "c.md"],
      escalations: [{ source: "a.md", hint: "Yearly switch" }],
    },
    { sources: ["c.md", "d.md"], answers: ["- C costs 7 € [c.md]"], notFound: [] },
    { sources: ["e.md"], answers: [], notFound: [], error: "rate limited" },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    { source: "a.md", reason: "hidden", hint: "Yearly switch", found: ["- A costs 5 € [a.md]"] },
    { source: "b.md", reason: "not_found", found: [] },
  ]);
  expect(
    selectEscalations(report, "all").map((escalation) => [escalation.source, escalation.reason]),
  ).toStrictEqual([
    ["a.md", "hidden"],
    ["b.md", "not_found"],
    ["c.md", "all"],
    ["d.md", "all"],
  ]);
  const review = reportOf(
    [
      {
        sources: ["s.md", "t.md"],
        answers: [],
        notFound: ["t.md"],
        escalations: [{ source: "s.md", hint: "header: hover" }],
      },
    ],
    "review",
  );
  expect(selectEscalations(review, "auto")).toStrictEqual([
    { source: "s.md", reason: "interaction", hint: "header: hover", found: [] },
  ]);
});

test("selectEscalations takes a page whose only answer states that the page lacks the fact", () => {
  const report = reportOf([
    {
      sources: ["linear.md"],
      answers: ["- The page shows no monthly price for the Linear plans [linear.md]"],
      notFound: [],
    },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    { source: "linear.md", reason: "not_found", found: [] },
  ]);
});

test("selectEscalations takes a page answered in part that states another part is missing, passing only its facts", () => {
  const report = reportOf([
    {
      sources: ["a.md"],
      answers: [
        "- Acme Pro costs $96 per year when billed yearly [a.md]",
        "- Monthly prices are not listed on the Acme pricing page [a.md]",
      ],
      notFound: [],
    },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    {
      source: "a.md",
      reason: "not_found",
      found: ["- Acme Pro costs $96 per year when billed yearly [a.md]"],
    },
  ]);
});

test("selectEscalations leaves a page answered with a negative fact about its subject", () => {
  const report = reportOf([
    {
      sources: ["a.md", "b.md"],
      answers: ["- Acme has no free plan [a.md]", "- The Free plan does not include SSO [b.md]"],
      notFound: [],
    },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([]);
});

for (const sentence of notAbsence)
  test(`selectEscalations reads "${sentence}" as an answer`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    expect(selectEscalations(report, "auto")).toStrictEqual([]);
  });

for (const sentence of absence)
  test(`selectEscalations reads "${sentence}" as not found`, () => {
    const report = reportOf([
      { sources: ["a.md"], answers: [`- ${sentence} [a.md]`], notFound: [] },
    ]);
    expect(selectEscalations(report, "auto")).toStrictEqual([
      { source: "a.md", reason: "not_found", found: [] },
    ]);
  });

test("selectEscalations reads a page that shows no monthly price as not found", () => {
  const report = reportOf([
    { sources: ["a.md"], answers: ["- The page shows no monthly price [a.md]"], notFound: [] },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    { source: "a.md", reason: "not_found", found: [] },
  ]);
});

test("selectEscalations passes an unclear line that carries a fact to the browser as unclear, not as found", () => {
  const report = reportOf([
    {
      sources: ["a.md"],
      answers: [
        "- Acme Starter costs $8 per month [a.md]",
        "- Acme Pro costs $16 per month, unclear whether taxes are included [a.md]",
      ],
      notFound: [],
      escalations: [{ source: "a.md", hint: "Tax note toggle" }],
    },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    {
      source: "a.md",
      reason: "hidden",
      hint: "Tax note toggle",
      found: ["- Acme Starter costs $8 per month [a.md]"],
      unclear: ["- Acme Pro costs $16 per month, unclear whether taxes are included [a.md]"],
    },
  ]);
});

test("selectEscalations passes an unclear line without a fact to the browser as unclear", () => {
  const report = reportOf([
    {
      sources: ["a.md"],
      answers: ["- The Acme Pro billing period is unclear [a.md]"],
      notFound: [],
      escalations: [{ source: "a.md", hint: "Yearly switch" }],
    },
  ]);
  expect(selectEscalations(report, "auto")).toStrictEqual([
    {
      source: "a.md",
      reason: "hidden",
      hint: "Yearly switch",
      found: [],
      unclear: ["- The Acme Pro billing period is unclear [a.md]"],
    },
  ]);
});
