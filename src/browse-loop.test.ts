import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { z } from "zod";
import type { AskAssistantBlock, AskMessage, AskToolResultBlock, ConverseInput, ConverseReply } from "./ask-adapter.ts";
import { AskSetupError } from "./ask.ts";
import { scriptedAdapter, type ScriptStep } from "./ask-script.ts";
import { TranscriptWriter } from "./browse-capture.ts";
import { type BrowseExecutor, type BrowseOptions, runBrowse, type ToolExecution, validateWith } from "./browse-loop.ts";

let dir = "";
before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-loop-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SCHEMAS = {
  find: z.strictObject({ query: z.string() }),
  click: z.strictObject({ target: z.string(), tab: z.string().optional() }),
  screenshot: z.strictObject({ target: z.string().optional() }),
} as const;

type Handler = (input: Record<string, unknown>, signal: AbortSignal) => ToolExecution | Promise<ToolExecution>;

const text = (value: string, isError = false): ToolExecution => ({ content: [{ type: "text", text: value }], isError });

function fakeExecutor(handlers: Partial<Record<keyof typeof SCHEMAS, Handler>> = {}) {
  const runs: { name: string; input: unknown }[] = [];
  let closes = 0;
  let note: string | undefined;
  const executor: BrowseExecutor = {
    tools: Object.entries(SCHEMAS).map(([name, schema]) => ({ name, description: name, inputSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> })),
    validate: (name, input) => validateWith(SCHEMAS[name as keyof typeof SCHEMAS], input),
    run: async (name, input, signal) => {
      runs.push({ name, input });
      const handler = handlers[name as keyof typeof SCHEMAS];
      return handler ? handler(input as Record<string, unknown>, signal) : text(`${name} ok`);
    },
    newTabsNote: () => {
      const current = note;
      note = undefined;
      return current;
    },
    currentUrl: () => "https://a.test/x/specs",
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

const use = (id: string, name: string, input: unknown): AskAssistantBlock => ({ type: "tool_use", id, name, input });
const turn = (content: AskAssistantBlock[], stopReason = "tool_use", usage: Record<string, number> = { input_tokens: 10, output_tokens: 5 }): ScriptStep => () => ({ content, stopReason, usage });
const reportFound = (id = "r", lines = ["Acme Pro costs 96 € per year"]) => use(id, "report", { status: "found", lines, how: "switched the toggle" });

function lastResults(input: ConverseInput) {
  const last = input.messages.at(-1);
  assert.equal(last?.role, "user");
  return (last?.content ?? []) as AskMessage["content"];
}

function resultText(block: unknown) {
  const result = block as AskToolResultBlock;
  return result.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

test("1: find then report ends found with the reported lines, two steps and summed usage, and a two-line transcript", async () => {
  const adapter = scriptedAdapter([turn([use("a", "find", { query: "Yearly" })]), turn([reportFound()])]);
  const { executor } = fakeExecutor();
  const capture = new TranscriptWriter(path.join(dir, "one"));
  const result = await runBrowse(adapter, executor, options({ capture }));
  assert.equal(result.outcome, "found");
  assert.deepEqual(result.lines, ["Acme Pro costs 96 € per year"]);
  assert.equal(result.how, "switched the toggle");
  assert.equal(result.steps, 2);
  assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 10 });
  assert.deepEqual(result.toolCalls, [{ name: "find", target: "Yearly" }]);
  assert.equal(result.finalUrl, "https://a.test/x/specs");
  assert.equal(result.transcript, path.join(dir, "one"));
  const lines = (await readFile(path.join(dir, "one", "turns.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(adapter.problems, []);
});

test("2: several tool calls in one turn run in order and are answered together in one message", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "find", { query: "one" }), use("b", "click", { target: "e1" }), use("c", "screenshot", {})]),
    (input) => {
      const content = lastResults(input);
      assert.deepEqual(
        content.map((block) => (block.type === "tool_result" ? block.toolUseId : block.type)),
        ["a", "b", "c"],
      );
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.deepEqual(runs.map((run) => run.name), ["find", "click", "screenshot"]);
  assert.equal(result.outcome, "found");
  assert.deepEqual(adapter.problems, []);
});

test("3: a tool that throws becomes an error result and the loop goes on", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e1" })]),
    (input) => {
      const [block] = lastResults(input);
      assert.equal((block as AskToolResultBlock).isError, true);
      assert.match(resultText(block), /element is gone/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({
    click: () => {
      throw new Error("element is gone");
    },
  });
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "found");
  assert.equal(result.toolCalls[0]?.error, "element is gone");
});

test("4: an unknown tool is an error that lists the tools, and the executor is not called", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "run_script", { code: "x" })]),
    (input) => {
      const [block] = lastResults(input);
      assert.equal((block as AskToolResultBlock).isError, true);
      assert.equal(resultText(block), "Unknown tool run_script. Tools: find, click, screenshot, report.");
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  await runBrowse(adapter, executor, options());
  assert.equal(runs.length, 0);
});

