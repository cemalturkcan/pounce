import { expect, test } from "bun:test";
import { BROWSE_SYSTEM, browseFirstMessage } from "./prompt.ts";

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

test("the browsing prompt asks for new and corrected facts, since the first reader's facts are kept", () => {
  expect(BROWSE_SYSTEM).toMatch(
    /Leave out what the first reader already found unless you saw it change; when you did, write the fact as the page now shows it/,
  );
});
