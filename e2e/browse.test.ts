import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AskAdapter, AskInput, AskToolResultBlock, ConverseInput, ConverseReply } from "../src/ask-adapter.ts";
import { AskAdapterSource } from "../src/ask.ts";
import { scriptedAdapter, type ScriptedAdapter, type ScriptStep } from "../src/ask-script.ts";
import { replayAdapter } from "../src/browse-capture.ts";
import { loadConfig } from "../src/config.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { browseDownloads, browseOrders, startFixture, type Fixture } from "./fixture.ts";

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };

type Route = { match: RegExp; steps: ScriptStep[] };
let routes: Route[] = [];
const conversations = new Map<string, ScriptedAdapter>();
const prompts: AskInput[] = [];

function phaseOne(input: AskInput) {
  prompts.push(input);
  const sources = [...input.prompt.matchAll(/<document source="([^"]+)">/g)].map((match) => match[1] ?? "");
  const review = input.system.includes("visual and layout problems");
  if (review) return { text: sources.map((source) => `NEEDS INTERACTION: ${source}, card 2: hover over card 2 and check its details panel`).join("\n"), usage: { input_tokens: 100, output_tokens: 10 } };
  const hidden = !input.system.includes("<interaction>") ? [] : sources.filter((source) => source.includes("pricing")).map((source) => `HIDDEN: ${source}: the Yearly switch above the plans shows the yearly prices`);
  return { text: [`NOT FOUND: ${sources.join(", ")}`, ...hidden].join("\n"), usage: { input_tokens: 100, output_tokens: 10 } };
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
let workDir: string;
let deps: ToolDeps;
let client: Client;

type CallResult = { text: string; isError: boolean };

async function call(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, ...options });
  const content = result.content as { type: string; text?: string }[];
  return { text: content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"), isError: result.isError === true };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const result = await call(name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

const browseTabs = async () => (await ok("tabs_list")).split("\n").flatMap((line) => (line.includes("/browse/") ? (/^(t\d+) /.exec(line)?.[1] ?? []) : []));

const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
const reply = (...content: ConverseReply["content"]): ConverseReply => ({ content, stopReason: "tool_use", usage: { input_tokens: 50, output_tokens: 5 } });

function results(input: ConverseInput) {
  const last = input.messages.at(-1);
  assert.equal(last?.role, "user");
  return (last?.content ?? []).filter((block): block is AskToolResultBlock => block.type === "tool_result");
}

const textOf = (block: AskToolResultBlock | undefined) => (block?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
const lastText = (input: ConverseInput) => textOf(results(input).at(-1));

function refIn(text: string, label: string) {
  const line = text.split("\n").find((candidate) => candidate.includes(label) && /\[ref=/.test(candidate));
  const ref = line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
  assert.ok(ref, `no ref for ${label} in:\n${text}`);
  return ref;
}

before(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-"));
  const config = loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, noSecrets, browser);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e-browse", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("1: a price behind a toggle is found by browsing and cited with the original page", async () => {
  routes = [
    {
      match: /browse\/pricing/,
      steps: [
        (input) => {
          const opening = input.messages[0]?.content[0];
          assert.match(opening?.type === "text" ? opening.text : "", /Hint: the Yearly switch above the plans shows the yearly prices/);
          return reply(use("a", "find", { query: "Yearly" }));
        },
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Yearly") })),
        (input) => {
          assert.match(lastText(input), /Pro 96 € per year/);
          return reply(use("c", "report", { status: "found", lines: ["Pro costs 96 € per year when billed yearly"], how: "switched the Yearly toggle" }));
        },
      ],
    },
  ];
  const before = await browseTabs();
  const text = await ok("ask_pages", { question: "What does each plan cost per year?", urls: [`${fixture.url}/browse/pricing`], images: "none" });
  assert.match(text, /^- Pro costs 96 € per year when billed yearly \[01-127-0-0-1-\d+-browse-pricing\.md\]$/m);
  assert.match(text, /^Browsed 1 page\(s\):$/m);
  assert.match(text, /^01-127-0-0-1-\d+-browse-pricing\.md: found, 3 steps, 2 tool calls \(switched the Yearly toggle\)$/m);
  assert.doesNotMatch(text, /Nothing relevant in/);
  const file = /Full answers: (\S+)/.exec(text)?.[1] ?? "";
  const saved = await readFile(file, "utf8");
  assert.match(saved, /## Browsing/);
  const transcript = /^Transcript: (\S+)$/m.exec(saved)?.[1] ?? "";
  assert.ok(existsSync(path.join(transcript, "turns.jsonl")), saved);
  assert.deepEqual(await browseTabs(), before);
  assert.equal(browseOrders(), 0);
  assert.match(prompts.at(-1)?.system ?? "", /<interaction>/);
});

test("2: a fact on a same-site sub-page is found, and an off-site link is refused", async () => {
  routes = [
    {
      match: /browse\/product/,
      steps: [
        () => reply(use("a", "find", { query: "Partner store" }), use("b", "find", { query: "Technical details" })),
        (input) => {
          const [partner, details] = results(input);
          return reply(use("c", "click", { target: refIn(textOf(partner), "Partner store") }), use("d", "click", { target: refIn(textOf(details), "Technical details") }));
        },
        (input) => {
          const [partner, details] = results(input);
          assert.match(textOf(partner), /^Refused: .*localhost/);
          assert.match(textOf(details), /Navigated to .*\/browse\/product\/specs/);
          return reply(use("e", "read_text", {}));
        },
        (input) => {
          assert.match(lastText(input), /Weight: 1,2 kg/);
          return reply(use("f", "report", { status: "found", lines: ["The Orbit lamp weighs 1,2 kg on the Technical details page"], how: "followed the Technical details link" }));
        },
      ],
    },
  ];
  const text = await ok("ask_pages", { question: "How heavy is the lamp?", urls: [`${fixture.url}/browse/product`], images: "none" });
  assert.match(text, /^- The Orbit lamp weighs 1,2 kg on the Technical details page \[01-127-0-0-1-\d+-browse-product\.md\]$/m);
});

test("3: a tab panel's content is read after clicking the tab", async () => {
  routes = [
    {
      match: /browse\/tabs/,
      steps: [
        () => reply(use("a", "find", { query: "Shipping" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Shipping") })),
        (input) => {
          assert.match(lastText(input), /\+ .*Delivery in 3–5 days/);
          return reply(use("c", "report", { status: "found", lines: ["Delivery takes 3–5 days"], how: "opened the Shipping tab" }));
        },
      ],
    },
  ];
  const text = await ok("ask_pages", { question: "How long is delivery?", urls: [`${fixture.url}/browse/tabs`], images: "none" });
  assert.match(text, /^- Delivery takes 3–5 days \[01-127-0-0-1-\d+-browse-tabs\.md\]$/m);
});

test("4: review mode hovers a card, sends a screenshot and merges the issue", async () => {
  routes = [
    {
      match: /browse\/cards/,
      steps: [
        (input) => {
          const opening = input.messages[0]?.content[0];
          assert.match(opening?.type === "text" ? opening.text : "", /Interaction to check: card 2: hover over card 2/);
          return reply(use("a", "find", { query: "Card 2" }));
        },
        (input) => reply(use("b", "hover", { target: refIn(lastText(input), "Card 2") })),
        (input) => {
          assert.match(lastText(input), /This detail text is much too long/);
          return reply(use("c", "screenshot", { target: "#card-2" }));
        },
        (input) => {
          const [shot] = results(input);
          const image = shot?.content.find((part) => part.type === "image");
          assert.equal(image?.type === "image" && image.image.mediaType, "image/jpeg");
          return reply(use("d", "report", { status: "found", issues: [{ severity: "high", where: "card 2 details (hover)", issue: "the details text runs out of its panel" }], how: "hovered card 2" }));
        },
      ],
    },
  ];
  const text = await ok("ask_pages", { mode: "review", question: "Check the product cards", urls: [`${fixture.url}/browse/cards`], images: "none" });
  assert.match(text, /^- \[high\] 01-127-0-0-1-\d+-browse-cards\.md, card 2 details \(hover\): the details text runs out of its panel$/m);
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
            use("j", "click", { target: refIn(snapshot, "Show details") }),
          );
        },
        (input) => {
          seen = results(input);
          return reply(use("k", "report", { status: "not_found", lines: [], how: "tried the controls" }));
        },
      ],
    },
  ];
  const text = await ok("ask_pages", { question: "What does the account page offer?", urls: [`${fixture.url}/browse/danger`], images: "none" });
  assert.equal(seen.length, 9);
  for (const refused of seen.slice(0, 8)) assert.match(textOf(refused), /^Refused: /, textOf(refused));
  assert.match(textOf(seen[8]), /confirm dialog "Proceed\?" was dismissed/);
  assert.match(text, /: not_found, 3 steps, 10 tool calls/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(browseOrders(), 0);
  assert.equal(browseDownloads(), 0);
});

test("6: with tabs the loop works in the caller's tab, leaves it open with its flags cleared and closes the popup", async () => {
  const tab = /Opened (t\d+)/.exec(await ok("tab_open", { url: `${fixture.url}/browse/danger` }))?.[1] ?? "";
  let note = "";
  routes = [
    {
      match: new RegExp(`tab="${tab}"`),
      steps: [
        () => reply(use("a", "find", { query: "Open specs in a new tab" })),
        (input) => reply(use("b", "click", { target: refIn(lastText(input), "Open specs") })),
        (input) => {
          const last = input.messages.at(-1);
          note = last?.role === "user" ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") : "";
          const popup = /New tab (t\d+)/.exec(note)?.[1] ?? "";
          return reply(use("c", "read_text", { tab: popup }));
        },
        (input) => {
          assert.match(lastText(input), /Weight: 1,2 kg/);
          return reply(use("d", "report", { status: "not_found", lines: [], how: "opened the specs" }));
        },
      ],
    },
  ];
  const before = await browseTabs();
  await ok("ask_pages", { question: "What does the account page offer?", tabs: [tab], images: "none" });
  assert.match(note, /New tab t\d+ opened from /);
  assert.deepEqual(await browseTabs(), before);
  const orders = browseOrders();
  const snapshot = await ok("find", { tab, query: "Show details" });
  const clicked = await ok("click", { tab, target: refIn(snapshot, "Show details") });
  assert.match(clicked, /confirm dialog "Proceed\?" was accepted automatically/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(browseOrders(), orders + 1);
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
            const alive = setTimeout(() => resolve(reply(use("a", "find", { query: "x" }))), 60_000);
            input.signal.addEventListener("abort", () => clearTimeout(alive), { once: true });
          }),
      ],
    },
  ];
  conversations.clear();
  const before = await browseTabs();
  const controller = new AbortController();
  const pending = call("ask_pages", { question: "How long is delivery?", urls: [`${fixture.url}/browse/tabs`], images: "none" }, { signal: controller.signal });
  for (let waited = 0; !started && waited < 30_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(started, true);
  controller.abort();
  await assert.rejects(pending);
  let after = await browseTabs();
  for (let waited = 0; after.length > before.length && waited < 5000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await browseTabs();
  }
  assert.deepEqual(after, before);
});

