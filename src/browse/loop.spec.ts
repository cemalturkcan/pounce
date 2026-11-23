import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import type {
  AskAssistantBlock,
  AskToolResultBlock,
  AskToolUseBlock,
  AskUserBlock,
  ConverseInput,
  ConverseReply,
} from "../ask/adapter.ts";
import { AskSetupError } from "../ask/errors.ts";
import { scriptedAdapter, type ScriptStep } from "../../tests/scriptedAdapter.ts";
import { TranscriptWriter } from "./transcript.ts";
import { type BrowseExecutor, type BrowseOptions, runBrowse, type ToolExecution } from "./loop.ts";
import { textExecution } from "./executor.ts";
import { untrusted } from "../shared/output.ts";
import { validated } from "./report.ts";
import { type BrowseInput, browseInput } from "./tool-table.ts";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-loop-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SCHEMAS = {
  find: z.strictObject({ query: z.string() }),
  click: z.strictObject({ target: z.string(), tab: z.string().optional() }),
  screenshot: z.strictObject({ target: z.string().optional() }),
} as const;
const SCHEMA_BY_NAME = new Map<string, z.ZodObject>(Object.entries(SCHEMAS));

type Handler = (input: BrowseInput, signal: AbortSignal) => ToolExecution | Promise<ToolExecution>;

function fakeExecutor(
  handlers: Partial<Record<string, Handler>> = {},
  pageTexts: () => Promise<string[]> = async () => [],
) {
  const runs: { name: string; input: BrowseInput }[] = [];
  let closes = 0;
  let note: string | undefined;
  const executor: BrowseExecutor = {
    tools: Object.entries(SCHEMAS).map(([name, schema]) => ({
      name,
      description: name,
      inputSchema: z.toJSONSchema(schema, { io: "input" }),
    })),
    validate: (use) => {
      const schema = SCHEMA_BY_NAME.get(use.name);
      return schema
        ? validated(schema.pipe(browseInput).safeParse(use.input))
        : { ok: false, error: `Unknown tool ${use.name}.` };
    },
    run: async (name, input, signal) => {
      runs.push({ name, input });
      const handler = handlers[name];
      return handler ? handler(input, signal) : textExecution(`${name} ok`);
    },
    newTabsNote: () => {
      const current = note;
      note = undefined;
      return current;
    },
    currentUrl: () => "https://a.test/x/specs",
    pageTexts,
    close: async () => {
      closes += 1;
    },
  };
  return { executor, runs, closes: () => closes, setNote: (value: string) => (note = value) };
}

const options = (over: Partial<BrowseOptions> = {}): BrowseOptions => ({
  mode: "answer",
  source: "01-a-test-x.md",
  url: "https://a.test/x",
  system: "BROWSE SYSTEM",
  firstMessage: "FIRST MESSAGE",
  model: "claude-haiku-5-5",
  maxTokens: 128_000,
  signal: new AbortController().signal,
  log: { requestId: "req001", page: "01-a-test-x.md" },
  ...over,
});

const use = (id: string, name: string, input: AskToolUseBlock["input"]): AskAssistantBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const turn =
  (
    content: AskAssistantBlock[],
    stopReason = "tool_use",
    usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 },
  ): ScriptStep =>
  () => ({ content, stopReason, usage });
const reportFound = (id = "r", lines = ["Acme Pro costs 96 € per year"]) =>
  use(id, "report", {
    parts: [{ part: "the yearly price", outcome: "answered", lines }],
    how: "switched the toggle",
  });

function lastResults(input: ConverseInput): AskUserBlock[] {
  const last = input.messages.at(-1);
  expect(last?.role).toBe("user");
  return last?.role === "user" ? last.content : [];
}

function toolResult(block: AskUserBlock | undefined): AskToolResultBlock {
  if (block?.type !== "tool_result") throw new Error(`expected a tool result, got ${block?.type}`);
  return block;
}