test("5: invalid input names the path, and the executor is not called", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", {}), use("b", "click", { target: "e1", force: true })]),
    (input) => {
      const [missing, extra] = lastResults(input);
      assert.match(resultText(missing), /^Invalid input: target: /);
      assert.match(resultText(extra), /force/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  await runBrowse(adapter, executor, options());
  assert.equal(runs.length, 0);
});

test("6: a guard refusal is reported as refused and recorded as blocked", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e9" })]),
    (input) => {
      const [block] = lastResults(input);
      assert.equal((block as AskToolResultBlock).isError, true);
      assert.equal(resultText(block), "Refused: the button \"Buy now\" would buy something. This path is closed; look for the information another way or report what you have.");
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({ click: () => ({ content: [], isError: true, blocked: "the button \"Buy now\" would buy something" }) });
  const result = await runBrowse(adapter, executor, options());
  assert.deepEqual(result.toolCalls, [{ name: "click", target: "e9", blocked: "the button \"Buy now\" would buy something" }]);
});

test("7: a reply cut off at max_tokens runs none of its tools, is not appended and ends cut_off", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })], "max_tokens")]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options({ maxTokens: 2000 }));
  assert.equal(result.outcome, "cut_off");
  assert.match(result.error ?? "", /raise max_output_tokens/);
  assert.equal(runs.length, 0);
  assert.equal(adapter.calls.length, 1);
});

test("8: a refusal with a partial tool call runs nothing and ends refused", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })], "refusal")]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "refused");
  assert.equal(runs.length, 0);
});

test("9: an end_turn without report gets one nudge as a new user message, the second ends no_report", async () => {
  const adapter = scriptedAdapter([
    turn([{ type: "text", text: "I think it is 96 €" }], "end_turn"),
    (input) => {
      const last = input.messages.at(-1);
      assert.deepEqual(last, { role: "user", content: [{ type: "text", text: "Call report now with what you found, or status not_found." }] });
      return { content: [{ type: "text", text: "still no report" }], stopReason: "end_turn" };
    },
  ]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "no_report");
  assert.deepEqual(result.lines, []);
  assert.deepEqual(adapter.problems, []);
});

test("10: pause_turn is appended and re-sent without a new user message, at most five times in a row", async () => {
  const pause = turn([{ type: "opaque", raw: { type: "server_tool_use", id: "s1" } }], "pause_turn");
  const adapter = scriptedAdapter([pause, pause, pause, pause, pause, pause, pause]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "failed");
  assert.equal(adapter.calls.length, 6);
  assert.equal(adapter.calls[1]?.messages.at(-1)?.role, "assistant");
  assert.equal(adapter.calls[1]?.messages.length, 2);
  assert.deepEqual(adapter.problems, []);
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
  assert.equal(result.outcome, "cancelled");
  assert.equal(adapter.calls.length, 1);
  assert.equal(closes(), 1);
});

test("12: history stays append-only over four turns, with an empty thinking block sent back unchanged", async () => {
  const thinking: AskAssistantBlock = { type: "opaque", raw: { type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" } };
  const adapter = scriptedAdapter([
    turn([thinking, use("a", "find", { query: "Yearly" })]),
    turn([thinking, { type: "text", text: "clicking", raw: { type: "text", text: "clicking" } }, use("b", "click", { target: "e2" })]),
    turn([thinking, use("c", "screenshot", {})]),
    (input) => {
      assert.deepEqual(input.messages[1], { role: "assistant", content: [thinking, use("a", "find", { query: "Yearly" })] });
      return { content: [thinking, reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "found");
  assert.equal(adapter.calls.length, 4);
  assert.equal(adapter.calls[3]?.messages.length, 7);
  assert.deepEqual(adapter.problems, []);
});

test("13: report in the same turn as a click ends the loop without running the click", async () => {
  const adapter = scriptedAdapter([turn([reportFound("r"), use("b", "click", { target: "e1" })])]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "found");
  assert.equal(runs.length, 0);
});

test("14: a step limit sends one final nudge and then ends step_limit", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "find", { query: "x" })]),
    turn([use("b", "find", { query: "y" })]),
    (input) => {
      const last = lastResults(input);
      assert.deepEqual(last.at(-1), { type: "text", text: "Step limit reached: call report now." });
      return { content: [use("c", "find", { query: "z" })], stopReason: "tool_use" };
    },
  ]);
  const { executor, runs } = fakeExecutor();
  const result = await runBrowse(adapter, executor, options({ maxSteps: 2 }));
  assert.equal(result.outcome, "step_limit");
  assert.equal(adapter.calls.length, 3);
  assert.equal(runs.length, 2);
});

