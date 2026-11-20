import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allBatchesFailed, type AskDocument, askPages, DEFAULT_BATCH_CHARS, DEFAULT_MAX_OUTPUT_TOKENS, modelId, renderAskResults, sourceNames } from "./ask.ts";
import { collectPages } from "./collect.ts";
import { ToolError } from "./errors.ts";
import { pageMarkdown } from "./markdown.ts";
import { untrusted } from "./output.ts";
import { DEFAULT_MAX_WAIT_MS, DEFAULT_QUIET_MS } from "./settle.ts";
import { clipToFile, defineTool, tabParam, type ToolDeps } from "./tools/common.ts";
import { registerTabTools } from "./tools/tabs.ts";
import { registerPageReadTools } from "./tools/page-read.ts";
import { registerActionTools } from "./tools/actions.ts";
import { registerNetworkTools } from "./tools/network.ts";
import { registerScriptTools } from "./tools/script.ts";
import { registerDataTools } from "./tools/data.ts";
import { registerSessionTools } from "./tools/session.ts";

export type { ToolDeps } from "./tools/common.ts";
export { cookieDomainMatches } from "./tools/data.ts";
export { evaluationSource } from "./tools/script.ts";

export function registerTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  registerTabTools(server, deps);
  registerPageReadTools(server, deps);
  registerActionTools(server, deps);
  registerNetworkTools(server, deps);
  registerScriptTools(server, deps);
  registerDataTools(server, deps);
  registerSessionTools(server, deps);

  defineTool(server, deps, {
    name: "ask_pages",
    title: "Ask a question over many pages",
    description: [
      "Answer one question over many pages without their content entering this conversation. The pages go to a smaller model (Claude Haiku by default) through the model adapter module configured with WEB_AGENT_ASK_ADAPTER, in a few large calls; each call returns short answer lines that name the page every fact came from, and this tool returns only those lines merged, the pages where nothing relevant was found, and any failed calls. The full answers are also saved to a file.",
      "Use it after collect_pages for comparisons, price or spec tables, or finding which pages mention something; give exactly one source of pages: files, dir (a collect_pages folder), urls (collected first), or tabs. The model sees only the page text, so it cannot click, follow links or check anything; for work that needs that, use run_script or a subagent. Answers are as reliable as a fast model reading quickly: verify the facts a decision depends on.",
      "There are no default limits: pages are not clipped, a call takes as many pages as fit about 3 million characters, and the output limit is the model maximum. Very large calls are slower and cost more (Haiku 5.5 prompts above 100K tokens are priced higher); lower batch_chars, max_chars_per_page or max_output_tokens to trade completeness for speed and cost. A call cut off at the output limit is listed with its partial answers.",
      "Empty pages are not sent and are listed as empty; pages cut to max_chars_per_page are listed as clipped. Pages with the same name are told apart by their path from a shared folder, or by a #2 suffix. Without a configured adapter it fails at once; tabs_list names the active adapter.",
    ].join("\n"),
    input: {
      question: z.string().min(3).max(4000).describe("The question, phrased so it can be answered from each page on its own, for example: What is the price and battery life of the laptop on this page?"),
      files: z.array(z.string().min(1)).max(500).optional().describe("Absolute paths of text or Markdown files to read."),
      dir: z.string().optional().describe("A collect_pages output folder; its .md files are used, or .txt where a page has no .md."),
      urls: z.array(z.string().min(1)).max(200).optional().describe("URLs to collect as Markdown first (like collect_pages) and then ask about."),
      tabs: z.array(tabParam).max(50).optional().describe("Open tabs whose current main content is read as Markdown."),
      batch_chars: z.number().int().min(5000).max(DEFAULT_BATCH_CHARS).optional().describe("Total page characters per model call; pages are packed in order until this is reached. Default 3000000, about what fits the model context, so most runs are one call; lower it for faster, cheaper parallel calls."),
      max_pages_per_batch: z.number().int().min(1).max(1000).optional().describe("Most pages in one model call. No limit by default."),
      max_chars_per_page: z.number().int().min(1000).max(DEFAULT_BATCH_CHARS).optional().describe("Longer pages keep their start and end and lose the middle. No clipping by default."),
      max_output_tokens: z.number().int().min(1000).max(DEFAULT_MAX_OUTPUT_TOKENS).optional().describe("Output token limit per model call, thinking included. Default 128000, the model's maximum; a call that hits it is reported as cut off."),
      concurrency: z.number().int().min(1).max(8).optional().describe("Model calls running at once. Default 4."),
      model: z.string().optional().describe("haiku (default), sonnet or opus, sent to the adapter as claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5; any other string is passed to the adapter unchanged."),
      timeout_ms: z.number().int().min(10_000).max(900_000).optional().describe("Time limit per model call in milliseconds. Default 180000."),
    },
    handler: async (input, owner) => {
      const given = [input.files, input.dir, input.urls, input.tabs].filter((value) => value !== undefined).length;
      if (given !== 1) throw new ToolError("Give exactly one of files, dir, urls, tabs.");
      const adapter = await deps.ask.get();
      const documents: AskDocument[] = [];
      if (input.files) {
        const names = sourceNames(input.files);
        for (const [index, file] of input.files.entries()) {
          const text = await readFile(file, "utf8").catch(() => undefined);
          if (text === undefined) throw new ToolError(`Cannot read ${file}.`, "Pass absolute paths of existing text files.");
          documents.push({ source: names[index] ?? path.basename(file), text });
        }
      } else if (input.dir || input.urls) {
        const dir = input.dir
          ? input.dir
          : (
              await collectPages(manager, store, owner, {
                urls: input.urls ?? [],
                include: ["markdown"],
                scope: "main",
                concurrency: 6,
                waitUntil: "domcontentloaded",
                settleMs: DEFAULT_QUIET_MS,
                maxWaitMs: DEFAULT_MAX_WAIT_MS,
                timeoutMs: 30_000,
                fullPage: false,
                previewChars: 0,
                label: "ask",
              })
            ).dir;
        const names = await readdir(dir).catch(() => undefined);
        if (!names) throw new ToolError(`Cannot read the folder ${dir}.`);
        const markdown = new Set(names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
        const picked = names.filter((name) => name.endsWith(".md") || (name.endsWith(".txt") && !markdown.has(name.slice(0, -4)))).sort();
        if (picked.length === 0) throw new ToolError(`No .md or .txt files in ${dir}.`, "Collect pages with include [\"markdown\"] or [\"text\"] first.");
        for (const name of picked) documents.push({ source: name, text: await readFile(path.join(dir, name), "utf8") });
      } else {
        for (const id of input.tabs ?? []) {
          const tab = manager.getTab(id);
          documents.push({ source: `${tab.id} ${tab.page.url()}`, text: await pageMarkdown(tab.page, "main") });
        }
      }
      if (documents.every((document) => !document.text.trim())) throw new ToolError(`All pages are empty: ${documents.map((document) => document.source).join(", ")}.`);

      const model = modelId(input.model ?? "haiku");
      const report = await askPages(adapter, {
        question: input.question,
        documents,
        batchChars: input.batch_chars ?? DEFAULT_BATCH_CHARS,
        maxPagesPerBatch: input.max_pages_per_batch,
        maxCharsPerPage: input.max_chars_per_page,
        concurrency: input.concurrency ?? 4,
        model,
        maxTokens: input.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        timeoutMs: input.timeout_ms ?? 180_000,
      });
      const rendered = renderAskResults(input.question, report, adapter.name, model);
      const file = await store.write("ask", store.uniqueName(input.question, "md"), `${rendered}\n\n<!-- raw -->\n${JSON.stringify(report, null, 2)}\n`);
      if (allBatchesFailed(report)) throw new ToolError(`Every model call failed, so no page was read.\n${rendered}`, `Full report: ${file}`);
      const body = `${await clipToFile(store, "ask", "ask-answers", rendered, 12_000)}\nFull answers: ${file}`;
      return untrusted(`${documents.length} page(s), answered by ${adapter.name}`, body);
    },
  });
}
