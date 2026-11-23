import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  AskAdapter,
  AskInput,
  AskToolResultBlock,
  AskToolUseBlock,
  ConverseInput,
  ConverseReply,
} from "../src/ask/adapter.ts";
import { repeatUntil, sleep } from "../src/shared/async.ts";
import {
  scriptedAdapter,
  type ScriptedAdapter,
  type ScriptStep,
} from "../tests/scriptedAdapter.ts";
import { replayAdapter } from "../tests/replayAdapter.ts";
import { parseJsonOrThrow } from "../src/shared/decode.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { startFixture, type Fixture } from "./fixture.ts";
import { browseDownloads, browseOrders } from "./fixture-browse.ts";
import { holdsFocus } from "./tools-harness.ts";
import { AskAdapterSource } from "../src/ask/adapter-source.ts";
import { type ToolArgs, useMcpHarness } from "../tests/mcpHarness.ts";

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };

type Route = { match: RegExp; steps: ScriptStep[] };
let routes: Route[] = [];
const conversations = new Map<string, ScriptedAdapter>();
const prompts: AskInput[] = [];

function phaseOne(input: AskInput) {
  prompts.push(input);
  const sources = [...input.prompt.matchAll(/<document source="([^"]+)">/g)].map(
    (match) => match[1] ?? "",
  );
  const review = input.system.includes("visual and layout problems");
  const firstPassIssues = input.prompt.includes("broken images")
    ? sources.map((source) => `[high] ${source}, image cards: the first image is broken`)
    : input.prompt.includes("empty panels")
      ? sources.map((source) => `[high] ${source}, card 1: the details panel is empty`)
      : [];
  if (review)
    return {
      text: [
        ...firstPassIssues,
        ...sources.map(
          (source) =>
            `NEEDS INTERACTION: ${source}, card 2: hover over card 2 and check its details panel`,
        ),
      ].join("\n"),
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  const interaction = input.system.includes("<interaction>");
  const examples = sources.filter((source) => source.includes("examples"));
  if (examples.length)
    return {
      text: examples
        .flatMap((source) =>
          [
            `- The Welcome page lists 7 examples {count 7: list items under "Available Examples"} [${source}]`,
          ].concat(
            interaction ? [`HIDDEN: ${source}: the Show more button lists more examples`] : [],
          ),
        )
        .join("\n"),
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  const hidden = !interaction
    ? []
    : sources
        .filter((source) => source.includes("pricing"))
        .map(
          (source) =>
            `HIDDEN: ${source}: the Yearly switch above the plans shows the yearly prices`,
        );
  return {
    text: [`NOT FOUND: ${sources.join(", ")}`, ...hidden].join("\n"),
    usage: { input_tokens: 100, output_tokens: 10 },
  };
}

const browser: AskAdapter = {
  name: "browse fixture adapter",
  complete: async (input) => phaseOne(input),
  converse: async (input) => {
    let conversation = conversations.get(input.conversationId);
    if (!conversation) {
      const first = input.messages[0]?.content[0];
      const opening = first?.type === "text" ? first.text : "";
      const route = routes.find((candidate) => candidate.match.test(opening));
      if (!route) throw new Error(`no script for ${opening.slice(0, 200)}`);
      conversation = scriptedAdapter(route.steps);
      conversations.set(input.conversationId, conversation);
    }
    return conversation.converse(input);
  },
};

let fixture: Fixture;
const mcp = useMcpHarness({ name: "browse", secrets: noSecrets, askAdapter: browser });

const call = (name: string, args: ToolArgs = {}, options: { signal?: AbortSignal } = {}) =>
  mcp.call(name, args, { timeout: 600_000, ...options });

async function ok(name: string, args: ToolArgs = {}) {
  const result = await call(name, args);
  expect(result.isError, `${name} failed: ${result.text}`).toBe(false);
  return result.text;
}

const browseTabs = async () =>
  (await ok("tabs"))
    .split("\n")
    .flatMap((line) => (line.includes("/browse/") ? (/^(t\d+) /.exec(line)?.[1] ?? []) : []));

const use = (id: string, name: string, input: AskToolUseBlock["input"]) => ({
  type: "tool_use" as const,
  id,
  name,
  input,
});
const reply = (...content: ConverseReply["content"]): ConverseReply => ({
  content,
  stopReason: "tool_use",
  usage: { input_tokens: 50, output_tokens: 5 },
});

function results(input: ConverseInput) {
  const last = input.messages.at(-1);
  expect(last?.role).toBe("user");
  return (last?.content ?? []).filter(
    (block): block is AskToolResultBlock => block.type === "tool_result",
  );
}

const textOf = (block: AskToolResultBlock | undefined) =>
  (block?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
const lastText = (input: ConverseInput) => textOf(results(input).at(-1));

function refIn(text: string, label: string) {
  const line = text
    .split("\n")
    .find((candidate) => candidate.includes(label) && /\[ref=/.test(candidate));
  const ref = line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
  expect(ref, `no ref for ${label} in:\n${text}`).toMatch(/^[a-z0-9]+$/);
  return ref;
}

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

test("1: a price behind a toggle is found by browsing and cited with the original page", async () => {
  routes = [
    {
      match: /browse\/pricing/,
      steps: [
        (input) => {
          const opening = input.messages[0]?.content[0];
          expect(opening?.type === "text" ? opening.text : "").toMatch(
            /Hint: the Yearly switch above the plans shows the yearly prices/,
          );
          return reply(use("a", "find", { query: "Yearly" }));
        },
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Yearly") })),
        (input) => {
          expect(lastText(input)).toMatch(/Pro 96 € per year/);
          return reply(
            use("c", "report", {
              parts: [
                {
                  part: "the yearly price of Pro",
                  outcome: "answered",
                  lines: ["Pro costs 96 € per year when billed yearly"],
                },
              ],
              how: "switched the Yearly toggle",
            }),
          );
        },
      ],
    },
  ];
  const before = await browseTabs();
  const text = await ok("ask_pages", {
    question: "What does each plan cost per year?",
    urls: [`${fixture.url}/browse/pricing`],
    images: "none",
  });
  expect(text).toMatch(
    /^- \[browsed\] Pro costs 96 € per year when billed yearly \[01-127-0-0-1-\d+-browse-pricing\.md\]$/m,
  );
  expect(text).toMatch(/^Browsed 1 page\(s\):$/m);
  expect(text).toMatch(
    /^01-127-0-0-1-\d+-browse-pricing\.md: found, 3 steps, 2 tool calls \(switched the Yearly toggle\)$/m,
  );
  expect(text).not.toMatch(/Nothing relevant in/);
  const file = /Full answers: (\S+)/.exec(text)?.[1] ?? "";
  const saved = await readFile(file, "utf8");
  expect(saved).toMatch(/## Browsing/);
  const transcript = /^Transcript: (\S+)$/m.exec(saved)?.[1] ?? "";
  expect(existsSync(path.join(transcript, "turns.jsonl")), saved).toBe(true);
  expect(await browseTabs()).toStrictEqual(before);
  expect(browseOrders()).toBe(0);
  expect(prompts.at(-1)?.system ?? "").toMatch(/<interaction>/);
});

test("2: a fact on a same-site sub-page is found, and an off-site link is refused", async () => {
  routes = [
    {
      match: /browse\/product/,
      steps: [
        () =>
          reply(
            use("a", "find", { query: "Partner store" }),
            use("b", "find", { query: "Technical details" }),
          ),
        (input) => {
          const [partner, details] = results(input);
          return reply(
            use("c", "click", { target: refIn(textOf(partner), "Partner store") }),
            use("d", "click", { target: refIn(textOf(details), "Technical details") }),
          );
        },
        (input) => {
          const [partner, details] = results(input);
          expect(textOf(partner)).toMatch(/^Refused: .*localhost/);
          expect(textOf(details)).toMatch(/Navigated to .*\/browse\/product\/specs/);
          return reply(use("e", "read_text", {}));
        },
        (input) => {
          expect(lastText(input)).toMatch(/Weight: 1,2 kg/);
          return reply(
            use("f", "report", {
              parts: [
                {
                  part: "the weight of the Orbit lamp",
                  outcome: "answered",
                  lines: ["The Orbit lamp weighs 1,2 kg on the Technical details page"],
                },
              ],
              how: "followed the Technical details link",
            }),
          );
        },
      ],
    },
  ];
  const text = await ok("ask_pages", {
    question: "How heavy is the lamp?",
    urls: [`${fixture.url}/browse/product`],
    images: "none",
  });
  expect(text).toMatch(
    /^- \[browsed\] The Orbit lamp weighs 1,2 kg on the Technical details page \[01-127-0-0-1-\d+-browse-product\.md\]$/m,
  );
});

test("3: a tab panel's content is read after clicking the tab", async () => {
  routes = [
    {
      match: /browse\/tabs/,
      steps: [
        () => reply(use("a", "find", { query: "Shipping" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Shipping") })),
        (input) => {
          expect(lastText(input)).toMatch(/\+ .*Delivery in 3–5 days/);
          return reply(
            use("c", "report", {
              parts: [
                {
                  part: "the delivery time",
                  outcome: "answered",
                  lines: ["Delivery takes 3–5 days"],
                },
              ],
              how: "opened the Shipping tab",
            }),
          );
        },
      ],
    },
  ];
  const text = await ok("ask_pages", {
    question: "How long is delivery?",
    urls: [`${fixture.url}/browse/tabs`],
    images: "none",
  });
  expect(text).toMatch(
    /^- \[browsed\] Delivery takes 3–5 days \[01-127-0-0-1-\d+-browse-tabs\.md\]$/m,
  );
});

test("4: review mode hovers a card, sends a screenshot and merges the issue", async () => {
  routes = [
    {
      match: /browse\/cards/,
      steps: [
        (input) => {
          const opening = input.messages[0]?.content[0];
          expect(opening?.type === "text" ? opening.text : "").toMatch(
            /Interaction to check: card 2: hover over card 2/,
          );
          return reply(use("a", "find", { query: "Card 2" }));
        },
        (input) => reply(use("b", "hover", { target: refIn(lastText(input), "Card 2") })),
        (input) => {
          expect(lastText(input)).toMatch(/This detail text is much too long/);
          return reply(use("c", "screenshot", { target: "#card-2" }));
        },
        (input) => {
          const [shot] = results(input);
          const image = shot?.content.find((part) => part.type === "image");
          expect(image?.type === "image" && image.image.mediaType).toBe("image/jpeg");
          return reply(
            use("d", "report", {
              status: "found",
              issues: [
                {
                  severity: "high",
                  where: "card 2 details (hover)",
                  issue: "the details text runs out of its panel",
                },
              ],
              how: "hovered card 2",
            }),
          );
        },
      ],
    },
  ];
  const text = await ok("ask_pages", {
    mode: "review",
    question: "Check the product cards",
    urls: [`${fixture.url}/browse/cards`],
    images: "none",
  });
  expect(text).toMatch(
    /^- \[high\] \[browsed\] 01-127-0-0-1-\d+-browse-cards\.md, card 2 details \(hover\): the details text runs out of its panel$/m,
  );
});

test("a review browse that drops a first-pass issue without quoted page text keeps it, marked as disputed", async () => {
  routes = [
    {
      match: /browse\/cards/,
      steps: [
        (input) => {
          const opening = input.messages[0]?.content[0];
          expect(opening?.type === "text" ? opening.text : "").toMatch(
            /Issues found so far:\n1\. \[high\] .*image cards: the first image is broken/,
          );
          return reply(
            use("a", "report", {
              status: "found",
              issues: [],
              dropped: [{ issue: 1, evidence: "the broken images are the page's stated purpose" }],
              how: "hovered card 2",
            }),
          );
        },
      ],
    },
  ];
  const result = await call("ask_pages", {
    mode: "review",
    question: "Check for broken images",
    urls: [`${fixture.url}/browse/cards`],
    images: "none",
  });
  expect([
    /^- \[high\] 01-127-0-0-1-\d+-browse-cards\.md, image cards: the first image is broken \[browse disagreed, without evidence on the page\]$/m.test(
      result.text,
    ),
    result.structured?.noIssues,
  ]).toEqual([true, []]);
});

test("a review browse drops a first-pass issue by quoting the text the page showed after a hover", async () => {
  routes = [
    {
      match: /browse\/cards/,
      steps: [
        () => reply(use("a", "find", { query: "Card 1" })),
        (input) => reply(use("b", "hover", { target: refIn(lastText(input), "Card 1") })),
        (input) => {
          expect(lastText(input)).toMatch(/Light and small/);
          return reply(
            use("c", "report", {
              status: "found",
              issues: [],
              dropped: [{ issue: 1, evidence: "Light and small" }],
              how: "hovered card 1",
            }),
          );
        },
      ],
    },
  ];
  const result = await call("ask_pages", {
    mode: "review",
    question: "Check for empty panels",
    urls: [`${fixture.url}/browse/cards`],
    images: "none",
  });
  expect([
    /^- \[high\] [^\n]*card 1: the details panel is empty/m.test(result.text),
    /^Dropped by browsing:\n\[high\] 01-127-0-0-1-\d+-browse-cards\.md, card 1: the details panel is empty \(the page shows "Light and small"\)$/m.test(
      result.text,
    ),
    result.structured?.noIssues,
  ]).toEqual([false, true, [expect.stringMatching(/browse-cards\.md$/)]]);
});

test("a read-pass count that disagrees with the page is flagged with the count of its list", async () => {
  const text = await ok("ask_pages", {
    question: "How many examples does the page list?",
    urls: [`${fixture.url}/browse/examples`],
    images: "none",
    browse: "off",
  });
  expect(text).toMatch(
    /^- The Welcome page lists 7 examples \[count checked: 6, not 7\] \[01-127-0-0-1-\d+-browse-examples\.md\]$/m,
  );
});

test("a browsed count is checked against the page as browsing left it", async () => {
  routes = [
    {
      match: /browse\/examples/,
      steps: [
        () => reply(use("a", "find", { query: "Show more" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Show more") })),
        () =>
          reply(
            use("c", "report", {
              parts: [
                {
                  part: "how many examples the page lists",
                  outcome: "answered",
                  lines: [
                    'The Welcome page lists 9 examples after Show more {count 9: list items under "Available Examples"}',
                  ],
                },
              ],
              how: "clicked Show more and counted the list",
            }),
          ),
      ],
    },
  ];
  const text = await ok("ask_pages", {
    question: "How many examples does the page list?",
    urls: [`${fixture.url}/browse/examples`],
    images: "none",
  });
  expect(text).toMatch(
    /^- \[browsed\] The Welcome page lists 9 examples after Show more \[count checked: 8, not 9\] \[01-127-0-0-1-\d+-browse-examples\.md\]$/m,
  );
});

test("files with browse all say that their pages were not browsed", async () => {
  const file = path.join(mcp.workDir, "browse-plain.md");
  await writeFile(file, "Plain text page");
  conversations.clear();
  const text = await ok("ask_pages", { question: "What is here?", files: [file], browse: "all" });
  expect([/^browse applies to pages with a URL or a tab/m.test(text), conversations.size]).toEqual([
    true,
    0,
  ]);
});

test("files without an explicit browse choice add no browse note", async () => {
  const file = path.join(mcp.workDir, "browse-plain.md");
  await writeFile(file, "Plain text page");
  const text = await ok("ask_pages", { question: "What is here?", files: [file] });
  expect(text).not.toMatch(/^browse applies to/m);
});

test("5: buying, downloading, signing in, leaving the site and Enter in a password field are refused, and a confirm dialog is dismissed", async () => {
  let seen: AskToolResultBlock[] = [];
  routes = [
    {
      match: /browse\/danger/,
      steps: [
        () => reply(use("a", "snapshot", { interactive: true })),
        (input) => {
          const snapshot = lastText(input);
          return reply(
            use("b", "click", { target: refIn(snapshot, "Buy now") }),
            use("c", "click", { target: refIn(snapshot, "Download report") }),
            use("d", "search", { target: refIn(snapshot, "Email"), text: "me@example.com" }),
            use("e", "navigate", { url: "https://example.org/" }),
            use("f", "press", { key: "Enter", target: refIn(snapshot, "Password") }),
            use("g", "click", { target: refIn(snapshot, "Sign in") }),
            use("h", "click", { target: refIn(snapshot, "Delete account") }),
            use("i", "click", { target: refIn(snapshot, "Partner site") }),
            use("j", "click", { target: refIn(snapshot, "Sign out everywhere") }),
            use("k", "click", { target: refIn(snapshot, "Partner map") }),
            use("l", "click", { target: refIn(snapshot, "Show details") }),
          );
        },
        (input) => {
          seen = results(input);
          return reply(
            use("m", "report", {
              parts: [{ part: "what the account page offers", outcome: "not_found", lines: [] }],
              how: "tried the controls",
            }),
          );
        },
      ],
    },
  ];
  const text = await ok("ask_pages", {
    question: "What does the account page offer?",
    urls: [`${fixture.url}/browse/danger`],
    images: "none",
  });
  expect(seen.length).toBe(11);
  for (const refused of seen.slice(0, 10)) expect(textOf(refused)).toMatch(/^Refused: /);
  expect(textOf(seen[8])).toMatch(/checkout, cart, account or sign-in path/);
  expect(textOf(seen[9])).toMatch(/outside this site/);
  expect(textOf(seen[10])).toMatch(/confirm dialog "Proceed\?" was dismissed/);
  expect(text).toMatch(/: not_found, 3 steps, 12 tool calls/);
  await sleep(300);
  expect(browseOrders()).toBe(0);
  expect(browseDownloads()).toBe(0);
});

test("6: with tabs the loop works in the caller's tab, leaves it open with its flags cleared and closes the popup", async () => {
  const tab =
    /Opened (t\d+)/.exec(await ok("navigate", { url: `${fixture.url}/browse/danger` }))?.[1] ?? "";
  let note = "";
  let popup = "";
  let closed = "";
  routes = [
    {
      match: new RegExp(`tab="${tab}"`),
      steps: [
        () => reply(use("a", "find", { query: "Open specs in a new tab" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Open specs") })),
        (input) => {
          const last = input.messages.at(-1);
          note =
            last?.role === "user"
              ? last.content
                  .flatMap((block) => (block.type === "text" ? [block.text] : []))
                  .join("\n")
              : "";
          popup = /New tab (t\d+)/.exec(note)?.[1] ?? "";
          return reply(use("c", "read_text", { tab: popup }));
        },
        (input) => {
          expect(lastText(input)).toMatch(/Weight: 1,2 kg/);
          return reply(use("d", "close_tab", { tab: popup }));
        },
        (input) => {
          closed = lastText(input);
          return reply(
            use("e", "report", {
              parts: [{ part: "what the account page offers", outcome: "not_found", lines: [] }],
              how: "opened the specs",
            }),
          );
        },
      ],
    },
  ];
  const before = await browseTabs();
  await ok("ask_pages", {
    question: "What does the account page offer?",
    tabs: [tab],
    images: "none",
  });
  expect(note).toMatch(/New tab t\d+ opened from /);
  expect(closed).toBe(`Closed ${popup}.`);
  expect(await browseTabs()).toStrictEqual(before);
  const orders = browseOrders();
  const snapshot = await ok("snapshot", { tab, query: "Show details" });
  const clicked = await ok("click", { tab, target: refIn(snapshot, "Show details") });
  expect(clicked).toMatch(/A confirm dialog is open: "Proceed\?"/);
  await ok("dialog", { tab, action: "accept" });
  await sleep(300);
  expect(browseOrders()).toBe(orders + 1);
  await ok("tabs", { close: [tab] });
});

function yearlyToggleRoute(match: RegExp) {
  routes = [
    {
      match,
      steps: [
        () => reply(use("a", "find", { query: "Yearly" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Yearly") })),
        () =>
          reply(
            use("c", "report", {
              parts: [
                {
                  part: "the yearly price of Pro",
                  outcome: "answered",
                  lines: ["Pro costs 96 € per year when billed yearly"],
                },
              ],
              how: "switched the Yearly toggle",
            }),
          ),
      ],
    },
  ];
}

const pricingTab = async () =>
  /Opened (t\d+)/.exec(await ok("navigate", { url: `${fixture.url}/browse/pricing` }))?.[1] ?? "";

async function browseCallerTab() {
  const tab = await pricingTab();
  yearlyToggleRoute(new RegExp(`tab="${tab}"`));
  const result = await call("ask_pages", {
    question: "What does each plan cost per year?",
    tabs: [tab],
    images: "none",
  });
  await ok("tabs", { close: [tab] });
  return { tab, result };
}

const userTabBehind = async (agentTab: string) => {
  const context = mcp.deps.manager.getTab(agentTab).page.context();
  const user = await context.newPage();
  await user.goto(`${fixture.url}/article`);
  await user.bringToFront();
  return user;
};

const tabBroughtToFront = async () => {
  const id = /Opened (t\d+)/.exec(await ok("navigate", { url: `${fixture.url}/article` }))?.[1];
  const page = mcp.deps.manager.getTab(id ?? "").page;
  await page.bringToFront();
  return page;
};

test("6f: closing the caller's tab browsing clicked in while another tab is in front leaves that tab in front", async () => {
  const tab = await pricingTab();
  const user = await userTabBehind(tab);
  const front = await tabBroughtToFront();
  yearlyToggleRoute(new RegExp(`tab="${tab}"`));
  await ok("ask_pages", {
    question: "What does each plan cost per year?",
    tabs: [tab],
    images: "none",
  });
  await ok("tabs", { close: [tab] });
  const kept = await holdsFocus(front);
  await front.close();
  await user.close();
  expect(kept).toBe(true);
});

test("6g: closing the tab browsing opened for a page while another tab is in front leaves that tab in front", async () => {
  const opener = await pricingTab();
  const user = await userTabBehind(opener);
  const front = await tabBroughtToFront();
  yearlyToggleRoute(/browse\/pricing/);
  conversations.clear();
  await ok("ask_pages", {
    question: "What does each plan cost per year?",
    urls: [`${fixture.url}/browse/pricing`],
    images: "none",
  });
  const kept = await holdsFocus(front);
  await front.close();
  await user.close();
  await ok("tabs", { close: [opener] });
  expect(kept).toBe(true);
});

test("6b: with tabs the result says browsing used the caller's tab and what it shows now", async () => {
  const { tab, result } = await browseCallerTab();
  expect(result.text).toContain(
    `Browsing used tab ${tab} itself, which stays where browsing left it: it now shows ${fixture.url}/browse/pricing "Browse Pricing", and controls on it may have changed (for example a toggle switched).`,
  );
});

test("6c: with tabs the structured browsed entry names the caller's tab it used", async () => {
  const { tab, result } = await browseCallerTab();
  expect(result.structured?.browsed).toMatchObject([{ tab }]);
});

test("6d: the structured browsed entry carries the browse summary", async () => {
  const { result } = await browseCallerTab();
  expect(result.structured?.browsed).toMatchObject([{ summary: "switched the Yearly toggle" }]);
});

test("6e: the structured result names the used-tab note once, in the notes field", async () => {
  const { result } = await browseCallerTab();
  expect(JSON.stringify(result.structured).split("Browsing used tab")).toHaveLength(2);
});

test("7: cancelling mid-loop ends the call and closes the loop's tabs", async () => {
  let started = false;
  routes = [
    {
      match: /browse\/tabs/,
      steps: [
        (input) =>
          new Promise<ConverseReply>((resolve) => {
            started = true;
            const alive = setTimeout(
              () => resolve(reply(use("a", "find", { query: "x" }))),
              60_000,
            );
            input.signal.addEventListener("abort", () => clearTimeout(alive), { once: true });
          }),
      ],
    },
  ];
  conversations.clear();
  const before = await browseTabs();
  const controller = new AbortController();
  const pending = call(
    "ask_pages",
    { question: "How long is delivery?", urls: [`${fixture.url}/browse/tabs`], images: "none" },
    { signal: controller.signal },
  );
  await repeatUntil(async () => (started ? true : undefined), {
    delayMs: () => 50,
    giveUp: (made) => made >= 600,
  });
  expect(started).toBe(true);
  controller.abort();
  await expect(pending).rejects.toThrow();
  const after = await repeatUntil(
    async (attempt) => {
      const tabs = await browseTabs();
      return tabs.length > before.length && attempt < 50 ? undefined : tabs;
    },
    { delayMs: () => 100 },
  );
  expect(after).toStrictEqual(before);
});

test("8: an adapter without converse skips browsing with a note", async () => {
  const saved = mcp.deps.ask;
  mcp.deps.ask = new AskAdapterSource({
    adapter: { name: "plain adapter", complete: async (input) => phaseOne(input) },
  });
  try {
    const text = await ok("ask_pages", {
      question: "What does each plan cost per year?",
      urls: [`${fixture.url}/browse/pricing`],
      images: "none",
    });
    expect(text).toMatch(
      /^Browsing skipped: the adapter plain adapter does not support tool use \(no converse\(\)\)\.$/m,
    );
    expect(text).toMatch(/^Nothing relevant in: 01-/m);
    expect(text).not.toMatch(/HIDDEN/);
    expect(prompts.at(-1)?.system.includes("<interaction>")).toBe(false);
  } finally {
    mcp.deps.ask = saved;
  }
});

const logEntry = z.object({
  event: z.string().optional(),
  tool: z.string().optional(),
  requestId: z.string().optional(),
  parent: z.string().optional(),
});

test("9: the server log links the browsing tool calls to the ask_pages request", async () => {
  await mcp.deps.log.flush();
  const files = (await readdir(mcp.deps.log.dir)).filter((name) => name.endsWith(".jsonl"));
  const entries = (
    await Promise.all(files.map((name) => readFile(path.join(mcp.deps.log.dir, name), "utf8")))
  )
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => parseJsonOrThrow(line, logEntry));
  const asks = new Set(
    entries
      .filter((entry) => entry.event === "tool_call" && entry.tool === "ask_pages")
      .map((entry) => entry.requestId),
  );
  const end = entries.find(
    (entry) => entry.event === "browse_page_end" && asks.has(entry.requestId),
  );
  expect(end, "no browse_page_end for an ask_pages request").toBeDefined();
  expect(
    entries
      .filter((entry) => entry.event === "tool_call" && entry.parent === end?.requestId)
      .map((entry) => entry.tool),
  ).toContain("click");
  expect(entries.map((entry) => entry.event)).toContain("browse_blocked");
});

const RECORDINGS = [
  { name: "browse-pricing", question: "What does each plan cost per year?", answer: /96 €/ },
  { name: "browse-product", question: "How heavy is the lamp?", answer: /1,2 kg/ },
  { name: "browse-tabs", question: "How long is delivery?", answer: /Delivery in 3–5 days/ },
];

for (const recording of RECORDINGS)
  test(`10: the recorded real run ${recording.name} replays against the fixture`, async () => {
    const replay = await replayAdapter(
      path.join(import.meta.dirname, "recordings", recording.name),
    );
    const saved = mcp.deps.ask;
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "replay",
        complete: async (input) => phaseOne(input),
        converse: (input) => replay.converse(input),
      },
    });
    try {
      const text = await ok("ask_pages", {
        question: recording.question,
        urls: [`${fixture.url}/${recording.name.replace("-", "/")}`],
        images: "none",
      });
      expect(text).toMatch(recording.answer);
    } finally {
      mcp.deps.ask = saved;
    }
  });

test("10: clicking an unlabeled meter is checked and carried out", async () => {
  let clicked = "";
  routes = [
    {
      match: /browse\/meter/,
      steps: [
        () => reply(use("a", "click", { target: "#level" })),
        (input) => {
          clicked = lastText(input);
          return reply(
            use("b", "report", {
              parts: [
                {
                  part: "how full the battery is",
                  outcome: "answered",
                  lines: ["The battery is half full"],
                },
              ],
              how: "clicked the meter",
            }),
          );
        },
      ],
    },
  ];
  await ok("ask_pages", {
    question: "How full is the battery?",
    urls: [`${fixture.url}/browse/meter`],
    images: "none",
  });
  expect(clicked).toMatch(/^Clicked meter \((?:f\d+)?e\d+, from #level\)/);
});

test("11: the structured result reports each browsed page with its outcome, steps and tool call count", async () => {
  routes = [
    {
      match: /browse\/meter/,
      steps: [
        () => reply(use("a", "click", { target: "#level" })),
        () =>
          reply(
            use("b", "report", {
              parts: [
                {
                  part: "how full the battery is",
                  outcome: "answered",
                  lines: ["The battery is half full"],
                },
              ],
              how: "clicked the meter",
            }),
          ),
      ],
    },
  ];
  const result = await call("ask_pages", {
    question: "How full is the battery?",
    urls: [`${fixture.url}/browse/meter`],
    images: "none",
  });
  expect(result.structured?.browsed).toMatchObject([
    {
      source: expect.stringMatching(/browse-meter\.md$/),
      outcome: "found",
      steps: 2,
      toolCalls: 1,
    },
  ]);
});

test("the structured result lists a page whose browse found part of the answer as partly answered", async () => {
  routes = [
    {
      match: /browse\/meter/,
      steps: [
        () =>
          reply(
            use("a", "report", {
              parts: [
                {
                  part: "how full the battery is",
                  outcome: "answered",
                  lines: ["The battery meter is labelled Level"],
                },
                { part: "when it was charged", outcome: "not_found", lines: [] },
              ],
              how: "read the meter label",
            }),
          ),
      ],
    },
  ];
  const result = await call("ask_pages", {
    question: "How full is the battery and when was it charged?",
    urls: [`${fixture.url}/browse/meter`],
    images: "none",
  });
  expect(result.structured?.partlyAnswered).toEqual([expect.stringMatching(/browse-meter\.md$/)]);
});