test("15: the same call with no change gets a note on the third time and ends no_report on the sixth", async () => {
  const click: ScriptStep = (input, index) => turn([use(`c${index}`, "click", { target: "e1" })])(input, index);
  const steps: ScriptStep[] = Array.from({ length: 6 }, () => click);
  steps[3] = (input) => {
    const last = lastResults(input);
    assert.deepEqual(last.at(-1), { type: "text", text: "This is the third identical call with no change; try something else or call report." });
    return click(input, 3) as ConverseReply;
  };
  const adapter = scriptedAdapter(steps);
  const { executor, runs } = fakeExecutor({ click: () => text("Clicked e1.\nNo change detected on the page.") });
  const result = await runBrowse(adapter, executor, options());
  assert.equal(result.outcome, "no_report");
  assert.equal(runs.length, 6);
});

test("16: a screenshot result goes back as text and image", async () => {
  const image = { mediaType: "image/jpeg" as const, data: "/9j/AAAA" };
  const adapter = scriptedAdapter([
    turn([use("a", "screenshot", { target: "e4" })]),
    (input) => {
      const [block] = lastResults(input);
      assert.deepEqual((block as AskToolResultBlock).content, [{ type: "text", text: "Screenshot saved to /tmp/x.jpg" }, { type: "image", image }]);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  const { executor } = fakeExecutor({ screenshot: () => ({ content: [{ type: "text", text: "Screenshot saved to /tmp/x.jpg" }, { type: "image", image }], isError: false }) });
  assert.equal((await runBrowse(adapter, executor, options())).outcome, "found");
});

test("17: a setup error from the adapter is rethrown after the tabs are closed", async () => {
  const adapter = scriptedAdapter([() => new AskSetupError("no credentials")]);
  const { executor, closes } = fakeExecutor();
  await assert.rejects(runBrowse(adapter, executor, options()), AskSetupError);
  assert.equal(closes(), 1);
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
  const timed = await runBrowse(scriptedAdapter([slow]), fakeExecutor().executor, options({ modelTimeoutMs: 30 }));
  assert.equal(timed.outcome, "timed_out");
  const failed = await runBrowse(scriptedAdapter([turn([use("a", "click", { target: "e1" })], "interrupted")]), fakeExecutor().executor, options());
  assert.equal(failed.outcome, "failed");
});

test("an invalid report is an error result and the turn goes on", async () => {
  const adapter = scriptedAdapter([
    turn([use("a", "report", { status: "great", lines: [] })]),
    (input) => {
      const [block] = lastResults(input);
      assert.match(resultText(block), /status/);
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  assert.equal((await runBrowse(adapter, fakeExecutor().executor, options())).outcome, "found");
});

test("a review report returns its issues", async () => {
  const adapter = scriptedAdapter([turn([use("a", "report", { status: "found", issues: [{ severity: "high", where: "card 2 details (hover)", issue: "text overflows" }], how: "hovered card 2" })])]);
  const result = await runBrowse(adapter, fakeExecutor().executor, options({ mode: "review" }));
  assert.deepEqual(result.issues, [{ severity: "high", where: "card 2 details (hover)", issue: "text overflows" }]);
});

test("a page timeout ends the loop timed_out", async () => {
  const adapter = scriptedAdapter([turn([use("a", "click", { target: "e1" })])]);
  const alive = setInterval(() => undefined, 1000);
  const { executor } = fakeExecutor({ click: () => new Promise<ToolExecution>(() => undefined) });
  const result = await runBrowse(adapter, executor, options({ pageTimeoutMs: 50 })).finally(() => clearInterval(alive));
  assert.equal(result.outcome, "timed_out");
});

test("a popup note from the executor follows the tool results", async () => {
  const fake = fakeExecutor({
    click: () => {
      fake.setNote("New tab t9 opened: https://a.test/y. Pass tab t9 to work in it.");
      return text("Clicked e1.\nThe page changed.");
    },
  });
  const adapter = scriptedAdapter([
    turn([use("a", "click", { target: "e1" })]),
    (input) => {
      assert.deepEqual(lastResults(input).at(-1), { type: "text", text: "New tab t9 opened: https://a.test/y. Pass tab t9 to work in it." });
      return { content: [reportFound()], stopReason: "tool_use" };
    },
  ]);
  assert.equal((await runBrowse(adapter, fake.executor, options())).outcome, "found");
});

test("the transcript folder holds the system prompt and tool definitions", async () => {
  const adapter = scriptedAdapter([turn([reportFound()])]);
  await runBrowse(adapter, fakeExecutor().executor, options({ capture: new TranscriptWriter(path.join(dir, "files")) }));
  assert.deepEqual((await readdir(path.join(dir, "files"))).sort(), ["result.json", "system.txt", "tools.json", "turns.jsonl"]);
});
