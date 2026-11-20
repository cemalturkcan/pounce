import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { allBatchesFailed, type AskDocument, askPages, AskSetupError, type BrowseSelection, DEFAULT_BATCH_CHARS, DEFAULT_MAX_OUTPUT_TOKENS, mergeBrowse, modelId, renderAskResults, renderBrowseDetails, selectEscalations, sourceNames } from "./ask.ts";
import { supportsTools } from "./ask-adapter.ts";
import type { Tab } from "./browser.ts";
import { TranscriptWriter } from "./browse-capture.ts";
import { openBrowseExecutor } from "./browse-executor.ts";
import { type BrowseResult, runBrowse } from "./browse-loop.ts";
import { browseFirstMessage, browseSystem } from "./browse-prompt.ts";
import { runPool } from "./async.ts";
import { capturePageImages, describePageImages, type PageImages } from "./ask-images.ts";
import { describeSent } from "./model-images.ts";
import { type CollectedPage, collectedBase, collectPages, normalizeUrl, serializedOpener } from "./collect.ts";
import { ToolError } from "./errors.ts";
import { pageMarkdown } from "./markdown.ts";
import { slugify, untrusted } from "./output.ts";
import { DEFAULT_MAX_WAIT_MS, DEFAULT_QUIET_MS } from "./settle.ts";
import { cancelled, clipToFile, defineTool, tabParam, type ToolDeps } from "./tools/common.ts";
import { registerTabTools } from "./tools/tabs.ts";
import { registerPageReadTools } from "./tools/page-read.ts";
import { registerActionTools } from "./tools/actions.ts";
import { registerNetworkTools } from "./tools/network.ts";
import { registerScriptTools } from "./tools/script.ts";
import { registerDataTools } from "./tools/data.ts";
import { registerSessionTools } from "./tools/session.ts";
import { registerVisualTools } from "./tools/visual.ts";

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
  registerVisualTools(server, deps);

  defineTool(server, deps, {
    name: "ask_pages",
    title: "Ask a question over many pages",
    description: [
      "Answer one question about many pages, or review how they look, without their content entering this conversation. The pages go to a smaller model (Claude Haiku by default) through the model adapter named by tabs_list, in a few large calls, and only short lines come back, merged across calls; the full answers are also saved to a file.",
      "mode answer (default) returns facts as lines that each end with the page they came from, plus the pages with nothing relevant. Use it for comparisons, price or spec tables, or finding which pages mention something, usually over a collect_pages folder, with a question each page can answer on its own. mode review checks the pages for visual and layout problems (overlapping or clipped elements, overflowing text, broken images, empty areas, misalignment, error messages) and returns one line per issue, \"- [high|medium|low] <page>, <where>: <issue>\", sorted by severity, plus the pages with no issues; question is then the review brief, and images default to full, so give urls or tabs. Use review for visual QA across many pages or routes; when a reference image exists, compare_design checks a page against it more exactly. For one or two pages, read_text or screenshot is simpler.",
      "Give exactly one source of pages: files, dir (a collect_pages folder), urls (collected first), or tabs. With tabs, urls, or a collect_pages folder, a page the model could not answer from its text, or where it saw the answer behind a control, is then browsed by the same model in its own tab: it can click toggles, tabs and 'show more' buttons, hover, scroll, search the site and follow same-site links, and its findings join the same answer lines. It only looks: it never signs in, submits forms, orders, pays, downloads or uploads, and page text cannot make it. browse off reads only; browse all browses every page, for example to check hover menus in review mode. Each browsed page is listed with its outcome and steps, and its transcript is saved next to the raw replies. Answers are as reliable as a fast model reading quickly: verify the facts a decision depends on.",
      "Screenshots: with tabs or urls, images auto (the default in answer mode) also sends a viewport screenshot of pages that look visual (little text for their size, mostly images, canvas, video or SVG, or no text), viewport sends one for every page, full scrolls through the whole page and sends one overlapping screen-sized tile per position, none sends text only; regions adds element screenshots by ref or selector. Images go into the same call as their page's text and findings read from them cite that page. The images are saved to files listed in the result, never returned inline; each image costs about as much as 6000 characters of text.",
      "There are no default limits: pages are not clipped, a call takes as many pages as fit about 3 million characters, the output limit is the model maximum, and a model call has no time limit (timeout_ms sets one; the client can always cancel). A call that exceeds the model's context window or the API request size limit is split in half and retried, down to single pages; a page too large on its own is reported as failed. Very large calls are slower and cost more (Haiku 5.5 prompts above 100K tokens are priced higher); lower batch_chars, max_chars_per_page or max_output_tokens to trade completeness for speed and cost. Browsing has no step or time limit by default; browse_max_steps and browse_timeout_ms set them. A call cut off at the output limit is listed with its partial answers.",
      "Empty pages are not sent and are listed as empty; pages cut to max_chars_per_page are listed as clipped; with urls, a page that failed to load is listed as \"Not loaded: <url> — <reason>\", and the call fails when none loaded. Pages with the same name are told apart by their path from a shared folder, or by a #2 suffix. Stored secrets in the page text are masked before it is sent. The raw reply of every model call is saved in a folder named in the result, next to the full answers.",
    ].join("\n"),
    input: {
      mode: z.enum(["answer", "review"]).optional().describe("answer (default) returns facts with their source page. review checks the pages for visual and layout problems and returns one line per issue, \"- [high|medium|low] <page>, <where>: <issue>\", sorted by severity, plus the pages with no issues; question is then the review brief, and images default to full."),
      question: z.string().min(3).max(4000).describe("In answer mode, the question, phrased so each page can answer it on its own. In review mode, the review brief: what to check, or simply the kind of problems to look for."),
      files: z.array(z.string().min(1)).max(500).optional().describe("Absolute paths of text or Markdown files to read."),
      dir: z.string().optional().describe("A collect_pages output folder; its .md files are used, or .txt where a page has no .md."),
      urls: z.array(z.string().min(1)).max(200).optional().describe("URLs to collect as Markdown first (like collect_pages) and then ask about."),
      tabs: z.array(tabParam).max(50).optional().describe("Open tabs whose current main content is read as Markdown."),
      batch_chars: z.number().int().min(5000).max(DEFAULT_BATCH_CHARS).optional().describe("Total page characters per model call; pages are packed in order until this is reached. Default 3000000, about what fits the model context, so most runs are one call; lower it for faster, cheaper parallel calls."),
      max_pages_per_batch: z.number().int().min(1).max(1000).optional().describe("Most pages in one model call. No limit by default."),
      max_chars_per_page: z.number().int().min(1000).max(DEFAULT_BATCH_CHARS).optional().describe("Longer pages keep their start and end and lose the middle. No clipping by default."),
      max_output_tokens: z.number().int().min(1000).max(DEFAULT_MAX_OUTPUT_TOKENS).optional().describe("Output token limit per model call, thinking included. Default 128000, the model's maximum; a call that hits it is reported as cut off."),
      images: z.enum(["none", "auto", "viewport", "full"]).optional().describe("Screenshots sent with the text of tabs and urls: auto (default in answer mode) only for pages that look visual, viewport for every page, full (default in review mode) as screen-sized tiles scrolled through the whole page, none for text only."),
      regions: z.array(z.object({ target: z.string().min(1).describe("Ref or selector of an element to capture on every page, such as a chart or a price box.") })).max(50).optional().describe("Element screenshots to send with each tab or url, in addition to images."),
      concurrency: z.number().int().min(1).max(8).optional().describe("Model calls running at once. Default 4."),
      model: z.string().optional().describe("haiku (default), sonnet or opus, sent to the adapter as claude-haiku-5-5, claude-sonnet-5-5 or claude-opus-5-5; any other string is passed to the adapter unchanged."),
      timeout_ms: z.number().int().min(10_000).max(900_000).optional().describe("Time limit per model call in milliseconds, browsing turns included. No limit by default; a call still ends when the client cancels the request."),
      browse: z.enum(["auto", "all", "off"]).optional().describe("auto (default) browses the pages the model could not answer from their text or where it saw the answer behind a control (in review mode, the parts it says need an interaction); all browses every page that was read; off only reads. Only pages with a URL or a tab are browsed, and only when the adapter supports tool use."),
      browse_sites: z.array(z.string().min(1)).max(50).optional().describe("Extra hosts browsing may follow links to, such as docs.example.com; each page's own site is always allowed."),
      browse_max_steps: z.number().int().min(1).max(500).optional().describe("Most model turns per browsed page; the last one asks for a report. No limit by default."),
      browse_timeout_ms: z.number().int().min(10_000).max(3_600_000).optional().describe("Time limit per browsed page in milliseconds; what was reported before it ran out is kept. No limit by default."),
    },
    handler: async (input, owner, signal, call) => {
      const given = [input.files, input.dir, input.urls, input.tabs].filter((value) => value !== undefined).length;
      if (given !== 1) throw new ToolError("Give exactly one of files, dir, urls, tabs.");
      const adapter = await deps.ask.get();
      const documents: AskDocument[] = [];
      const locations = new Map<string, { url: string; tab?: Tab }>();
      const locate = (source: string, url: string, tab?: Tab) => locations.set(deps.redactor.redact(source), { url, ...(tab ? { tab } : {}) });
      const headerUrl = (text: string) => /^<!-- URL: (\S+) · Status:/.exec(text)?.[1];
      const mode = input.mode ?? "answer";
      const imageMode = input.images ?? (mode === "review" ? "full" : "auto");
      const regions = input.regions ?? [];
      const wantsImages = imageMode !== "none" || regions.length > 0;
      const shots = new Map<string, PageImages>();
      const imageLines: string[] = [];
      const notLoaded: string[] = [];
      let imageDir: string | undefined;
      if (input.files) {
        const names = sourceNames(input.files);
        for (const [index, file] of input.files.entries()) {
          const text = await readFile(file, "utf8").catch(() => undefined);
          if (text === undefined) throw new ToolError(`Cannot read ${file}.`, "Pass absolute paths of existing text files.");
          const source = names[index] ?? path.basename(file);
          const url = headerUrl(text);
          if (url) locate(source, url);
          documents.push({ source, text });
        }
      } else if (input.dir || input.urls) {
        let dir = input.dir;
        let pages: CollectedPage[] | undefined;
        if (!dir) {
          const collected = await collectPages(manager, store, owner, {
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
            signal,
            capture: wantsImages
              ? async (tab, base, dir) => {
                  imageDir = dir;
                  const captured = await capturePageImages(manager, tab, { mode: imageMode, regions, source: `${base}.md`, dir, base });
                  shots.set(`${base}.md`, captured);
                  return captured.files.map((file) => path.basename(file));
                }
              : undefined,
          });
          if (signal.aborted) throw cancelled();
          dir = collected.dir;
          pages = collected.results;
          notLoaded.push(...collected.results.filter((result) => result.error).map((result) => `Not loaded: ${result.url} — ${result.error}`));
          if (collected.results.every((result) => result.error)) throw new ToolError(`No page loaded, so nothing was asked.\n${notLoaded.join("\n")}`);
        }
        const names = await readdir(dir).catch(() => undefined);
        if (!names) throw new ToolError(`Cannot read the folder ${dir}.`);
        const markdown = new Set(names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)));
        const picked = names.filter((name) => name.endsWith(".md") || (name.endsWith(".txt") && !markdown.has(name.slice(0, -4)))).sort();
        if (picked.length === 0) throw new ToolError(`No .md or .txt files in ${dir}.`, "Collect pages with include [\"markdown\"] or [\"text\"] first.");
        pages ??= await readFile(path.join(dir, "index.json"), "utf8")
          .then((raw) => JSON.parse(raw) as CollectedPage[])
          .catch(() => undefined);
        for (const page of pages ?? []) {
          if (page.error || !Number.isInteger(page.index) || typeof page.url !== "string") continue;
          const base = collectedBase(page);
          for (const name of [`${base}.md`, `${base}.txt`]) locate(name, page.finalUrl ?? page.url);
        }
        for (const name of picked) {
          const text = await readFile(path.join(dir, name), "utf8");
          const url = headerUrl(text);
          if (url && !locations.has(deps.redactor.redact(name))) locate(name, url);
          documents.push({ source: name, text, images: shots.get(name)?.images });
        }
      } else {
        for (const id of input.tabs ?? []) {
          const tab = manager.getTab(id);
          const source = `${tab.id} ${tab.page.url()}`;
          const text = await pageMarkdown(tab.page, "main");
          let images: PageImages | undefined;
          if (wantsImages) {
            imageDir ??= await store.dir("ask", store.uniqueName("screenshots", "dir").replace(/\.dir$/, ""));
            images = await capturePageImages(manager, tab, { mode: imageMode, regions, source, dir: imageDir, base: tab.id });
            shots.set(source, images);
          }
          locate(source, tab.page.url(), tab);
          documents.push({ source, text, images: images?.images });
        }
      }
      if ((input.files || input.dir) && (input.images === "viewport" || input.images === "full" || regions.length || mode === "review")) imageLines.push("images and regions apply to tabs and urls only, so no screenshots were sent.");
      for (const [source, captured] of shots) imageLines.push(...describePageImages(source, captured));
      if (documents.every((document) => !document.text.trim() && !document.images?.length)) throw new ToolError(`All pages are empty: ${documents.map((document) => document.source).join(", ")}.`);

      async function browsePages(chosen: BrowseSelection[], run: { owner: string; signal: AbortSignal; requestId: string; model: string; maxTokens: number; rawDir: string }) {
        const controller = new AbortController();
        const browseSignal = AbortSignal.any([run.signal, controller.signal]);
        const openTab = serializedOpener(manager, run.owner);
        const sites = input.browse_sites ?? [];
        let setupError: unknown;
        const results = await runPool(
          chosen,
          input.concurrency ?? 4,
          async (selection, index): Promise<BrowseResult> => {
            const location = locations.get(selection.source);
            const url = location?.url ?? "";
            const startedAt = Date.now();
            try {
              const executor = await openBrowseExecutor(deps, {
                owner: run.owner,
                requestId: run.requestId,
                sites,
                start: location?.tab ? { kind: "tab", tab: location.tab } : { kind: "open", url, openTab },
                signal: browseSignal,
              });
              const host = (() => {
                try {
                  return new URL(executor.startUrl).host;
                } catch {
                  return executor.startUrl;
                }
              })();
              return await runBrowse(adapter, executor, {
                mode,
                source: selection.source,
                url,
                system: browseSystem(mode),
                firstMessage: browseFirstMessage({ mode, source: selection.source, tab: executor.tabId, url: executor.startUrl, found: selection.found, hint: selection.hint, sites: [host, ...sites], question: input.question, maxSteps: input.browse_max_steps }),
                model: run.model,
                maxTokens: run.maxTokens,
                maxSteps: input.browse_max_steps,
                modelTimeoutMs: input.timeout_ms,
                pageTimeoutMs: input.browse_timeout_ms,
                signal: browseSignal,
                log: { requestId: run.requestId, page: selection.source, tab: executor.tabId, reason: selection.reason },
                capture: new TranscriptWriter(path.join(run.rawDir, `browse-${index + 1}-${slugify(selection.source, 40)}`)),
              });
            } catch (error) {
              if (error instanceof AskSetupError) {
                setupError ??= error;
                controller.abort();
              }
              const message = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
              return { source: selection.source, url: normalizeUrl(url), outcome: browseSignal.aborted ? "cancelled" : "failed", lines: [], steps: 0, toolCalls: [], ms: Date.now() - startedAt, error: message };
            }
          },
          browseSignal,
        );
        if (setupError) throw setupError;
        if (run.signal.aborted) throw cancelled();
        return results.filter((result): result is BrowseResult => result !== undefined);
      }

      const model = modelId(input.model ?? "haiku");
      const browseMode = input.browse ?? "auto";
      const browsing = browseMode !== "off" && supportsTools(adapter);
      const skipped = browseMode !== "off" && !browsing ? `Browsing skipped: the adapter ${adapter.name} does not support tool use (no converse()).` : undefined;
      const maxTokens = input.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
      const phaseOne = await askPages(adapter, {
        question: input.question,
        documents: documents.map((document) => ({ ...document, source: deps.redactor.redact(document.source), text: deps.redactor.redact(document.text) })),
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
      const selections = browsing ? selectEscalations(phaseOne, browseMode).filter((selection) => locations.has(selection.source)) : [];
      const browsed = selections.length
        ? await browsePages(selections, { owner, signal, requestId: call.requestId, model, maxTokens, rawDir: path.join(store.root, "ask", rawName) })
        : [];
      const report = browsing || skipped ? mergeBrowse(phaseOne, browsed, skipped) : phaseOne;
      const prepared = [...shots.values()].flatMap((captured) => captured.prepared);
      const sentLine = prepared.length ? `\n${describeSent(prepared)}` : "";
      const imageFooter = imageLines.length || prepared.length ? `\n\nScreenshots (${prepared.length} sent${imageDir && prepared.length ? `, files in ${imageDir}` : ""}):\n${imageLines.join("\n")}${sentLine}` : "";
      const notLoadedBlock = notLoaded.length ? `\n\n${notLoaded.join("\n")}` : "";
      const rendered = `${renderAskResults(input.question, report, adapter.name, model)}${notLoadedBlock}${imageFooter}`;
      const replies = report.batches.filter((batch) => batch.reply !== undefined);
      if (replies.length) await store.dir("ask", rawName);
      for (const batch of replies) await store.write("ask", path.join(rawName, `call-${batch.index}.txt`), batch.reply ?? "");
      const rawLine = replies.length ? `\nRaw model replies: ${path.join(store.root, "ask", rawName)}` : "";
      const withRaw = `${rendered}${rawLine}`;
      const reportJson = JSON.stringify({ ...report, batches: report.batches.map(({ reply: _reply, ...batch }) => batch) }, null, 2);
      const details = renderBrowseDetails(browsed);
      const file = await store.write("ask", answersName, `${withRaw}${details ? `\n\n${details}` : ""}\n\n<!-- raw -->\n${reportJson}\n`);
      if (allBatchesFailed(report)) throw new ToolError(`Every model call failed, so no page was read.\n${withRaw}`, `Full report: ${file}`);
      const body = `${await clipToFile(store, "ask", "ask-answers", rendered, 12_000)}${rawLine}\nFull answers: ${file}`;
      return untrusted(`${documents.length} page(s), answered by ${adapter.name}`, body);
    },
  });
}
