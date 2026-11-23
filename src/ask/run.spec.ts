import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
  askPages,
  exceedsContextWindow,
  clipDocument,
  packBatches,
  IMAGE_CHARS,
  sourceNames,
} from "./run.ts";
import type { AskDocument } from "./types.ts";
import { AskSetupError } from "./errors.ts";
import { createExampleGateway } from "../../tests/unitExampleGateway.ts";
import { type AskAdapter, modelId } from "./adapter.ts";
import { ASK_BROWSE_NOTE, ASK_SYSTEM, REVIEW_BROWSE_NOTE, REVIEW_SYSTEM } from "./prompt.ts";
import { loadAdapterModule } from "./adapter-source.ts";
import { parseEscalations } from "./reply.ts";
import { renderAskResults, renderAskStats } from "./render.ts";
import { image, token } from "../../tests/askFixtures.ts";
import { sleep } from "../shared/async.ts";

const gateway = createExampleGateway();

beforeAll(() => gateway.listen());
afterEach(() => gateway.reset());
afterAll(() => gateway.close());

const doc = (source: string, size: number) => ({ source, text: "x".repeat(size) });

const sizes = (batches: { source: string }[][]) =>
  batches.map((batch) => batch.map((entry) => entry.source).join(""));

test("packBatches packs greedily by characters and page count", () => {
  expect(
    sizes(packBatches([doc("a", 40), doc("b", 40), doc("c", 40), doc("d", 10)], 100, 20)),
  ).toStrictEqual(["ab", "cd"]);
  expect(sizes(packBatches([doc("a", 500), doc("b", 10), doc("c", 10)], 100, 20))).toStrictEqual([
    "a",
    "bc",
  ]);
  expect(sizes(packBatches([doc("a", 1), doc("b", 1), doc("c", 1)], 100, 2))).toStrictEqual([
    "ab",
    "c",
  ]);
  expect(packBatches([], 100, 2)).toStrictEqual([]);
});

test("clipDocument keeps head and tail of long pages", () => {
  const text = Array.from({ length: 200 }, (_value, index) => `line ${index}`).join("\n");
  const clipped = clipDocument({ source: "a.md", text }, 300);
  expect(clipped.text.length).toBeLessThan(400);
  expect(clipped.text).toMatch(/^line 0\n/);
  expect(clipped.text).toMatch(/line 199$/);
  expect(clipDocument({ source: "b.md", text: "short" }, 300).text).toBe("short");
});

test("askPages runs batches concurrently through the adapter and merges the results", async () => {
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const adapter: AskAdapter = {
    name: "fake",
    complete: async ({ prompt, model, maxTokens, signal }) => {
      expect(model).toBe("haiku");
      expect(maxTokens).toBe(4000);
      expect(signal.aborted).toBe(false);
      running += 1;
      peak = Math.max(peak, running);
      await sleep(20);
      running -= 1;
      const sources = [...prompt.matchAll(/source="([^"]+)"/g)].map((match) => match[1] ?? "");
      calls.push(sources.join(","));
      if (sources.includes("bad.md")) throw new Error("rate limited");
      return {
        text:
          sources
            .map((source) => (source.startsWith("hit") ? `- found it [${source}]` : ""))
            .join("\n") +
          `\nNOT FOUND: ${sources.filter((source) => !source.startsWith("hit")).join(", ")}`,
        usage: { input_tokens: 100, output_tokens: 10, cost_usd: 0.001 },
      };
    },
  };
  const report = await askPages(adapter, {
    question: "Where?",
    documents: [
      doc("hit1.md", 50),
      doc("miss1.md", 50),
      doc("bad.md", 50),
      doc("hit2.md", 50),
      doc("miss2.md", 50),
    ],
    batchChars: 100,
    maxPagesPerBatch: 20,
    maxCharsPerPage: 1000,
    concurrency: 2,
    model: "haiku",
    maxTokens: 4000,
    timeoutMs: 5000,
  });
  expect(report.batches.length).toBe(3);
  expect(peak).toBe(2);
  expect(calls.toSorted()).toStrictEqual(["bad.md,hit2.md", "hit1.md,miss1.md", "miss2.md"]);
  const text = renderAskResults("Where?", report);
  expect(text).toMatch(/^- found it \[hit1\.md\]$/m);
  expect(text).not.toContain("[hit2.md]");
  expect(text).toMatch(/Nothing relevant in: miss1\.md, miss2\.md/);
  expect(text).toMatch(/call 2 \[bad\.md, hit2\.md\]: rate limited/);
  const stats = renderAskStats(report, "fake", "haiku");
  expect(stats).toMatch(/Adapter: fake, model haiku, 3 call\(s\)/);
  expect(stats).toMatch(/input tokens 200, output tokens 20, cost usd \$0\.0020/);
});

