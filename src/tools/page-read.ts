import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractPage, summarizeStructured, toCsv } from "../extract.ts";
import { elementMarkdown, pageMarkdown } from "../markdown.ts";
import { clipWindow, untrusted } from "../output.ts";
import { pageText, rawSnapshot, renderSnapshot } from "../page.ts";
import { buildMatcher, findInSnapshot } from "../snapshot.ts";
import { clipToFile, defineTool, INLINE_SCREENSHOT_MAX_HEIGHT, tabParam, targetParam, type ToolDeps } from "./common.ts";

export function registerPageReadTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "snapshot",
    title: "Page snapshot",
    description:
      "Return the accessibility tree of the page as indented text. Each element carries a ref like [ref=e12] that click, fill and the other action tools accept as `target`; iframe content is included with refs like f1e3. This is the main way to see a page and to address elements. Refs stay valid until the page changes. With target, the whole page is still snapshotted and only that element's subtree is returned, so refs from earlier snapshots of the page keep working. Output above max_chars is cut in the middle and the full tree is saved to a file whose path is returned.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Return only this element's subtree (ref or selector); refs elsewhere on the page stay valid."),
      depth: z.number().int().min(1).max(50).optional().describe("Maximum tree depth to include, counted from target when one is given."),
      interactive: z.boolean().optional().describe("Return only a flat list of interactive elements (buttons, links, inputs). Much smaller. Default false."),
      boxes: z.boolean().optional().describe("Append each element's viewport rectangle as [box=x,y,width,height], to relate refs to a screenshot. Default false."),
      max_chars: z.number().int().min(500).max(200_000).optional().describe("Character budget for the result. Default 20000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const body = await renderSnapshot(manager, store, tab, {
        target: input.target,
        depth: input.depth,
        interactive: input.interactive,
        boxes: input.boxes,
        maxChars: input.max_chars ?? 20_000,
      });
      return untrusted(tab.page.url(), body);
    },
  });

  defineTool(server, deps, {
    name: "find",
    title: "Find in page",
    description:
      "Search the page's accessibility tree and return only the matching lines, each with its ref and its ancestor lines for context. Cheaper than a full snapshot when you know what you are looking for. Matching is case-insensitive substring by default.",
    input: {
      tab: tabParam,
      query: z.string().min(1).describe("Text to look for in element roles, names and values, for example \"Add to cart\" or \"textbox\"."),
      regex: z.boolean().optional().describe("Treat query as a case-insensitive regular expression. Default false."),
      max_results: z.number().int().min(1).max(200).optional().describe("Maximum matches to return. Default 30."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const snapshot = await rawSnapshot(manager, tab, {});
      const found = findInSnapshot(snapshot, buildMatcher(input.query, input.regex ?? false), input.max_results ?? 30);
      if (found.matches === 0) return `No match for ${JSON.stringify(input.query)} on ${tab.page.url()}.`;
      const note = found.matches > found.shown ? ` (showing ${found.shown}; narrow the query or raise max_results)` : "";
      return untrusted(tab.page.url(), `${found.matches} matches${note}:\n${found.text}`);
    },
  });

  defineTool(server, deps, {
    name: "read_text",
    title: "Read page text",
    description:
      "Return the visible text of the page or of one element, as plain text or as Markdown, without refs. Use it to read articles, documentation, tables or results; use snapshot when you need to act on elements. Markdown keeps headings, lists, links with their URLs, code blocks and tables, and leaves out navigation, footers, sidebars, scripts and hidden elements. Long text is paged: the result says how many characters exist and the offset to pass for the next page.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Read only this element's text (ref or selector)."),
      scope: z.enum(["main", "page"]).optional().describe("main returns the main content area when the page marks one, skipping navigation and footers; page returns everything. Default page. Ignored when target is set."),
      format: z.enum(["text", "markdown"]).optional().describe("text is the rendered text as the user sees it; markdown keeps structure and link URLs. Default text."),
      offset: z.number().int().min(0).optional().describe("Character offset to start from. Default 0."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Characters to return. Default 12000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const scope = input.scope ?? "page";
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      const text =
        input.format === "markdown"
          ? locator
            ? await elementMarkdown(locator)
            : await pageMarkdown(tab.page, scope)
          : locator
            ? await locator.innerText()
            : await pageText(tab.page, scope);
      const window = clipWindow(text, input.offset ?? 0, input.max_chars ?? 12_000);
      const footer = window.hasMore
        ? `\n[chars ${window.start}-${window.end} of ${window.totalChars}; pass offset=${window.end} for more]`
        : `\n[chars ${window.start}-${window.end} of ${window.totalChars}; end of text]`;
      return untrusted(tab.page.url(), window.text + footer);
    },
  });

  defineTool(server, deps, {
    name: "screenshot",
    title: "Screenshot",
    description:
      "Capture the viewport, the full page, or one element as a JPEG. The image is returned inline and also saved to a file whose path is in the result. Very tall full-page captures are saved only, because they are too large to return inline. Prefer snapshot or read_text for content; use this for layout, visual state, images and charts.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Capture only this element (ref or selector)."),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page instead of the viewport. Default false."),
      quality: z.number().int().min(20).max(100).optional().describe("JPEG quality. Default 70."),
      save_only: z.boolean().optional().describe("Save the file and return only its path, without the inline image. Default false."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const options = { type: "jpeg" as const, quality: input.quality ?? 70, scale: "css" as const, timeout: 20_000 };
      const image = input.target
        ? await (await manager.resolve(tab, input.target)).screenshot(options)
        : await tab.page.screenshot({ ...options, fullPage: input.full_page ?? false });
      const file = await store.write("screenshots", store.uniqueName(`${tab.id}-${tab.page.url()}`, "jpg"), image);
      const pageHeight = input.full_page ? await tab.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0) : 0;
      if (input.save_only) return `Screenshot saved to ${file}`;
      if (pageHeight > INLINE_SCREENSHOT_MAX_HEIGHT) {
        return `Screenshot saved to ${file}. The page is ${pageHeight}px tall, too large to return inline; read the file, or capture a target or the viewport.`;
      }
      return { text: `Screenshot of ${tab.page.url()} saved to ${file}`, images: [{ data: image, mimeType: "image/jpeg" }] };
    },
  });

  defineTool(server, deps, {
    name: "console_logs",
    title: "Console logs",
    description:
      "Return recent console messages and uncaught errors of a tab, newest last. With the default stealth engine, capture works on local development hosts (localhost, 127.0.0.1, *.localhost, *.test); other sites return nothing unless the server runs with WEB_AGENT_CONSOLE_HOOK=all or WEB_AGENT_ENGINE=playwright.",
    input: {
      tab: tabParam,
      level: z.enum(["all", "errors"]).optional().describe("errors keeps only error and warning entries. Default all."),
      pattern: z.string().optional().describe("Keep only entries whose text contains this, case-insensitive."),
      limit: z.number().int().min(1).max(300).optional().describe("Maximum entries to return. Default 40."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const pattern = input.pattern?.toLowerCase();
      const entries = (await manager.drainConsole(tab))
        .filter((entry) => input.level !== "errors" || /error|warn/i.test(entry.level))
        .filter((entry) => !pattern || entry.text.toLowerCase().includes(pattern))
        .slice(-(input.limit ?? 40));
      if (entries.length === 0) return `No console entries captured for ${tab.page.url()}.`;
      return untrusted(tab.page.url(), entries.map((entry) => `${entry.time.slice(11, 19)} ${entry.level}: ${entry.text}`).join("\n"));
    },
  });

  defineTool(server, deps, {
    name: "extract",
    title: "Extract structured data",
    description:
      "Return the machine-readable data a page declares: JSON-LD objects (products with price and availability, articles, events, breadcrumbs), Open Graph and other meta tags, and every HTML table as rows. Tables are also saved as CSV files, which are kept until you delete them. Faster and more reliable than reading prices or specs out of the page text when the site provides them; a price here is what the page declares, which can differ from a signed-in or checkout price.",
    input: {
      tab: tabParam,
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the JSON in the result; the full data is saved to a file when larger. Default 10000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const data = await extractPage(tab.page);
      const tables = [];
      for (const [index, table] of data.tables.entries()) {
        const file = await store.write("extract", store.uniqueName(`${tab.id}-table-${index + 1}`, "csv"), toCsv(table.rows));
        tables.push({ caption: table.caption, rows: table.rows.length, columns: table.rows[0]?.length ?? 0, header: table.rows[0], file });
      }
      const summary = summarizeStructured(data);
      const body = JSON.stringify({ jsonld: data.jsonld, meta: data.meta, tables }, null, 2);
      return untrusted(tab.page.url(), `${summary ? `${summary}\n` : ""}${await clipToFile(store, "extract", `${tab.id}-structured`, body, input.max_chars ?? 10_000)}`);
    },
  });

  defineTool(server, deps, {
    name: "save_page",
    title: "Save page to file",
    description:
      "Save the current page to a file and return its path: pdf (printed page, as from the print dialog), mhtml (single-file archive with images and styles, opens in Chrome), or html (the current DOM as markup). Use it to keep receipts, invoices, confirmations and reference pages; saved pages are kept until you delete them.",
    input: {
      tab: tabParam,
      format: z.enum(["pdf", "mhtml", "html"]).describe("File format."),
      label: z.string().optional().describe("Short name used in the file name. Default: the page URL."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const name = store.uniqueName(input.label ?? tab.page.url(), input.format);
      let content: string | Buffer;
      if (input.format === "pdf") {
        content = await tab.page.pdf({ printBackground: true, format: "A4" });
      } else if (input.format === "mhtml") {
        const session = await tab.page.context().newCDPSession(tab.page);
        try {
          content = ((await session.send("Page.captureSnapshot", { format: "mhtml" })) as { data: string }).data;
        } finally {
          await session.detach().catch(() => undefined);
        }
      } else {
        content = await tab.page.content();
      }
      const file = await store.write("pages", name, content);
      return `Saved ${tab.page.url()} as ${input.format} to ${file} (${Buffer.byteLength(content)} bytes)`;
    },
  });
}
