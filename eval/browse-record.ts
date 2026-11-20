import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startFixture } from "../e2e/fixture.ts";
import { type AskAdapter, loadAdapterModule } from "../src/ask.ts";
import { supportsTools } from "../src/ask-adapter.ts";
import { anthropicAskAdapter } from "../src/ask-anthropic.ts";
import { recordingAdapter } from "../src/browse-capture.ts";
import { loadConfig } from "../src/config.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";

const RECORDINGS = path.join(import.meta.dirname, "..", "e2e", "recordings");

const CASES = [
  { name: "pricing", path: "/browse/pricing", question: "What does each plan cost per year?", mode: "answer" },
  { name: "product", path: "/browse/product", question: "How heavy is the lamp?", mode: "answer" },
  { name: "tabs", path: "/browse/tabs", question: "How long is delivery?", mode: "answer" },
  { name: "cards", path: "/browse/cards", question: "Check the product cards for layout problems that show on hover", mode: "review", browse: "all" },
] as const;

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
        const name = CASES.find((entry) => opening.includes(`${entry.path}\n`))?.name ?? input.conversationId;
        adapter = record ? recordingAdapter(inner, path.join(RECORDINGS, `browse-${name}`)) : inner;
        conversations.set(input.conversationId, adapter);
      }
      if (!adapter.converse) throw new Error(`${inner.name} does not support tool use (no converse()).`);
      return adapter.converse(input);
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: { adapter: { type: "string" }, model: { type: "string", default: "haiku" }, "no-record": { type: "boolean", default: false } } });
  const inner: AskAdapter = values.adapter ? await loadAdapterModule(path.resolve(values.adapter)) : anthropicAskAdapter();
  if (!supportsTools(inner)) throw new Error(`${inner.name} has no converse(), so it cannot browse.`);
  const fixture = await startFixture();
  const workDir = await mkdtemp(path.join(tmpdir(), "web-agent-browse-record-"));
  const config = loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic" });
  const deps = createDeps(config, noSecrets, recordingRouter(inner, !values["no-record"]));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  const client = new Client({ name: "browse-record", version: "0" });
  await client.connect(clientTransport);
  try {
    for (const entry of CASES) {
      const result = await client.callTool(
        { name: "ask_pages", arguments: { question: entry.question, urls: [`${fixture.url}${entry.path}`], images: "none", mode: entry.mode, model: values.model, ...("browse" in entry ? { browse: entry.browse } : {}) } },
        undefined,
        { timeout: 900_000 },
      );
      const text = (result.content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("\n");
      const browsed = text.split("\n").filter((line) => /^\d\d-.*: \w+, \d+ steps, \d+ tool calls/.test(line));
      console.log(`${entry.name}: ${result.isError ? `error: ${text.split("\n")[0]}` : browsed.join("; ") || "not browsed"}`);
    }
  } finally {
    await client.close();
    await deps.manager.shutdown();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