test("askPages reports a timed out call", async () => {
  const keepAlive = setTimeout(() => undefined, 2000);
  const adapter: AskAdapter = {
    name: "slow",
    complete: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  };
  const {
    batches: [result],
  } = await askPages(adapter, {
    question: "q",
    documents: [doc("a.md", 10)],
    batchChars: 100,
    maxPagesPerBatch: 5,
    maxCharsPerPage: 100,
    concurrency: 1,
    model: "haiku",
    maxTokens: 100,
    timeoutMs: 50,
  });
  clearTimeout(keepAlive);
  expect(result?.error).toBe("no answer within 50 ms");
});

const askOptions = (
  documents: AskDocument[],
  overrides: Partial<Parameters<typeof askPages>[1]> = {},
) => ({
  question: "What is listed?",
  documents,
  batchChars: 100_000,
  maxPagesPerBatch: 20,
  maxCharsPerPage: 10_000,
  concurrency: 2,
  model: "haiku",
  maxTokens: 100,
  timeoutMs: 5000,
  ...overrides,
});

const promptSources = (prompt: string) =>
  [...prompt.matchAll(/source="([^"]+)"/g)].map((match) => match[1] ?? "");

function recordingAdapter(
  reply: (sources: string[], prompt: string) => string = (sources) =>
    `NOT FOUND: ${sources.join(", ")}`,
) {
  const sent: string[][] = [];
  const adapter: AskAdapter = {
    name: "recording",
    complete: async ({ prompt }) => {
      const sources = promptSources(prompt);
      sent.push(sources);
      return { text: reply(sources, prompt) };
    },
  };
  return { adapter, sent };
}

test("askPages does not send pages that are empty after trimming", async () => {
  const empty = `${token()}.md`;
  const { adapter, sent } = recordingAdapter();
  await askPages(
    adapter,
    askOptions([doc(`${token()}.md`, 20), { source: empty, text: " \n\t " }]),
  );
  expect(sent.flat()).not.toContain(empty);
});

test("renderAskResults lists empty pages as empty", async () => {
  const empty = `${token()}.md`;
  const { adapter } = recordingAdapter();
  const report = await askPages(
    adapter,
    askOptions([doc(`${token()}.md`, 20), { source: empty, text: "" }]),
  );
  expect(renderAskResults("q", report)).toMatch(
    new RegExp(`^Empty pages \\(not sent\\): ${empty.replace(/\./g, "\\.")}$`, "m"),
  );
});

test("renderAskResults notes which pages were clipped", async () => {
  const long = `${token()}.md`;
  const size = 3000 + Math.floor(Math.random() * 1000);
  const { adapter } = recordingAdapter();
  const report = await askPages(
    adapter,
    askOptions([doc(`${token()}.md`, 50), { source: long, text: "x".repeat(size) }], {
      maxCharsPerPage: 1000,
    }),
  );
  expect(renderAskResults("q", report)).toMatch(
    new RegExp(
      `^Clipped to their start and end: ${long.replace(/\./g, "\\.")} \\(${size} chars\\)$`,
      "m",
    ),
  );
});

test("askPages gives duplicate sources a numbered suffix in order", async () => {
  const name = `${token()}.md`;
  const { adapter, sent } = recordingAdapter();
  await askPages(adapter, askOptions([doc(name, 10), doc(name, 10), doc(name, 10)]));
  expect(sent.flat()).toStrictEqual([name, `${name}#2`, `${name}#3`]);
});

test("answers about a duplicate source map back to that copy", async () => {
  const name = `${token()}.md`;
  const { adapter } = recordingAdapter(
    () => `- second copy has it [${name}#2]\nNOT FOUND: ${name}`,
  );
  const report = await askPages(adapter, askOptions([doc(name, 10), doc(name, 10)]));
  expect(report.batches[0]?.notFound).toStrictEqual([name]);
});

