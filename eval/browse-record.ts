import path from "node:path";
import { parseArgs } from "node:util";
import { startFixture } from "../e2e/fixture.ts";
import { supportsTools, type AskAdapter } from "../src/ask/adapter.ts";
import { anthropicAskAdapter } from "../src/ask/anthropic/adapter.ts";
import { inSequence } from "../src/shared/async.ts";
import { recordingAdapter } from "../src/browse/transcript.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { loadAdapterModule } from "../src/ask/adapter-source.ts";
import { startMcpHarness } from "../tests/mcpHarness.ts";

const RECORDINGS = path.join(import.meta.dirname, "..", "e2e", "recordings");

const CASES = [
  {
    name: "pricing",
    path: "/browse/pricing",
    question: "What does each plan cost per year?",
    mode: "answer",
  },
  { name: "product", path: "/browse/product", question: "How heavy is the lamp?", mode: "answer" },
  { name: "tabs", path: "/browse/tabs", question: "How long is delivery?", mode: "answer" },
  {
    name: "cards",
    path: "/browse/cards",
    question: "Check the product cards for layout problems that show on hover",
    mode: "review",
    browse: "all",
  },
] as const;

type AskPagesArguments = {
  question: string;
  urls: string[];
  images: string;
  mode: string;
  model?: string;
  browse?: string;
};

const noSecrets: SecretStore = { backend: "none", list: async () => [], get: async () => "" };

function recordingRouter(inner: AskAdapter, record: boolean): AskAdapter {
  const conversations = new Map<string, AskAdapter>();
  return {
    name: inner.name,
    complete: (input) => inner.complete(input),
    converse: async (input) => {
      let adapter = conversations.get(input.conversationId);
      if (!adapter) {
        const first = input.messages[0]?.content[0];
        const opening = first?.type === "text" ? first.text : "";
        const name =
          CASES.find((entry) => opening.includes(`${entry.path}\n`))?.name ?? input.conversationId;
        adapter = record ? recordingAdapter(inner, path.join(RECORDINGS, `browse-${name}`)) : inner;
        conversations.set(input.conversationId, adapter);
      }
      if (!adapter.converse)
        throw new Error(`${inner.name} does not support tool use (no converse()).`);
      return adapter.converse(input);
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string" },
      model: { type: "string", default: "haiku" },
      "no-record": { type: "boolean", default: false },
    },
  });
  const inner: AskAdapter = values.adapter
    ? await loadAdapterModule(path.resolve(values.adapter))
    : anthropicAskAdapter();
  if (!supportsTools(inner))
    throw new Error(`${inner.name} has no converse(), so it cannot browse.`);
  const fixture = await startFixture();
  const mcp = await startMcpHarness({
    name: "browse-record",
    secrets: noSecrets,
    askAdapter: recordingRouter(inner, !values["no-record"]),
  });
  try {
    await inSequence(CASES, async (entry) => {
      const args: AskPagesArguments = {
        question: entry.question,
        urls: [`${fixture.url}${entry.path}`],
        images: "none",
        mode: entry.mode,
        model: values.model,
      };
      if ("browse" in entry) args.browse = entry.browse;
      const result = await mcp.call("ask_pages", args, { timeout: 900_000 });
      const { text } = result;
      const browsed = text
        .split("\n")
        .filter((line) => /^\d\d-.*: \w+, \d+ steps, \d+ tool calls/.test(line));
      process.stdout.write(
        `${entry.name}: ${result.isError ? `error: ${text.split("\n")[0]}` : browsed.join("; ") || "not browsed"}\n`,
      );
    });
  } finally {
    await mcp.close();
    await fixture.close();
  }
}

if (import.meta.main) await main();