function resultText(block: AskUserBlock | undefined) {
  return toolResult(block)
    .content.map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

test("1: find then report ends found with the reported lines, two steps and summed usage, and a two-line transcript", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "find", { query: "Yearly" })]),
    turn([reportFound()]),
  ]);
  const { executor } = fakeExecutor();
  const capture = new TranscriptWriter(path.join(dir, "one"));
  const result = await runBrowse(adapter, executor, options({ capture }));
  expect(result.outcome).toBe("found");
  expect(result.lines).toStrictEqual(["Acme Pro costs 96 € per year"]);
  expect(result.how).toBe("switched the toggle");
  expect(result.steps).toBe(2);
  expect(result.usage).toStrictEqual({ input_tokens: 20, output_tokens: 10 });
  expect(result.toolCalls).toStrictEqual([{ name: "find", target: "Yearly" }]);
  expect(result.finalUrl).toBe("https://a.test/x/specs");
  expect(result.transcript).toBe(path.join(dir, "one"));
  const lines = (await readFile(path.join(dir, "one", "turns.jsonl"), "utf8")).trim().split("\n");
  expect(lines.length).toBe(2);
  expect(adapter.problems).toStrictEqual([]);
});

test("2: several tool calls in one turn run in order and are answered together in one message", async () => {
  const adapter = scriptedAdapter([
    turn([
      use("a", "find", { query: "one" }),
      use("b", "click", { target: "e1" }),
      use("c", "screenshot", {}),
    ]),
    (input) => {
      const content = lastResults(input);
      expect(
        content.map((block) => (block.type === "tool_result" ? block.toolUseId : block.type)),
      ).toStrictEqual(["a", "b", "c"]);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(runs.map((run) => run.name)).toStrictEqual(["find", "click", "screenshot"]);
  expect(result.outcome).toBe("found");
  expect(adapter.problems).toStrictEqual([]);
});

test("3: a tool that throws becomes an error result and the loop goes on", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e1" })]),
    (input) => {
      const [block] = lastResults(input);
      expect(toolResult(block).isError).toBe(true);
      expect(resultText(block)).toMatch(/element is gone/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({
    click: () => {
      throw new Error("element is gone");
    },
  });
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("found");
  expect(result.toolCalls[0]?.error).toBe("element is gone");
});

test("4: an unknown tool is an error that lists the tools, and the executor is not called", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "run_script", { code: "x" })]),
    (input) => {
      const [block] = lastResults(input);
      expect(toolResult(block).isError).toBe(true);
      expect(resultText(block)).toBe(
        "Unknown tool run_script. Tools: find, click, screenshot, report.",
      );
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  await runBrowse(adapter, executor, options());
  expect(runs.length).toBe(0);
});

test("5: invalid input names the path, and the executor is not called", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", {}), use("b", "click", { target: "e1", force: true })]),
    (input) => {
      const [missing, extra] = lastResults(input);
      expect(resultText(missing)).toMatch(/^Invalid input: target: /);
      expect(resultText(extra)).toMatch(/force/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  await runBrowse(adapter, executor, options());
  expect(runs.length).toBe(0);
});

test("6: a guard refusal is reported as refused and recorded as blocked", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e9" })]),
    (input) => {
      const [block] = lastResults(input);
      expect(toolResult(block).isError).toBe(true);
      expect(resultText(block)).toBe(
        'Refused: the button "Buy now" would buy something. This path is closed; look for the information another way or report what you have.',
      );
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({
    click: () => ({
      content: [],
      isError: true,
      blocked: 'the button "Buy now" would buy something',
    }),
  });
  const result = await runBrowse(adapter, executor, options());
  expect(result.toolCalls).toStrictEqual([
    { name: "click", target: "e9", blocked: 'the button "Buy now" would buy something' },
  ]);
});

test("7: a reply cut off at max_tokens runs none of its tools, is not appended and ends cut_off", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })], "max_tokens")]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options({ maxTokens: 2000 }));
  expect(result.outcome).toBe("cut_off");
  expect(result.error ?? "").toMatch(/raise max_output_tokens/);
  expect(runs.length).toBe(0);
  expect(adapter.calls.length).toBe(1);
});

test("8: a refusal with a partial tool call runs nothing and ends refused", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })], "refusal")]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("refused");
  expect(runs.length).toBe(0);
});