test("sourceNames uses base names when they are unique", () => {
  const names = [`${token()}.md`, `${token()}.md`];
  expect(sourceNames(names.map((name) => path.join("/data", token(), name)))).toStrictEqual(names);
});

test("sourceNames uses paths relative to the common folder when base names collide", () => {
  const [left, right, name] = [token(), token(), `${token()}.md`];
  expect(
    sourceNames([path.join("/out/collect", left, name), path.join("/out/collect", right, name)]),
  ).toStrictEqual([path.join(left, name), path.join(right, name)]);
});

test("the example adapter sends images as base64 image blocks before the text block", async () => {
  const example = await loadAdapterModule(
    path.resolve(import.meta.dirname, "..", "..", "examples", "ask-adapter.example.ts"),
  );
  gateway.respondWith({
    content: [{ type: "text", text: "- ok" }],
    usage: { input_tokens: 7, output_tokens: 2 },
  });
  const reply = await example.complete({
    system: "SYS",
    prompt: "PROMPT",
    model: modelId("haiku"),
    maxTokens: 10,
    signal: new AbortController().signal,
    images: [
      { mediaType: "image/png", data: "AAAA" },
      { mediaType: "image/jpeg", data: "BBBB" },
    ],
  });
  expect(reply.text).toBe("- ok");
  expect(gateway.received.body?.model).toBe("claude-haiku-5-5");
  expect(gateway.received.body?.messages[0]?.content).toStrictEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
    { type: "text", text: "PROMPT" },
  ]);
});

test("a batch cut off at the output limit keeps its partial lines and is marked truncated", async () => {
  const adapter: AskAdapter = {
    name: "limited",
    complete: async ({ prompt }) => {
      const [source] = promptSources(prompt);
      return source === "long.md"
        ? { text: "- first fact [long.md]\n- second fa", stopReason: "max_tokens" }
        : { text: `- ok [${source}]`, stopReason: "end_turn" };
    },
  };
  const report = await askPages(
    adapter,
    askOptions([doc("long.md", 10), doc("short.md", 10)], { maxPagesPerBatch: 1 }),
  );
  const cut = report.batches.find((batch) => batch.sources.includes("long.md"));
  expect(cut?.truncated).toBe(true);
  expect(cut?.error).toBe(undefined);
  expect(cut?.answers).toContain("- first fact [long.md]");
  expect(report.batches.find((batch) => batch.sources.includes("short.md"))?.truncated).toBe(
    undefined,
  );
  const text = renderAskResults("q", report);
  expect(text).toMatch(/^- first fact \[long\.md\]$/m);
  expect(text).toMatch(
    /call 1 \[long\.md\]: answer cut off at the output limit or the context window; raise max_output_tokens or lower batch_chars/,
  );
});

test("an interrupted batch reports its partial answer separately from output cutoffs", async () => {
  const adapter: AskAdapter = {
    name: "interrupted",
    complete: async () => ({ text: "- first fact [long.md]", stopReason: "interrupted" }),
  };
  const report = await askPages(adapter, askOptions([doc("long.md", 10)]));
  expect(report.batches[0]?.interrupted).toBe(true);
  expect(renderAskResults("q", report)).toMatch(
    /first fact \[long\.md\][\s\S]*Interrupted calls[\s\S]*call 1 \[long\.md\]/,
  );
});

test("a refused batch is failed with the refusal as its reason", async () => {
  const adapter: AskAdapter = {
    name: "refusing",
    complete: async ({ prompt }) => {
      const [source] = promptSources(prompt);
      return source === "bad.md"
        ? { text: "- partial [bad.md]", stopReason: "refusal" }
        : { text: `- ok [${source}]` };
    },
  };
  const report = await askPages(
    adapter,
    askOptions([doc("bad.md", 10), doc("good.md", 10)], { maxPagesPerBatch: 1 }),
  );
  const refused = report.batches.find((batch) => batch.sources.includes("bad.md"));
  expect(refused?.error ?? "").toMatch(/refused/);
  expect(refused?.answers).toStrictEqual([]);
  expect(report.batches.find((batch) => batch.sources.includes("good.md"))?.answers).toStrictEqual([
    "- ok [good.md]",
  ]);
});

