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
import { askResultParts, renderAskStats, renderBrowseDetails } from "../ask/render.ts";
import { browsePages } from "../browse/browse-pages.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tab.ts";
import { describePage } from "../page/page.ts";
import { inSequence } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";
import { untrusted } from "../shared/output.ts";
import { describeNotLoaded, gatherDocuments } from "./ask-documents.ts";
import { clipToFile, defineTool, tabParam, type ToolDeps } from "./common.ts";
import { collectToolCallbacks } from "./callbacks.ts";

async function browsedTabNote(manager: BrowserManager, tab: Tab) {
  if (tab.page.isClosed())
    return `Browsing used tab ${tab.id} itself, and the tab has closed since.`;
  const shows = await describePage(tab.page);
  manager.markSeen(tab);
  return `Browsing used tab ${tab.id} itself, which stays where browsing left it: it now shows ${shows}, and controls on it may have changed (for example a toggle switched).`;
}

export function registerAskTools(server: McpServer, deps: ToolDeps) {
  const { store } = deps;

  defineTool(server, deps, {
    name: "ask_pages",
    title: "Ask a question over many pages",
    description: [
      "Answer one question over many pages (mode answer, default), or review how they look (mode review), without their content entering this conversation: a smaller model (Haiku by default, through the model adapter listed by tabs) reads them and returns short lines; the full answers, screenshots and raw replies are saved to the file named on the last line.",
      'Give exactly one source: files, dir (a save_pages folder), urls (saved first) or tabs. answer returns facts, each ending with its page, plus the pages with nothing relevant. review returns "- [high|medium|low] <page>, <where>: <issue>" lines sorted by severity; question is then the review brief and images default to full. For one or two pages, read_page or screenshot is simpler; against a reference image, use compare_design.',
      'A page with a URL or tab that the model could not answer from its text, or where the answer sits behind a control, is browsed by the same model (browse auto; off only reads; all browses every page): a tab in that same tab, which stays where browsing left it, other pages in a tab of their own. It clicks toggles and tabs, hovers, scrolls, searches and follows same-site links, but never signs in, submits, orders, pays, downloads or uploads. Its lines start with [browsed] and replace that page\'s lines; in review it drops an issue only by quoting page text, otherwise the issue stays marked "[browse disagreed, without evidence on the page]". Pages browsing could not finish are listed as not answered or partly answered. A line counting items on a page is checked against its Markdown or tab and marked "[count checked]" or "[count checked: 6, not 7]"; plain-text pages are not checked. Answers come from a fast model: verify facts a decision depends on.',
    ].join("\n"),
    output: {
      pages: z.number().int(),
      answers: z.array(z.string()).optional(),
      notes: z.array(z.string()).optional(),
      answersFile: z.string(),
      rawRepliesDir: z.string().optional(),
      screenshotsDir: z.string().optional(),
      nothingRelevant: z.array(z.string()).optional(),
      noIssues: z.array(z.string()).optional(),
      notAnswered: z.array(z.string()),
      partlyAnswered: z.array(z.string()),
      empty: z.array(z.string()),
      notLoaded: z.array(z.object({ url: z.string(), reason: z.string() })),
      browsed: z.array(
        z.object({
          source: z.string(),
          outcome: z.string(),
          steps: z.number().int(),
          toolCalls: z.number().int(),
          summary: z.string().optional(),
          tab: z.string().optional(),
        }),
      ),
    },
    payload: ["answers"],
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
          "A save_pages output folder; its .md files are used, or .txt where a page has no .md.",
        ),
      urls: z
        .array(z.string().min(1))
        .max(200)
        .optional()
        .describe("URLs to save as Markdown first (like save_pages) and then ask about."),
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
          "Output token limit per model call, thinking included. Default 128000; a call that hits it is reported as cut off.",
        ),
      images: z
        .enum(["none", "auto", "viewport", "full"])
        .optional()
        .describe(
          "Screenshots sent with the text of tabs and urls: auto (default in answer mode) only for pages that look visual, viewport for every page, full (default in review mode) as screen-sized tiles scrolled through the whole page, none for text only. Each image costs about as much as 6000 characters of text.",
        ),
      regions: z
        .array(
          z.strictObject({
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
      const { documents, locations, shots, imageLines, imageNotes, notLoaded, imageDir } =
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
      const notLoadedBlock = notLoaded.length
        ? `\n\n${notLoaded.map(describeNotLoaded).join("\n")}`
        : "";
      const unbrowsable = documents.filter(
        (document) => !locations.has(deps.redactor.redact(document.source)),
      ).length;
      const browsedTabs = browsed.flatMap((result) => locations.get(result.source)?.tab ?? []);
      const notes = [
        ...imageNotes,
        ...(browsing && input.browse && unbrowsable
          ? [
              `browse applies to pages with a URL or a tab, and ${unbrowsable} file page(s) have neither, so they were not browsed.`,
            ]
          : []),
        ...(await Promise.all(browsedTabs.map((tab) => browsedTabNote(deps.manager, tab)))),
      ];
      const notesBlock = notes.length ? `\n\n${notes.join("\n")}` : "";
      const parts = askResultParts(input.question, report);
      const answers = `${parts.text}${notLoadedBlock}`;
      const replies = report.batches.filter((batch) => batch.reply !== undefined);
      if (replies.length) await store.dir("ask", rawName);
      await inSequence(replies, (batch) =>
        store.write("ask", path.join(rawName, `call-${batch.index}.txt`), batch.reply ?? ""),
      );
      const rawLine = replies.length
        ? `\nRaw model replies: ${path.join(store.root, "ask", rawName)}`
        : "";
      const withRaw = `${answers}${notesBlock}\n\n${renderAskStats(report, adapter.name, model)}${imageFooter}${rawLine}`;
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
      const clipped = await clipToFile(store, "ask", "ask-answers", answers, 12_000);
      const framed = (shown: string) =>
        untrusted(
          `${documents.length} page(s), answered by ${adapter.name}`,
          `${shown}\n\nFull answers: ${file}`,
        );
      return {
        text: framed(`${clipped.text}${notesBlock}`),
        structuredText: clipped.file ? framed(clipped.text) : undefined,
        payloadFrame: (shown: string) => framed(`${parts.answersFrame(shown)}${notLoadedBlock}`),
        data: {
          answers: clipped.file ? undefined : parts.answers,
          notes: notes.length ? notes : undefined,
          pages: documents.length,
          answersFile: file,
          rawRepliesDir: replies.length ? path.join(store.root, "ask", rawName) : undefined,
          screenshotsDir: imageDir && prepared.length ? imageDir : undefined,
          ...(mode === "review"
            ? { noIssues: parts.noIssues }
            : { nothingRelevant: parts.nothingRelevant }),
          notAnswered: parts.notAnswered,
          partlyAnswered: parts.partlyAnswered,
          empty: report.empty,
          notLoaded,
          browsed: browsed.map((result) => ({
            source: result.source,
            outcome: result.outcome,
            steps: result.steps,
            toolCalls: result.toolCalls.length,
            summary: result.how ?? result.error,
            tab: locations.get(result.source)?.tab?.id,
          })),
        },
      };
    },
  });
}