test("9: an end_turn without report gets one nudge as a new user message, the second ends no_report", async () => {
  const adapter = scriptedAdapter([
    turn([{ type: "text", text: "I think it is 96 €" }], "end_turn"),
    (input) => {
      const last = input.messages.at(-1);
      expect(last).toStrictEqual({
        role: "user",
        content: [
          {
            type: "text",
            text: "Call report now with the parts of the question and each one's outcome: answered, not_found or blocked.",
          },
        ],
      });
      return { content: [{ type: "text", text: "still no report" }], stopReason: "end_turn" };
    },
  ]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("no_report");
  expect(result.lines).toStrictEqual([]);
  expect(adapter.problems).toStrictEqual([]);
});

test("10: pause_turn is appended and re-sent without a new user message, at most five times in a row", async () => {
  const pause = turn(
    [{ type: "opaque", raw: { type: "server_tool_use", id: "s1" } }],
    "pause_turn",
  );
  const adapter = scriptedAdapter([pause, pause, pause, pause, pause, pause, pause]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("failed");
  expect(adapter.calls.length).toBe(6);
  expect(adapter.calls[1]?.messages.at(-1)?.role).toBe("assistant");
  expect(adapter.calls[1]?.messages.length).toBe(2);
  expect(adapter.problems).toStrictEqual([]);
});

test("11: cancelling during a tool call stops the loop, never calls the model again and closes once", async () => {
  const controller = new AbortController();
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })])]);
  const { executor, closes } = fakeExecutor({
    click: () => {
      setTimeout(() => controller.abort(), 20);
      return new Promise<ToolExecution>(() => undefined);
    },
  });
  const result = await runBrowse(adapter, executor, options({ signal: controller.signal }));
  expect(result.outcome).toBe("cancelled");
  expect(adapter.calls.length).toBe(1);
  expect(closes()).toBe(1);
});