test("askPages passes maxTokens to the adapter", async () => {
  const seen: number[] = [];
  const adapter: AskAdapter = {
    name: "budget",
    complete: async ({ maxTokens }) => (seen.push(maxTokens), { text: "NOT FOUND" }),
  };
  await askPages(adapter, askOptions([doc("a.md", 10)], { maxTokens: 16_000 }));
  expect(seen).toStrictEqual([16_000]);
});

test("askPages sends each batch's images in page order with the batch's prompt", async () => {
  const seen: { sources: string[]; labels: string[] }[] = [];
  const adapter: AskAdapter = {
    name: "images",
    complete: async ({ prompt, images }) => {
      seen.push({
        sources: promptSources(prompt).filter(
          (source, index, all) => all.indexOf(source) === index,
        ),
        labels: (images ?? []).map((entry) => entry.label ?? ""),
      });
      return { text: "NOT FOUND" };
    },
  };
  await askPages(
    adapter,
    askOptions([
      { source: "a.md", text: "Alpha", images: [image("a1"), image("a2")] },
      { source: "b.md", text: "Beta" },
      { source: "c.md", text: "Gamma", images: [image("c1")] },
    ]),
  );
  expect(seen).toStrictEqual([{ sources: ["a.md", "b.md", "c.md"], labels: ["a1", "a2", "c1"] }]);
});

const many = (source: string, count: number) => ({
  source,
  text: "x",
  images: Array.from({ length: count }, (_value, index) => image(`${source}${index}`)),
});

test("packBatches weighs images and never puts more than 100 images in one call", () => {
  const batches = packBatches([many("a", 60), many("b", 60), many("c", 10)], 10_000_000);
  expect(batches.map((batch) => batch.map((entry) => entry.source))).toStrictEqual([
    ["a"],
    ["b", "c"],
  ]);
  expect(
    packBatches([many("a", 3), { source: "b", text: "y".repeat(10) }], 3 * IMAGE_CHARS).map(
      (batch) => batch.length,
    ),
  ).toStrictEqual([1, 1]);
});

test("an empty reply cut off at the output limit or refused is reported, not read as no answers", async () => {
  const adapter: AskAdapter = {
    name: "empty",
    complete: async ({ prompt }) => ({
      text: "",
      stopReason: promptSources(prompt)[0] === "cut.md" ? "max_tokens" : "refusal",
    }),
  };
  const report = await askPages(
    adapter,
    askOptions([doc("cut.md", 10), doc("refused.md", 10)], { maxPagesPerBatch: 1 }),
  );
  const text = renderAskResults("q", report);
  expect(text).toMatch(/call 1 \[cut\.md\]: answer cut off at the output limit/);
  expect(text).toMatch(/call 2 \[refused\.md\]: the model refused to answer/);
});

test("askPages sets no time limit by default, so a slow call is not cut off", async () => {
  const adapter: AskAdapter = {
    name: "slow but answering",
    complete: async ({ signal, prompt }) => {
      await sleep(150);
      expect(signal.aborted).toBe(false);
      return { text: `- ok [${promptSources(prompt)[0]}]` };
    },
  };
  const { timeoutMs: _unused, ...withoutTimeout } = askOptions([doc("a.md", 10)]);
  const report = await askPages(adapter, withoutTimeout);
  expect(report.batches[0]?.answers).toStrictEqual(["- ok [a.md]"]);
});

test("askPages ends its calls when the caller's signal aborts", async () => {
  const controller = new AbortController();
  let aborted = false;
  const adapter: AskAdapter = {
    name: "hanging",
    complete: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      ),
  };
  setTimeout(() => controller.abort(), 50);
  const { timeoutMs: _unused, ...withoutTimeout } = askOptions([doc("a.md", 10)]);
  await expect(askPages(adapter, { ...withoutTimeout, signal: controller.signal })).rejects.toThrow(
    /cancelled/,
  );
  expect(aborted).toBe(true);
});

