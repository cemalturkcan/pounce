import { expect, test } from "bun:test";
import { ASK_BROWSE_NOTE, ASK_SYSTEM, buildPrompt, REVIEW_SYSTEM } from "./prompt.ts";
import { image } from "../../tests/askFixtures.ts";

test("the answer prompt applies a question worded for one page to every page on its own", () => {
  expect(ASK_SYSTEM).toMatch(/The question applies to every page separately/);
  expect(ASK_SYSTEM).toMatch(
    /"this product", "this site", "this page" or "this plan" means the product, site, page or plan that each page is about/,
  );
  expect(ASK_SYSTEM).toMatch(
    /List a page as NOT FOUND only when it lacks the facts the question asks for/,
  );
  const prompt = buildPrompt("For this product, is there a free plan?", [
    { source: "01-alpha.md", text: "Alpha Free plan" },
    { source: "02-beta.md", text: "Beta Free plan" },
  ]);
  expect(prompt).toMatch(
    /\n\nAnswer the question for each page separately, from that page alone, in the language of the question\.$/,
  );
});

test("buildPrompt announces each page's screenshots right after its document, numbered in send order", () => {
  const prompt = buildPrompt("What is shown?", [
    { source: "a.md", text: "Alpha", images: [image("a.md tile 1/2"), image("a.md tile 2/2")] },
    { source: "b.md", text: "Beta" },
    { source: "c.md", text: "Gamma", images: [image("c.md region #chart")] },
  ]);
  expect(prompt).toMatch(
    /<\/document>\n<screenshots source="a\.md">Images 1-2 of this message: a\.md tile 1\/2, a\.md tile 2\/2<\/screenshots>\n\n<document source="b\.md">/,
  );
  expect(prompt).toMatch(
    /<document source="c\.md">\nGamma\n<\/document>\n<screenshots source="c\.md">Image 3 of this message: c\.md region #chart<\/screenshots>/,
  );
  expect(ASK_SYSTEM).toMatch(/screenshots/i);
  expect(ASK_SYSTEM).toMatch(/cite that page's source/);
});

test("buildPrompt in review mode sends the pages and their screenshots, then the request as a review brief", () => {
  const prompt = buildPrompt(
    "Check for broken layouts",
    [{ source: "a.md", text: "Alpha", images: [image("a.md tile 1/1")] }],
    "review",
  );
  expect(prompt).toMatch(
    /^<document source="a\.md">\nAlpha\n<\/document>\n<screenshots source="a\.md">Image 1 of this message: a\.md tile 1\/1<\/screenshots>/,
  );
  expect(prompt).toMatch(
    /<request>\nCheck for broken layouts\n<\/request>\n\nReview the pages above for visual and layout issues, in the language of the request\.$/,
  );
  expect(prompt).not.toMatch(/<question>/);
});

test("the review prompt describes screen-sized tiles and keeps tile artefacts out of the issues", () => {
  expect(REVIEW_SYSTEM).toMatch(
    /each one screen of the browser window, captured after scrolling to it/,
  );
  expect(REVIEW_SYSTEM).not.toMatch(/1600 px/);
  expect(REVIEW_SYSTEM).toMatch(
    /A fixed or sticky header, footer or banner appears on every tile by design/,
  );
  expect(REVIEW_SYSTEM).toMatch(
    /counter caught mid-animation, a marquee or a carousel cut at the edge of a tile is not a defect unless it is clearly broken/,
  );
  expect(REVIEW_SYSTEM).toMatch(
    /Keep high for unmistakable breakage: overlapping or cut text, broken images, error messages, or blank areas that should hold content/,
  );
});

test("the review prompt treats empty or dark areas as possible hover states", () => {
  expect(REVIEW_SYSTEM).toMatch(
    /An area that looks empty or dark may be a hover or interaction state, such as a card that stays blank until hovered, and is not a defect unless the surrounding layout shows content is missing/,
  );
});

test("the answer prompt sends a page that only lacks the fact to NOT FOUND or HIDDEN instead of an answer line", () => {
  expect(ASK_SYSTEM).toMatch(
    /A line that only says a page does not show or state something the question asks for is not an answer: leave it out and list the page as NOT FOUND/,
  );
  expect(ASK_BROWSE_NOTE).toMatch(/instead of a line saying the page does not show it/);
});