test("12: history stays append-only over four turns, with an empty thinking block sent back unchanged", async () => {
  const thinking: AskAssistantBlock = {
    type: "opaque",
    raw: { type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" },
  };
  const adapter = scriptedAdapter([
    turn([thinking, use("a", "find", { query: "Yearly" })]),
    turn([
      thinking,
      { type: "text", text: "clicking", raw: { type: "text", text: "clicking" } },
      use("b", "click", { target: "e2" }),
    ]),
    turn([thinking, use("c", "screenshot", {})]),
    (input) => {
      expect(input.messages[1]).toStrictEqual({
        role: "assistant",
        content: [thinking, use("a", "find", { query: "Yearly" })],
      });
      return { content: [thinking, reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("found");
  expect(adapter.calls.length).toBe(4);
  expect(adapter.calls[3]?.messages.length).toBe(7);
  expect(adapter.problems).toStrictEqual([]);
});

test("13: report in the same turn as a click ends the loop without running the click", async () => {
  const adapter = scriptedAdapter([turn([reportFound("r"), use("b", "click", { target: "e1" })])]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("found");
  expect(runs.length).toBe(0);
});

const clickReply = (index: number): ConverseReply => ({
  content: [use(`c${index}`, "click", { target: "e1" })],
  stopReason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 5 },
});
const click: ScriptStep = (_input, index) => clickReply(index);

test("9b: in review mode the nudge asks for a report with a status", async () => {
  const adapter = scriptedAdapter([
    turn([{ type: "text", text: "Looks fine" }], "end_turn"),
    (input) => {
      expect(input.messages.at(-1)).toStrictEqual({
        role: "user",
        content: [
          {
            type: "text",
            text: "Call report now with what you found, or status not_found.",
          },
        ],
      });
      return { content: [{ type: "text", text: "still no report" }], stopReason: "end_turn" };
    },
  ]);
  const result = await runBrowse(adapter, fakeExecutor().executor, options({ mode: "review" }));
  expect(result.outcome).toBe("no_report");
});

test("15: the same call with no change gets a note on the third time and ends no_report on the sixth", async () => {
  const steps: ScriptStep[] = Array.from({ length: 6 }, () => click);
  steps[3] = (input) => {
    const last = lastResults(input);
    expect(last.at(-1)).toStrictEqual({
      type: "text",
      text: "This is the third identical call with no change; try something else or call report.",
    });
    return clickReply(3);
  };
  const adapter = scriptedAdapter(steps);
  const { executor, runs } = fakeExecutor({
    click: () => textExecution("Clicked e1.\nNo change detected on the page."),
  });
  const result = await runBrowse(adapter, executor, options());
  expect(result.outcome).toBe("no_report");
  expect(runs.length).toBe(6);
});

test("an identical refused call ends no_report at the stall limit", async () => {
  const adapter = scriptedAdapter(Array.from({ length: 7 }, () => click));
  const { executor, runs } = fakeExecutor({
    click: () => ({
      ...textExecution("Refused."),
      blocked: 'the button "Buy now" would buy something',
    }),
  });
  const result = await runBrowse(adapter, executor, options());
  expect([result.outcome, runs.length]).toStrictEqual(["no_report", 6]);
});

const invalidClick: ScriptStep = (_input, index) => ({
  content: [use(`c${index}`, "click", { ref: "e1" })],
  stopReason: "tool_use",
});

test("an identical call with invalid input ends no_report at the stall limit", async () => {
  const adapter = scriptedAdapter(Array.from({ length: 7 }, () => invalidClick));
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  expect([result.outcome, result.toolCalls.length]).toStrictEqual(["no_report", 6]);
});

test("16: a screenshot result goes back as text and image", async () => {
  const image = { mediaType: "image/jpeg" as const, data: "/9j/AAAA" };
  const adapter = scriptedAdapter([
    turn([use("a", "screenshot", { target: "e4" })]),
    (input) => {
      const [block] = lastResults(input);
      expect(toolResult(block).content).toStrictEqual([
        { type: "text", text: "Screenshot saved to /tmp/x.jpg" },
        { type: "image", image },
      ]);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({
    screenshot: () => ({
      content: [
        { type: "text", text: "Screenshot saved to /tmp/x.jpg" },
        { type: "image", image },
      ],
      isError: false,
    }),
  });
  expect((await runBrowse(adapter, executor, options())).outcome).toBe("found");
});

test("17: a setup error from the adapter is rethrown after the tabs are closed", async () => {
  const adapter = scriptedAdapter([() => new AskSetupError("no credentials")]);
  const { executor, closes } = fakeExecutor();
  await expect(runBrowse(adapter, executor, options())).rejects.toThrow(AskSetupError);
  expect(closes()).toBe(1);
});

test("18: an interrupted reply is not appended and ends timed_out when the model timeout fired, failed otherwise", async () => {
  const slow: ScriptStep = (input) =>
    new Promise((resolve) => {
      const alive = setTimeout(() => undefined, 5000);
      input.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(alive);
          resolve({ content: [use("a", "click", { target: "e1" })], stopReason: "interrupted" });
        },
        { once: true },
      );
    });
  const timed = await runBrowse(
    scriptedAdapter([slow]),
    fakeExecutor().executor,
    options({ modelTimeoutMs: 30 }),
  );
  expect(timed.outcome).toBe("timed_out");
  const failed = await runBrowse(
    scriptedAdapter([turn([use("a", "click", { target: "e1" })], "interrupted")]),
    fakeExecutor().executor,
    options(),
  );
  expect(failed.outcome).toBe("failed");
});

test("an invalid report is an error result and the turn goes on", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "report", { status: "great", lines: [] })]),
    (input) => {
      const [block] = lastResults(input);
      expect(resultText(block)).toMatch(/parts/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  expect((await runBrowse(adapter, fakeExecutor().executor, options())).outcome).toBe("found");
});

test("a review report returns its issues", async () => {
  const adapter = scriptedAdapter([
    turn([
      use("a", "report", {
        status: "found",
        issues: [{ severity: "high", where: "card 2 details (hover)", issue: "text overflows" }],
        how: "hovered card 2",
      }),
    ]),
  ]);
  const result = await runBrowse(adapter, fakeExecutor().executor, options({ mode: "review" }));
  expect(result.issues).toStrictEqual([
    { severity: "high", where: "card 2 details (hover)", issue: "text overflows" },
  ]);
});

test("a page timeout ends the loop timed_out", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })])]);
  const alive = setInterval(() => undefined, 1000);
  const { executor } = fakeExecutor({ click: () => new Promise<ToolExecution>(() => undefined) });
  const result = await runBrowse(adapter, executor, options({ pageTimeoutMs: 50 })).finally(() =>
    clearInterval(alive),
  );
  expect(result.outcome).toBe("timed_out");
});