test("8: an adapter without converse skips browsing with a note", async () => {
  const saved = deps.ask;
  deps.ask = new AskAdapterSource({ adapter: { name: "plain adapter", complete: async (input) => phaseOne(input) } });
  try {
    const text = await ok("ask_pages", { question: "What does each plan cost per year?", urls: [`${fixture.url}/browse/pricing`], images: "none" });
    assert.match(text, /^Browsing skipped: the adapter plain adapter does not support tool use \(no converse\(\)\)\.$/m);
    assert.match(text, /^Nothing relevant in: 01-/m);
    assert.doesNotMatch(text, /HIDDEN/);
    assert.equal(prompts.at(-1)?.system.includes("<interaction>"), false);
  } finally {
    deps.ask = saved;
  }
});

test("9: the server log links the browsing tool calls to the ask_pages request", async () => {
  await deps.log.flush();
  const files = (await readdir(deps.log.dir)).filter((name) => name.endsWith(".jsonl"));
  const entries = (await Promise.all(files.map((name) => readFile(path.join(deps.log.dir, name), "utf8"))))
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const asks = entries.filter((entry) => entry.event === "tool_call" && entry.tool === "ask_pages").map((entry) => entry.requestId);
  const end = entries.find((entry) => entry.event === "browse_page_end" && asks.includes(entry.requestId));
  assert.ok(end, "no browse_page_end for an ask_pages request");
  assert.ok(entries.some((entry) => entry.event === "tool_call" && entry.parent === end.requestId && entry.tool === "click"));
  assert.ok(entries.some((entry) => entry.event === "browse_blocked"));
});

const RECORDING = path.join(import.meta.dirname, "recordings", "browse-pricing");

test("10: a recorded real run replays against the fixture", { skip: existsSync(RECORDING) ? false : "no recording in e2e/recordings/browse-pricing" }, async () => {
  const replay = await replayAdapter(RECORDING);
  const saved = deps.ask;
  deps.ask = new AskAdapterSource({ adapter: { name: "replay", complete: async (input) => phaseOne(input), converse: (input) => replay.converse(input) } });
  try {
    const text = await ok("ask_pages", { question: "What does each plan cost per year?", urls: [`${fixture.url}/browse/pricing`], images: "none" });
    assert.match(text, /96 €/);
  } finally {
    deps.ask = saved;
  }
});