test("exceedsContextWindow recognises Anthropic prompt-too-long errors only", () => {
  const yes = [
    "Anthropic Messages returned HTTP 400: invalid_request_error: prompt is too long: 1052114 tokens > 1000000 maximum",
    "Anthropic Messages returned HTTP 400: invalid_request_error: input length and `max_tokens` exceed context limit: 990000 + 128000 > 1000000, decrease input length or `max_tokens` and try again",
    "Anthropic Messages stream error: invalid_request_error: Prompt is too long",
    "invalid_request_error: The request exceeds the model's context window",
  ];
  const no = [
    "Anthropic Messages returned HTTP 400: invalid_request_error: max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens",
    "Anthropic Messages returned HTTP 429: rate_limit_error: prompt is too long for this rate limit",
    "Anthropic Messages returned HTTP 413: request_too_large: Request exceeds the maximum allowed number of bytes",
    "prompt is too long",
    "rate limited",
  ];
  for (const message of yes) expect(exceedsContextWindow(new Error(message))).toBe(true);
  for (const message of no) expect(exceedsContextWindow(new Error(message))).toBe(false);
  expect(exceedsContextWindow(yes[0])).toBe(true);
});

test("a batch that exceeds the context window is split in half until it fits, and a page that never fits fails alone", async () => {
  const seen: string[] = [];
  const adapter: AskAdapter = {
    name: "small context",
    complete: async ({ prompt }) => {
      const sources = promptSources(prompt);
      seen.push(sources.join(","));
      const size = [...prompt.matchAll(/">\n(x*)\n<\/document>/g)].reduce(
        (total, match) => total + (match[1]?.length ?? 0),
        0,
      );
      if (size > 250)
        throw new Error(
          `Anthropic Messages returned HTTP 400: invalid_request_error: prompt is too long: ${size} tokens > 250 maximum`,
        );
      return { text: sources.map((source) => `- seen [${source}]`).join("\n") };
    },
  };
  const report = await askPages(
    adapter,
    askOptions(
      [doc("a.md", 100), doc("b.md", 100), doc("c.md", 100), doc("d.md", 50), doc("huge.md", 900)],
      { concurrency: 1 },
    ),
  );
  expect(seen).toStrictEqual([
    "a.md,b.md,c.md,d.md,huge.md",
    "a.md,b.md,c.md",
    "a.md,b.md",
    "c.md",
    "d.md,huge.md",
    "d.md",
    "huge.md",
  ]);
  expect(report.batches.map((batch) => batch.sources.join(","))).toStrictEqual([
    "a.md,b.md",
    "c.md",
    "d.md",
    "huge.md",
  ]);
  expect(report.batches.map((batch) => batch.index)).toStrictEqual([1, 2, 3, 4]);
  expect(report.batches.flatMap((batch) => batch.answers)).toStrictEqual([
    "- seen [a.md]",
    "- seen [b.md]",
    "- seen [c.md]",
    "- seen [d.md]",
  ]);
  const failed = report.batches.at(-1);
  expect(failed?.error ?? "").toMatch(
    /^the page does not fit the model's context window on its own: .*prompt is too long/,
  );
  const text = renderAskResults("q", report);
  expect(text).toMatch(
    /call 4 \[huge\.md\]: the page does not fit the model's context window on its own/,
  );
});

test("a batch over the request size limit is split like a context overflow", async () => {
  const adapter: AskAdapter = {
    name: "byte limit",
    complete: async ({ prompt }) => {
      const sources = promptSources(prompt);
      if (sources.length > 1)
        throw new Error(
          "Anthropic Messages returned HTTP 413: request_too_large: Request exceeds the maximum allowed number of bytes",
        );
      return { text: `- seen [${sources[0]}]` };
    },
  };
  const report = await askPages(
    adapter,
    askOptions([doc("a.md", 10), doc("b.md", 10)], { concurrency: 1 }),
  );
  expect(report.batches.map((batch) => [batch.sources.join(","), batch.error])).toStrictEqual([
    ["a.md", undefined],
    ["b.md", undefined],
  ]);
});

test("a 413 without an error body is still split", async () => {
  const adapter: AskAdapter = {
    name: "byte limit",
    complete: async ({ prompt }) => {
      const sources = promptSources(prompt);
      if (sources.length > 1) throw new Error("Anthropic Messages returned HTTP 413.");
      return { text: `- seen [${sources[0]}]` };
    },
  };
  const report = await askPages(
    adapter,
    askOptions([doc("a.md", 10), doc("b.md", 10)], { concurrency: 1 }),
  );
  expect(report.batches.length).toBe(2);
});

test("a batch stopped at the context window is marked truncated", async () => {
  const adapter: AskAdapter = {
    name: "full",
    complete: async () => ({
      text: "- first fact [a.md]\n- second fa",
      stopReason: "model_context_window_exceeded",
    }),
  };
  const report = await askPages(adapter, askOptions([doc("a.md", 10)]));
  expect(report.batches[0]?.truncated).toBe(true);
});

test("a setup error in the first half of a split batch stops the second half", async () => {
  const seen: string[] = [];
  const adapter: AskAdapter = {
    name: "signed out mid-split",
    complete: async ({ prompt }) => {
      const sources = promptSources(prompt);
      seen.push(sources.join(","));
      if (sources.length > 2)
        throw new Error(
          "Anthropic Messages returned HTTP 400: invalid_request_error: prompt is too long: 900 tokens > 250 maximum",
        );
      throw new AskSetupError("session expired");
    },
  };
  await expect(
    askPages(
      adapter,
      askOptions([doc("a.md", 10), doc("b.md", 10), doc("c.md", 10), doc("d.md", 10)], {
        concurrency: 1,
      }),
    ),
  ).rejects.toThrow(AskSetupError);
  expect(seen).toStrictEqual(["a.md,b.md,c.md,d.md", "a.md,b.md"]);
});

test("failures other than a context overflow are not split", async () => {
  const adapter: AskAdapter = {
    name: "broken",
    complete: async () => {
      throw new Error("upstream down");
    },
  };
  const report = await askPages(adapter, askOptions([doc("a.md", 10), doc("b.md", 10)]));
  expect(report.batches.map((batch) => [batch.sources.join(","), batch.error])).toStrictEqual([
    ["a.md,b.md", "upstream down"],
  ]);
});

test("askPages in review mode sends the review prompt and merges issues from every call sorted by severity", async () => {
  const systems = new Set<string>();
  const adapter: AskAdapter = {
    name: "reviewer",
    complete: async ({ system, prompt }) => {
      systems.add(system);
      const [source] = promptSources(prompt);
      if (source === "a.md")
        return {
          text: "- [low] a.md, footer: uneven gap\n- [high] a.md, tile 1/2 hero: image missing",
        };
      if (source === "b.md") return { text: "- [medium] b.md, nav: items overlap" };
      return { text: "OK: c.md" };
    },
  };
  const report = await askPages(
    adapter,
    askOptions([doc("a.md", 10), doc("b.md", 10), doc("c.md", 10)], {
      maxPagesPerBatch: 1,
      mode: "review",
    }),
  );
  expect([...systems]).toStrictEqual([REVIEW_SYSTEM]);
  const text = renderAskResults("Check layouts", report);
  expect(text).toMatch(
    /^Review: Check layouts\n\n- \[high\] a\.md, tile 1\/2 hero: image missing\n- \[medium\] b\.md, nav: items overlap\n- \[low\] a\.md, footer: uneven gap\n\nNo issues in: c\.md/,
  );
});

test("a review with no issues says so", async () => {
  const adapter: AskAdapter = { name: "reviewer", complete: async () => ({ text: "OK: a.md" }) };
  const report = await askPages(adapter, askOptions([doc("a.md", 10)], { mode: "review" }));
  expect(renderAskResults("Check", report)).toMatch(
    /^Review: Check\n\nNo page had issues\.\n\nNo issues in: a\.md/,
  );
});

test("askPages keeps the raw reply of every call", async () => {
  const adapter: AskAdapter = {
    name: "raw",
    complete: async () => ({ text: "- fact [a.md]\nNOT FOUND: b.md (see below)" }),
  };
  const report = await askPages(adapter, {
    question: "q",
    documents: [doc("a.md", 10), doc("b.md", 10)],
    batchChars: 1000,
    concurrency: 1,
    model: "m",
    maxTokens: 1000,
  });
  expect(report.batches[0]?.reply).toBe("- fact [a.md]\nNOT FOUND: b.md (see below)");
});

const browseOptions = (
  adapter: AskAdapter,
  documents: AskDocument[],
  extra: Partial<Parameters<typeof askPages>[1]> = {},
) =>
  askPages(adapter, {
    question: "What does each plan cost per year?",
    documents,
    batchChars: 100_000,
    concurrency: 1,
    model: "m",
    maxTokens: 100,
    ...extra,
  });

test("26: browsing off keeps the system prompts byte-identical and HIDDEN lines are plain answers", async () => {
  const systems: string[] = [];
  const adapter: AskAdapter = {
    name: "fake",
    complete: async ({ system }) => {
      systems.push(system);
      return { text: "HIDDEN: a.md: the Yearly switch" };
    },
  };
  const report = await browseOptions(adapter, [{ source: "a.md", text: "plans" }]);
  await browseOptions(adapter, [{ source: "a.md", text: "plans" }], { mode: "review" });
  expect(systems).toStrictEqual([ASK_SYSTEM, REVIEW_SYSTEM]);
  expect(report.batches[0]?.answers).toStrictEqual(["- HIDDEN: a.md: the Yearly switch"]);
  expect(report.batches[0]?.escalations).toBe(undefined);
});

test("26: browsing on appends the interaction notes and the example HIDDEN line parses", async () => {
  const systems: string[] = [];
  const adapter: AskAdapter = {
    name: "fake",
    complete: async ({ system }) => {
      systems.push(system);
      return {
        text: "NOT FOUND: 02-acme-com-pricing.md\nHIDDEN: 02-acme-com-pricing.md: the Yearly switch above the plans shows the yearly prices",
      };
    },
  };
  const report = await browseOptions(
    adapter,
    [{ source: "02-acme-com-pricing.md", text: "plans" }],
    { browse: true },
  );
  await browseOptions(adapter, [{ source: "02-acme-com-pricing.md", text: "plans" }], {
    browse: true,
    mode: "review",
  });
  expect(systems).toStrictEqual([
    `${ASK_SYSTEM}\n\n${ASK_BROWSE_NOTE}`,
    `${REVIEW_SYSTEM}\n\n${REVIEW_BROWSE_NOTE}`,
  ]);
  expect(report.batches[0]?.escalations).toStrictEqual([
    {
      source: "02-acme-com-pricing.md",
      hint: "the Yearly switch above the plans shows the yearly prices",
    },
  ]);
  expect(report.batches[0]?.answers).toStrictEqual([]);
  const example = /^Example: (HIDDEN: .+)$/m.exec(ASK_BROWSE_NOTE)?.[1] ?? "";
  expect(
    parseEscalations(example, ["02-acme-com-pricing.md"], "answer").escalations[0]?.source,
  ).toBe("02-acme-com-pricing.md");
});

const countedHome = {
  source: "01-home.md",
  text: ["## Available Examples", "- A", "- B", "- C"].join("\n"),
};
const countingAdapter = (line: string): AskAdapter => ({
  name: "counting",
  complete: async () => ({ text: line }),
});

test("askPages flags a read-pass count that disagrees with the page it cites", async () => {
  const report = await askPages(
    countingAdapter(
      '- The home page lists 4 examples {count 4: list items under "Available Examples"} [01-home.md]',
    ),
    askOptions([countedHome]),
  );
  expect(report.batches[0]?.answers).toStrictEqual([
    "- The home page lists 4 examples [count checked: 3, not 4] [01-home.md]",
  ]);
});

test("askPages marks a read-pass count that agrees with the page it cites as checked", async () => {
  const report = await askPages(
    countingAdapter(
      '- The home page lists 3 examples {count 3: list items under "Available Examples"} [01-home.md]',
    ),
    askOptions([countedHome]),
  );
  expect(report.batches[0]?.answers).toStrictEqual([
    "- The home page lists 3 examples [count checked] [01-home.md]",
  ]);
});

test("askPages removes the count tag of a line that cites no page", async () => {
  const report = await askPages(
    countingAdapter("- The home page lists 3 examples {count 3: list items on the page}"),
    askOptions([countedHome]),
  );
  expect(report.batches[0]?.answers).toStrictEqual(["- The home page lists 3 examples"]);
});

test("askPages removes the count tag of a line that cites a plain-text page, without a mark", async () => {
  const report = await askPages(
    countingAdapter("- The page lists 3 examples {count 3: list items on the page} [01-home.txt]"),
    askOptions([{ source: "01-home.txt", text: "Examples\nAlpha\nBeta\nGamma", plain: true }]),
  );
  expect(report.batches[0]?.answers).toStrictEqual(["- The page lists 3 examples [01-home.txt]"]);
});

test("the answer prompt asks for a count tag on lines that count items", () => {
  expect(ASK_SYSTEM).toMatch(/\{count N: list items under "<heading>"\}/);
});