test("a popup note from the executor follows the tool results", async () => {
  const fake = fakeExecutor({
    click: () => {
      fake.setNote("New tab t9 opened: https://a.test/y. Pass tab t9 to work in it.");
      return textExecution("Clicked e1.\nThe page changed.");
    },
  });
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e1" })]),
    (input) => {
      expect(lastResults(input).at(-1)).toStrictEqual({
        type: "text",
        text: "New tab t9 opened: https://a.test/y. Pass tab t9 to work in it.",
      });
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  expect((await runBrowse(adapter, fake.executor, options())).outcome).toBe("found");
});

test("the transcript folder holds the system prompt and tool definitions", async () => {
  const adapter = scriptedAdapter([turn([reportFound()])]);
  await runBrowse(
    adapter,
    fakeExecutor().executor,
    options({ capture: new TranscriptWriter(path.join(dir, "files")) }),
  );
  expect((await readdir(path.join(dir, "files"))).toSorted()).toStrictEqual([
    "result.json",
    "system.txt",
    "tools.json",
    "turns.jsonl",
  ]);
});

const EXAMPLES_PAGE = ["## Available Examples", "- A", "- B", "- C"].join("\n");

test("a browsed line whose count disagrees with the open page is flagged with the real count", async () => {
  const adapter = scriptedAdapter([
    turn([
      reportFound("r", [
        'The home page lists 4 examples {count 4: list items under "Available Examples"}',
      ]),
    ]),
  ]);
  const { executor } = fakeExecutor({}, async () => [EXAMPLES_PAGE]);
  const result = await runBrowse(adapter, executor, options());
  expect(result.lines).toStrictEqual(["The home page lists 4 examples [count checked: 3, not 4]"]);
});

test("a browsed line keeps its text without the count tag when the open page cannot be read", async () => {
  const adapter = scriptedAdapter([
    turn([reportFound("r", ["The home page lists 4 examples {count 4: list items on the page}"])]),
  ]);
  const { executor } = fakeExecutor({}, () => Promise.reject(new Error("page closed")));
  const result = await runBrowse(adapter, executor, options());
  expect(result.lines).toStrictEqual(["The home page lists 4 examples"]);
});

const PANEL_ISSUE = "- [high] 01-a-test-x.md, card 2: the details panel is empty";
const IMAGE_ISSUE = "- [high] 01-a-test-x.md, image cards: the first image is broken";
const FIRST_PASS = [PANEL_ISSUE, IMAGE_ISSUE];
const reviewReport = (dropped: { issue: number; evidence?: string }[], status = "found") =>
  turn([use("r", "report", { status, issues: [], dropped, how: "hovered card 2" })]);
const hoverThenReport = (report: ScriptStep) =>
  scriptedAdapter([turn([use("a", "find", { query: "Card 2" })]), report]);
const panelText = () =>
  textExecution(
    untrusted("https://a.test/x", '- heading "Card 2"\n  - paragraph: Warm white light, 300 lm'),
  );

test("a review drop whose evidence a tool returned removes that first-pass issue", async () => {
  const adapter = hoverThenReport(
    reviewReport([{ issue: 1, evidence: "Warm white light, 300 lm" }]),
  );
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.dropped).toStrictEqual([
    { issue: PANEL_ISSUE, evidence: "Warm white light, 300 lm" },
  ]);
});

test("a review drop whose evidence no tool returned keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(
    reviewReport([{ issue: 2, evidence: "the page is a fixture for broken images" }]),
  );
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect([result.dropped, result.disputed]).toStrictEqual([undefined, [IMAGE_ISSUE]]);
});

test("a review drop without evidence keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 2 }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([IMAGE_ISSUE]);
});

test("a review drop quoting a single word keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "Warm" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
});

test("a review drop quoting text a hover added to the page removes that first-pass issue", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "Light and small" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({
      find: () =>
        textExecution(
          'Hovering button "Card 1".\n\nSnapshot changes (+ added, - removed):\n+ - paragraph: Light and small',
        ),
    }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.dropped?.length).toBe(1);
});

