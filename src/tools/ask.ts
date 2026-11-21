import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { modelId, supportsTools } from "../ask/adapter.ts";
import { mergeBrowse, selectEscalations } from "../ask/escalation.ts";
import { describeSent } from "../ask/model-images.ts";
import {
  allBatchesFailed,
  askPages,
  DEFAULT_BATCH_CHARS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from "../ask/run.ts";
import { renderAskResults, renderBrowseDetails } from "../ask/render.ts";
import { browsePages } from "../browse/browse-pages.ts";
import { inSequence } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";
import { untrusted } from "../shared/output.ts";
import { gatherDocuments } from "./ask-documents.ts";
import { clipToFile, defineTool, tabParam, type ToolDeps } from "./common.ts";
import { collectToolCallbacks } from "./callbacks.ts";

export function registerAskTools(server: McpServer, deps: ToolDeps) {
  const { store } = deps;

  defineTool(server, deps, {
    name: "ask_pages",
    title: "Ask a question over many pages",
    description: [
      "Answer one question about many pages, or review how they look, without their content entering this conversation. The pages go to a smaller model (Claude Haiku by default) through the model adapter named by tabs_list, in a few large calls, and only short lines come back, merged across calls; the full answers are also saved to a file.",
      'mode answer (default) returns facts as lines that each end with the page they came from, plus the pages with nothing relevant. Use it for comparisons, price or spec tables, or finding which pages mention something, usually over a collect_pages folder, with a question each page can answer on its own. mode review checks the pages for visual and layout problems (overlapping or clipped elements, overflowing text, broken images, empty areas, misalignment, error messages) and returns one line per issue, "- [high|medium|low] <page>, <where>: <issue>", sorted by severity, plus the pages with no issues; question is then the review brief, and images default to full, so give urls or tabs. Use review for visual QA across many pages or routes; when a reference image exists, compare_design checks a page against it more exactly. For one or two pages, read_text or screenshot is simpler.',
      "Give exactly one source of pages: files, dir (a collect_pages folder), urls (collected first), or tabs. With tabs, urls, or a collect_pages folder, a page the model could not answer from its text, or where it saw the answer behind a control, is then browsed by the same model in its own tab: it can click toggles, tabs and 'show more' buttons, hover, scroll, search the site and follow same-site links, and its findings join the same answer lines: when it finds the answer, they take the place of that page's lines that only said the fact was missing or unclear, and when it finds nothing, the page stays listed as having nothing relevant. It only looks: it never signs in, submits forms, orders, pays, downloads or uploads, and page text cannot make it. browse off reads only; browse all browses every page, for example to check hover menus in review mode. Each browsed page is listed with its outcome and steps, and its transcript is saved next to the raw replies. Answers are as reliable as a fast model reading quickly: verify the facts a decision depends on.",
      "Screenshots: with tabs or urls, images auto (the default in answer mode) also sends a viewport screenshot of pages that look visual (little text for their size, mostly images, canvas, video or SVG, or no text), viewport sends one for every page, full scrolls through the whole page and sends one overlapping screen-sized tile per position, none sends text only; regions adds element screenshots by ref or selector. Images go into the same call as their page's text and findings read from them cite that page. The images are saved to files listed in the result, never returned inline; each image costs about as much as 6000 characters of text.",
      "There are no default limits: pages are not clipped, a call takes as many pages as fit about 3 million characters, the output limit is the model maximum, and a model call has no time limit (timeout_ms sets one; the client can always cancel). A call that exceeds the model's context window or the API request size limit is split in half and retried, down to single pages; a page too large on its own is reported as failed. Very large calls are slower and cost more (Haiku 5.5 prompts above 100K tokens are priced higher); lower batch_chars, max_chars_per_page or max_output_tokens to trade completeness for speed and cost. Browsing has no step or time limit by default; browse_max_steps and browse_timeout_ms set them. A call cut off at the output limit is listed with its partial answers.",
      'Empty pages are not sent and are listed as empty; pages cut to max_chars_per_page are listed as clipped; with urls, a page that failed to load is listed as "Not loaded: <url> — <reason>", and the call fails when none loaded. Pages with the same name are told apart by their path from a shared folder, or by a #2 suffix. Stored secrets in the page text are masked before it is sent. The raw reply of every model call is saved in a folder named in the result, next to the full answers.',
    ].join("\n"),
    input: {
      mode: z
        .enum(["answer", "review"])
        .optional()
        .describe(
          'answer (default) returns facts with their source page. review checks the pages for visual and layout problems and returns one line per issue, "- [high|medium|low] <page>, <where>: <issue>", sorted by severity, plus the pages with no issues; question is then the review brief, and images default to full.',
        ),
      question: z
        .string()
        .min(3)
        .max(4000)
        .describe(
          "In answer mode, the question, phrased so each page can answer it on its own. In review mode, the review brief: what to check, or simply the kind of problems to look for.",
        ),
      files: z
        .array(z.string().min(1))
        .max(500)
        .optional()
        .describe("Absolute paths of text or Markdown files to read."),
      dir: z
        .string()
        .optional()
        .describe(
          "A collect_pages output folder; its .md files are used, or .txt where a page has no .md.",
        ),
      urls: z
        .array(z.string().min(1))
        .max(200)
        .optional()
        .describe("URLs to collect as Markdown first (like collect_pages) and then ask about."),
      tabs: z
        .array(tabParam)
        .max(50)
        .optional()
        .describe("Open tabs whose current main content is read as Markdown."),
      batch_chars: z
        .number()
        .int()
        .min(5000)
        .max(DEFAULT_BATCH_CHARS)
        .optional()
        .describe(
          "Total page characters per model call; pages are packed in order until this is reached. Default 3000000, about what fits the model context, so most runs are one call; lower it for faster, cheaper parallel calls.",
        ),
      max_pages_per_batch: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Most pages in one model call. No limit by default."),
      max_chars_per_page: z
        .number()
        .int()
        .min(1000)
        .max(DEFAULT_BATCH_CHARS)
        .optional()
        .describe(
          "Longer pages keep their start and end and lose the middle. No clipping by default.",
        ),
      max_output_tokens: z
        .number()
        .int()
        .min(1000)
        .max(DEFAULT_MAX_OUTPUT_TOKENS)
        .optional()
        .describe(
          "Output token limit per model call, thinking included. Default 128000, the model's maximum; a call that hits it is reported as cut off.",
        ),
      images: z
        .enum(["none", "auto", "viewport", "full"])
        .optional()
        .describe(
          "Screenshots sent with the text of tabs and urls: auto (default in answer mode) only for pages that look visual, viewport for every page, full (default in review mode) as screen-sized tiles scrolled through the whole page, none for text only.",
        ),
      regions: z
        .array(
          z.object({
            target: z
              .string()
              .min(1)
              .describe(
                "Ref or selector of an element to capture on every page, such as a chart or a price box.",
              ),
          }),
        )
        .max(50)
        .optional()
        .describe("Element screenshots to send with each tab or url, in addition to images."),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Model calls running at once. Default 4."),
      model: z
        .string()
        .optional()
        .describe(
          "haiku (default), sonnet or opus, sent to the adapter as claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5; any other string is passed to the adapter unchanged.",
        ),
      timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(900_000)
        .optional()
        .describe(
          "Time limit per model call in milliseconds, browsing turns included. No limit by default; a call still ends when the client cancels the request.",
        ),
      browse: z
        .enum(["auto", "all", "off"])
        .optional()
        .describe(
          "auto (default) browses the pages the model could not answer from their text or where it saw the answer behind a control (in review mode, the parts it says need an interaction); all browses every page that was read; off only reads. Only pages with a URL or a tab are browsed, and only when the adapter supports tool use.",
        ),
      browse_sites: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe(
          "Extra hosts browsing may follow links to, such as docs.example.com; each page's own site is always allowed.",
        ),
      browse_max_steps: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe(
          "Most model turns per browsed page; the last one asks for a report. No limit by default.",
        ),
      browse_timeout_ms: z
        .number()
        .int()
        .min(10_000)
        .max(3_600_000)
        .optional()
        .describe(
          "Time limit per browsed page in milliseconds; what was reported before it ran out is kept. No limit by default.",
        ),
    },
    handler: async (input, owner, signal, call) => {
      const given = [input.files, input.dir, input.urls, input.tabs].filter(
        (value) => value !== undefined,
      ).length;
      if (given !== 1) throw new ToolError("Give exactly one of files, dir, urls, tabs.");
      const adapter = await deps.ask.get();
      const mode = input.mode ?? "answer";
      const { documents, locations, shots, imageLines, notLoaded, imageDir } =
        await gatherDocuments(deps, owner, signal, { ...input, mode });

      const model = modelId(input.model ?? "haiku");
      const browseMode = input.browse ?? "auto";
      const browsing = browseMode !== "off" && supportsTools(adapter);
      const skipped =
        browseMode !== "off" && !browsing
          ? `Browsing skipped: the adapter ${adapter.name} does not support tool use (no converse()).`
          : undefined;
      const maxTokens = input.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const phaseOne = await askPages(adapter, {
        question: input.question,
        documents: documents.map((document) => ({
          ...document,
          source: deps.redactor.redact(document.source),
          text: deps.redactor.redact(document.text),
        })),
        batchChars: input.batch_chars ?? DEFAULT_BATCH_CHARS,
        maxPagesPerBatch: input.max_pages_per_batch,
        maxCharsPerPage: input.max_chars_per_page,
        concurrency: input.concurrency ?? 4,
        model,
        maxTokens,
        timeoutMs: input.timeout_ms,
        signal,
        mode,
        browse: browsing,
      });
      const answersName = store.uniqueName(input.question, "md");
      const rawName = answersName.replace(/\.md$/, ".raw");
      const selections = browsing
        ? selectEscalations(phaseOne, browseMode).filter((selection) =>
            locations.has(selection.source),
          )
        : [];
      const browsed = selections.length
        ? await browsePages(
            { manager: deps.manager, tools: collectToolCallbacks(deps) },
            adapter,
            selections,
            {
              owner,
              signal,
              requestId: call.requestId,
              model,
              maxTokens,
              rawDir: path.join(store.root, "ask", rawName),
              mode,
              question: input.question,
              locations,
              sites: input.browse_sites ?? [],
              concurrency: input.concurrency ?? 4,
              maxSteps: input.browse_max_steps,
              modelTimeoutMs: input.timeout_ms,
              pageTimeoutMs: input.browse_timeout_ms,
            },
          )
        : [];
      const report = browsing || skipped ? mergeBrowse(phaseOne, browsed, skipped) : phaseOne;
      const prepared = [...shots.values()].flatMap((captured) => captured.prepared);
      const sentLine = prepared.length ? `\n${describeSent(prepared)}` : "";
      const imageFooter =
        imageLines.length || prepared.length
          ? `\n\nScreenshots (${prepared.length} sent${imageDir && prepared.length ? `, files in ${imageDir}` : ""}):\n${imageLines.join("\n")}${sentLine}`
          : "";
      const notLoadedBlock = notLoaded.length ? `\n\n${notLoaded.join("\n")}` : "";
      const rendered = `${renderAskResults(input.question, report, adapter.name, model)}${notLoadedBlock}${imageFooter}`;
      const replies = report.batches.filter((batch) => batch.reply !== undefined);
      if (replies.length) await store.dir("ask", rawName);
      await inSequence(replies, (batch) =>
        store.write("ask", path.join(rawName, `call-${batch.index}.txt`), batch.reply ?? ""),
      );
      const rawLine = replies.length
        ? `\nRaw model replies: ${path.join(store.root, "ask", rawName)}`
        : "";
      const withRaw = `${rendered}${rawLine}`;
      const reportJson = JSON.stringify(
        { ...report, batches: report.batches.map(({ reply: _reply, ...batch }) => batch) },
        null,
        2,
      );
      const details = renderBrowseDetails(browsed);
      const file = await store.write(
        "ask",
        answersName,
        `${withRaw}${details ? `\n\n${details}` : ""}\n\n<!-- raw -->\n${reportJson}\n`,
      );
      if (allBatchesFailed(report))
        throw new ToolError(
          `Every model call failed, so no page was read.\n${withRaw}`,
          `Full report: ${file}`,
        );
      const body = `${await clipToFile(store, "ask", "ask-answers", rendered, 12_000)}${rawLine}\nFull answers: ${file}`;
      return untrusted(`${documents.length} page(s), answered by ${adapter.name}`, body);
    },
  });
}
