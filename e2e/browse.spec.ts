import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
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
  if (review)
    return {
      text: sources
        .map(
          (source) =>
            `NEEDS INTERACTION: ${source}, card 2: hover over card 2 and check its details panel`,
        )
        .join("\n"),
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  const hidden = !input.system.includes("<interaction>")
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
  (await ok("tabs_list"))
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
              status: "found",
              lines: ["Pro costs 96 € per year when billed yearly"],
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
    /^- Pro costs 96 € per year when billed yearly \[01-127-0-0-1-\d+-browse-pricing\.md\]$/m,
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
              status: "found",
              lines: ["The Orbit lamp weighs 1,2 kg on the Technical details page"],
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
    /^- The Orbit lamp weighs 1,2 kg on the Technical details page \[01-127-0-0-1-\d+-browse-product\.md\]$/m,
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
              status: "found",
              lines: ["Delivery takes 3–5 days"],
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
  expect(text).toMatch(/^- Delivery takes 3–5 days \[01-127-0-0-1-\d+-browse-tabs\.md\]$/m);
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
    /^- \[high\] 01-127-0-0-1-\d+-browse-cards\.md, card 2 details \(hover\): the details text runs out of its panel$/m,
  );
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
            use("m", "report", { status: "not_found", lines: [], how: "tried the controls" }),
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
    /Opened (t\d+)/.exec(await ok("tab_open", { url: `${fixture.url}/browse/danger` }))?.[1] ?? "";
  let note = "";
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
          const popup = /New tab (t\d+)/.exec(note)?.[1] ?? "";
          return reply(use("c", "read_text", { tab: popup }));
        },
        (input) => {
          expect(lastText(input)).toMatch(/Weight: 1,2 kg/);
          return reply(
            use("d", "report", { status: "not_found", lines: [], how: "opened the specs" }),
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
  expect(await browseTabs()).toStrictEqual(before);
  const orders = browseOrders();
  const snapshot = await ok("find", { tab, query: "Show details" });
  const clicked = await ok("click", { tab, target: refIn(snapshot, "Show details") });
  expect(clicked).toMatch(/confirm dialog "Proceed\?" was accepted automatically/);
  await sleep(300);
  expect(browseOrders()).toBe(orders + 1);
  await ok("tab_close", { tab });
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
              status: "found",
              lines: ["The battery is half full"],
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
  expect(clicked).toMatch(/^Clicked #level/);
});