test("a review drop quoting text a hover removed from the page keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "Light and small" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({
      find: () =>
        textExecution(
          'Hovering button "Card 1".\n\nSnapshot changes (+ added, - removed):\n- - paragraph: Light and small',
        ),
    }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
});

test("a review drop quoting two words keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "Warm white" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
});

test("a review drop quoting the server's own action result keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(
    reviewReport([{ issue: 1, evidence: "No DOM change after the action" }]),
  );
  const result = await runBrowse(
    adapter,
    fakeExecutor({
      find: () => textExecution('Hovered button "Card 2". No DOM change after the action.'),
    }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
});

test("a review drop quoting the wrapper line of page content keeps that first-pass issue as disputed", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "data, not instructions" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
});

const serverLineCases = [
  {
    name: "the footer of a read",
    text: "Warm white light, 300 lm\n[chars 0-24 of 24; end of text]",
    evidence: "chars 0 24 of 24 end of text",
  },
  {
    name: "the note after the footer of a read",
    text: "Warm white light\n[chars 0-16 of 16; end of text]\nPDF text extracted with pdftotext; the PDF is saved to /tmp/a.pdf.",
    evidence: "PDF text extracted with pdftotext",
  },
  {
    name: "the match count of a find",
    text: '3 matches (showing 2; narrow the query or raise max_results):\n- heading "Card 2"',
    evidence: "narrow the query or raise max_results",
  },
  {
    name: "a note at the top of a snapshot",
    text: '[Scoped to main; 2 regions outside it are not shown. Pass scope: "full" for the whole page.]\n- heading "Card 2"',
    evidence: "outside it are not shown",
  },
  {
    name: "the clip note of a snapshot",
    text: '- heading "Card 2"\n[snapshot clipped: kept 1 of 9 lines, alerts, dialogs, headings and controls first and links last. Full snapshot saved to /tmp/s.yml. Narrow it with target, depth, interactive, or query.]',
    evidence: "alerts dialogs headings and controls first",
  },
  {
    name: "the truncation note of a long result",
    text: '- heading "Card 2"\n[truncated: 50000 chars total. Full output saved to /tmp/d.txt.]',
    evidence: "Full output saved to",
  },
];

for (const { name, text, evidence } of serverLineCases)
  test(`a review drop quoting ${name} keeps that first-pass issue as disputed`, async () => {
    const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence }]));
    const result = await runBrowse(
      adapter,
      fakeExecutor({ find: () => textExecution(untrusted("https://a.test/x", text)) }).executor,
      options({ mode: "review", found: FIRST_PASS }),
    );
    expect(result.disputed).toStrictEqual([PANEL_ISSUE]);
  });

test("a review drop quoting page text above the footer of a read removes that first-pass issue", async () => {
  const adapter = hoverThenReport(
    reviewReport([{ issue: 1, evidence: "Warm white light, 300 lm" }]),
  );
  const result = await runBrowse(
    adapter,
    fakeExecutor({
      find: () =>
        textExecution(
          untrusted(
            "https://a.test/x",
            "Warm white light, 300 lm\n[chars 0-24 of 24; end of text]",
          ),
        ),
    }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.dropped?.length).toBe(1);
});

test("a review drop matches its evidence regardless of case, spacing and markup", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 1, evidence: "warm  WHITE light" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({
      find: () => textExecution(untrusted("https://a.test/x", "**Warm white**\nlight, 300 lm")),
    }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.dropped?.length).toBe(1);
});

test("a review drop of a number that names no first-pass issue is ignored", async () => {
  const adapter = hoverThenReport(reviewReport([{ issue: 3, evidence: "Warm white light" }]));
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect([result.dropped, result.disputed]).toStrictEqual([undefined, undefined]);
});

test("a blocked review report drops no first-pass issue", async () => {
  const adapter = hoverThenReport(
    reviewReport([{ issue: 1, evidence: "Warm white light, 300 lm" }], "blocked"),
  );
  const result = await runBrowse(
    adapter,
    fakeExecutor({ find: panelText }).executor,
    options({ mode: "review", found: FIRST_PASS }),
  );
  expect(result.dropped).toBeUndefined();
});
