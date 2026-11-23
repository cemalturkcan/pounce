import { expect, test } from "bun:test";
import { checkCounts, hasCountTag } from "./counts.ts";

const examples = (count: number) =>
  Array.from(
    { length: count },
    (_value, index) => `- [Example ${index + 1}](https://a.test/${index})`,
  );

const HOME = [
  "# Welcome",
  "## Available Examples",
  ...examples(76),
  "## Sponsors",
  "- Acme",
  "- Orbit",
].join("\n");

const line = (tag: string) => `- The home page lists 77 examples ${tag} [01-home.md]`;

test("a count tag that disagrees with the list under its heading is flagged with the real count", () => {
  expect(checkCounts(line('{count 77: list items under "Available Examples"}'), [HOME])).toBe(
    "- The home page lists 77 examples [count checked: 76, not 77] [01-home.md]",
  );
});

test("a count tag that agrees with the list under its heading is marked as checked", () => {
  expect(
    checkCounts(
      '- The home page lists 76 examples {count 76: list items under "Available Examples"} [01-home.md]',
      [HOME],
    ),
  ).toBe("- The home page lists 76 examples [count checked] [01-home.md]");
});

test("the heading of a count tag matches regardless of case and markup", () => {
  expect(
    checkCounts(line('{count 76: list items under "available examples"}'), [
      HOME.replace("## Available Examples", "## **Available** Examples"),
    ]),
  ).toBe("- The home page lists 77 examples [count checked] [01-home.md]");
});

test("list items count only the outermost level of a nested list", () => {
  const text = ["## Plans", "- Starter", "  - 5 users", "  - 1 GB", "- Pro", "  - 50 users"].join(
    "\n",
  );
  expect(checkCounts('- Acme has 2 plans {count 2: list items under "Plans"} [a.md]', [text])).toBe(
    "- Acme has 2 plans [count checked] [a.md]",
  );
});

test("numbered list items are counted", () => {
  const text = ["## Steps", "1. Open", "2. Fill", "3. Send"].join("\n");
  expect(
    checkCounts('- The guide has 3 steps {count 3: list items under "Steps"} [a.md]', [text]),
  ).toBe("- The guide has 3 steps [count checked] [a.md]");
});

test("a section ends at the next heading of the same level", () => {
  const text = ["## Plans", "- Starter", "### Extras", "- Backup", "## Other", "- Misc"].join("\n");
  expect(
    checkCounts('- Acme lists 2 plans {count 2: list items under "Plans"} [a.md]', [text]),
  ).toBe("- Acme lists 2 plans [count checked] [a.md]");
});

test("table rows count the body rows of the tables under the heading, without the header row", () => {
  const text = [
    "## Prices",
    "| Plan | Price |",
    "| --- | --- |",
    "| Starter | 5 € |",
    "| Pro | 10 € |",
  ].join("\n");
  expect(
    checkCounts('- Acme lists 3 plans {count 3: table rows under "Prices"} [a.md]', [text]),
  ).toBe("- Acme lists 3 plans [count checked: 2, not 3] [a.md]");
});

test("links count the Markdown links under the heading, without images", () => {
  const text = [
    "## Partners",
    "[Acme](https://acme.test) and [Orbit](https://orbit.test)",
    "![Logo](https://a.test/logo.png)",
  ].join("\n");
  expect(
    checkCounts('- The page links 2 partners {count 2: links under "Partners"} [a.md]', [text]),
  ).toBe("- The page links 2 partners [count checked] [a.md]");
});

test("headings count the headings inside the section", () => {
  const text = ["## Products", "### Lamp", "text", "### Desk", "#### Desk legs", "## Contact"].join(
    "\n",
  );
  expect(
    checkCounts('- The page shows 2 products {count 3: headings under "Products"} [a.md]', [text]),
  ).toBe("- The page shows 2 products [count checked] [a.md]");
});

test("a count tag on the page counts the whole text", () => {
  expect(
    checkCounts("- The page lists 78 items {count 78: list items on the page} [a.md]", [HOME]),
  ).toBe("- The page lists 78 items [count checked] [a.md]");
});

test("a count tag whose heading the page does not have is removed without a mark", () => {
  expect(checkCounts(line('{count 77: list items under "Examples list"}'), [HOME])).toBe(
    "- The home page lists 77 examples [01-home.md]",
  );
});

test("a count tag whose heading appears twice is removed without a mark", () => {
  expect(
    checkCounts(line('{count 77: list items under "Available Examples"}'), [`${HOME}\n${HOME}`]),
  ).toBe("- The home page lists 77 examples [01-home.md]");
});

test("a count tag is checked against the first text that has its heading", () => {
  expect(
    checkCounts(line('{count 77: list items under "Available Examples"}'), ["## Other\n- a", HOME]),
  ).toBe("- The home page lists 77 examples [count checked: 76, not 77] [01-home.md]");
});

test("a count tag without any text to check is removed without a mark", () => {
  expect(checkCounts(line("{count 77: list items on the page}"), [])).toBe(
    "- The home page lists 77 examples [01-home.md]",
  );
});

const PARAGRAPHS = "# Shop\n\n## Products\n\nLamp A\n\nLamp B\n\nLamp C\n\n## Footer\n\nbye";

test("a count tag whose section has no list items is removed without a mark", () => {
  expect(
    checkCounts('- 3 products {count 3: list items under "Products"} [01.md]', [PARAGRAPHS]),
  ).toBe("- 3 products [01.md]");
});

test("a count tag on a page without table rows is removed without a mark", () => {
  expect(checkCounts("- 3 rows {count 3: table rows on the page} [01.md]", [PARAGRAPHS])).toBe(
    "- 3 rows [01.md]",
  );
});

test("a line without a count tag is unchanged", () => {
  expect(checkCounts("- Acme Pro costs 10 € {per month} [a.md]", [HOME])).toBe(
    "- Acme Pro costs 10 € {per month} [a.md]",
  );
});

test("hasCountTag finds a count tag", () => {
  expect(hasCountTag(line("{count 77: links on the page}"))).toBe(true);
});

test("hasCountTag ignores a line without one", () => {
  expect(hasCountTag("- Acme Pro costs 10 € [a.md]")).toBe(false);
});

test("a count tag in an unexpected shape is removed without a mark", () => {
  expect(checkCounts(line("{count 77: items under Available Examples}"), [HOME])).toBe(
    "- The home page lists 77 examples [01-home.md]",
  );
});

test("hasCountTag finds a count tag in an unexpected shape", () => {
  expect(hasCountTag(line("{count 77: items under Available Examples}"))).toBe(true);
});
