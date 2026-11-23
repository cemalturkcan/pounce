import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import type { Page, Request } from "playwright-core";
import { z } from "zod";
import { inSequence } from "../shared/async.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import { readTabBody, tabBodyType } from "../page/body.ts";
import { capture, type CaptureOptions } from "../page/capture.ts";
import { extractPage, summarizeStructured, toCsv } from "../page/extract.ts";
import { framesText } from "../page/frames.ts";
import { elementMarkdown, pageMarkdown } from "../page/markdown.ts";
import { clipWindow, fieldPointer, shownUrl, untrusted } from "../shared/output.ts";
import {
  pageText,
  rawSnapshot,
  renderSnapshot,
  settleForCapture,
  settleFreshPage,
  snapshotDiff,
} from "../page/page.ts";
import { findInSnapshot } from "../page/snapshot.ts";
import {
  clipToFile,
  defineTool,
  INLINE_SCREENSHOT_MAX_HEIGHT,
  tabParam,
  targetParam,
  type ToolDeps,
} from "./common.ts";
import { pageBound } from "../page/bound.ts";
import type { Tab } from "../browser/tab.ts";

const contentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function registerPageReadTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "snapshot",
    title: "Page snapshot",
    description:
      "Return the page's accessibility tree with a ref on each element, or a part of it: the lines matching a query, only the interactive elements, one element's subtree, or the lines changed since the last snapshot (diff). Refs such as e12 or f2e12 are what click, fill and the other action tools take as target; iframe content is included. By default the tree is scoped to an open modal dialog, or else to the page's single main landmark, and link-only navigation menus are folded into one line each; a line at the top says what was left out, and scope full returns the whole page. A ref stays valid while its own element stays on the page with the same role and name, whatever text around it changes, and the tab and the element's iframe stay on the same document and address, hash included; it is never moved to another element, so after a re-render that replaced the element, a reload, a navigation or any address change (a single-page app route, a hash route, an anchor jump) an action refuses it and says why, and you take a new snapshot. When you know the label or role you are after, query is the cheapest way to find it. To read an article, documentation or results, read_page returns clean text without refs. Output above max_chars keeps alerts, dialogs, headings and controls before text and links, and the full tree is saved to a file whose path is in the result. Within a few seconds of a page load it first waits briefly for the page's requests and content to settle.",
    input: {
      tab: tabParam,
      query: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Return only the elements whose role, name or value contains this text, ignoring case and diacritics, for example "Add to cart" or "textbox". Each line is one element with its ref and, when it sits in a row, list item, article, group, dialog or form, that container\'s name (— in row "…"). Elements named exactly like the query come first, then those with it as a whole word, controls before text at each rank; elements that only contain it follow under "Also contains". Takes no target, scope, depth, interactive, boxes, diff or max_chars.',
        ),
      regex: z
        .boolean()
        .optional()
        .describe(
          "Treat query as a case-insensitive regular expression tested on each snapshot line; matches are listed in page order without ranking. Needs query. Default false.",
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Maximum matches to return for query. Needs query. Default 30."),
      target: targetParam
        .optional()
        .describe(
          "Return only this element's subtree (ref or selector); refs elsewhere on the page stay valid.",
        ),
      scope: z
        .enum(["auto", "full"])
        .optional()
        .describe(
          'auto (default) scopes to an open modal dialog or the single main landmark and folds link-only navigation menus; "full" returns the whole page unfolded.',
        ),
      depth: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe(
          "Maximum tree depth to include, counted from target when one is given. Default: no limit.",
        ),
      interactive: z
        .boolean()
        .optional()
        .describe(
          "Return only a flat list of interactive elements (buttons, links, inputs). Much smaller. Default false.",
        ),
      boxes: z
        .boolean()
        .optional()
        .describe(
          "Append each element's viewport rectangle as [box=x,y,width,height], to relate refs to a screenshot. Default false.",
        ),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .optional()
        .describe("Character budget for the result. Default 20000."),
      diff: z
        .boolean()
        .optional()
        .describe(
          "Return only the lines added and removed since the last whole-page snapshot of this tab, in page order, instead of the tree. That baseline is also taken by a query and by include_snapshot and include_diff on actions. Takes no target, scope, depth, interactive or boxes. Default false.",
        ),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.query !== undefined) {
        const mixed = (
          ["target", "scope", "depth", "interactive", "boxes", "diff", "max_chars"] as const
        ).filter((key) => input[key] !== undefined);
        if (mixed.length > 0)
          throw new ToolError(
            `query searches the whole page and returns only the matching lines, so it takes no ${mixed.join(", ")}.`,
            "Call snapshot with query alone (regex and max_results may go with it), or without query for the tree.",
          );
        await settleFreshPage(tab);
        const snapshot = await rawSnapshot(manager, tab, {});
        const found = findInSnapshot(snapshot, input.query, {
          regex: input.regex ?? false,
          maxResults: input.max_results ?? 30,
        });
        if (found.matches === 0)
          return `No match for ${JSON.stringify(input.query)} on ${shownUrl(tab.page.url())}.`;
        const note =
          found.matches > found.shown
            ? ` (showing ${found.shown}; narrow the query or raise max_results)`
            : "";
        return untrusted(tab.page.url(), `${found.matches} matches${note}:\n${found.text}`);
      }
      const queryOnly = (["regex", "max_results"] as const).filter(
        (key) => input[key] !== undefined,
      );
      if (queryOnly.length > 0)
        throw new ToolError(
          `${queryOnly.join(" and ")} only apply to a query.`,
          "Pass query with the text to look for, or leave them out.",
        );
      if (input.diff) {
        const mixed = (["target", "scope", "depth", "interactive", "boxes"] as const).filter(
          (key) => input[key] !== undefined,
        );
        if (mixed.length > 0)
          throw new ToolError(
            `diff compares the whole page, so it takes no ${mixed.join(", ")}.`,
            "Call snapshot with diff: true alone, or without diff for a narrowed tree.",
          );
        const diff = await snapshotDiff(manager, tab);
        const clipped = await clipToFile(
          store,
          "snapshots",
          `${tab.id}-diff`,
          diff,
          input.max_chars ?? 20_000,
        );
        return untrusted(tab.page.url(), clipped.text);
      }
      const body = await renderSnapshot(manager, store, tab, {
        target: input.target,
        scope: input.scope,
        depth: input.depth,
        interactive: input.interactive,
        boxes: input.boxes,
        maxChars: input.max_chars ?? 20_000,
      });
      return untrusted(tab.page.url(), body);
    },
  });

  defineTool(server, deps, {
    name: "read_page",
    title: "Read page",
    description: [
      "Read the page as plain text (default), as Markdown, or as structured data (format structured), which is the most exact source for a product's price, availability and specs and for a table's rows.",
      "text and markdown read the whole page or one element, without refs: an article, documentation, search results, an order history, a message thread. Markdown keeps headings, lists, links with their URLs, code blocks and tables, and leaves out navigation, footers, sidebars, scripts and hidden elements. The text is always in the content field (structured: the JSON), and the structured text only says how much was read. Long text is paged: the result says how many characters exist and the offset to pass for the next part, and the whole text is saved to the file in file. On a tab showing a PDF, JSON, plain text or CSV file it returns the file's text (PDF text needs pdftotext; without it the PDF is saved and its path returned); for images and other files it saves the file and says where.",
      "structured returns the JSON-LD objects the page declares (products with price and availability, articles, events, breadcrumbs), Open Graph and other meta tags, and every HTML table as rows; tables are also saved as CSV files, which are kept until you delete them. A price there is what the page declares, which can differ from a signed-in or checkout price; when a page declares nothing useful, markdown keeps its tables and lists.",
      "Within a few seconds of a page load it first waits briefly for the page's requests and content to settle. snapshot is for finding elements to act on; save_pages and ask_pages handle many pages without reading each one here; screenshot shows how the page looks.",
    ].join("\n"),
    input: {
      tab: tabParam,
      format: z
        .enum(["text", "markdown", "structured"])
        .optional()
        .describe(
          "text is the rendered text as the user sees it; markdown keeps structure and link URLs; structured returns the data the page declares and its tables, and takes no target, scope, offset or frames. Default text.",
        ),
      target: targetParam.optional().describe("Read only this element's text (ref or selector)."),
      scope: z
        .enum(["main", "page"])
        .optional()
        .describe(
          "main returns the main content area when the page marks one, skipping navigation and footers; page returns everything. Default page. Ignored when target is set.",
        ),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to start from, as the previous result said. Default 0."),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .optional()
        .describe(
          "Characters to return in content. When the text is longer, the whole text is saved to a file: clipped is true, totalChars is its full size and file is the path; text and markdown return the part from offset, structured a preview. Default 12000.",
        ),
      frames: z
        .boolean()
        .optional()
        .describe(
          'Append the text of every iframe, same-origin or cross-origin, each after a line "--- frame: <url> ---". Default false. Ignored when target is set.',
        ),
    },
    output: {
      content: z.string().optional(),
      chars: z
        .object({ start: z.number().int(), end: z.number().int(), total: z.number().int() })
        .optional(),
      nextOffset: z.number().int().optional(),
      clipped: z.literal(true).optional(),
      totalChars: z.number().int().optional(),
      file: z.string().optional(),
      notes: z.array(z.string()).optional(),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const maxChars = input.max_chars ?? 12_000;
      if (input.format === "structured") {
        const mixed = (["target", "scope", "offset", "frames"] as const).filter(
          (key) => input[key] !== undefined,
        );
        if (mixed.length > 0)
          throw new ToolError(
            `format structured returns the data the whole page declares, so it takes no ${mixed.join(", ")}.`,
            "Call read_page with format structured and at most max_chars, or use format text or markdown to read part of the page.",
          );
        await settleFreshPage(tab);
        const { summary, clipped } = await structuredData(tab, maxChars);
        const frame = (shown: string) =>
          untrusted(tab.page.url(), summary ? `${summary}\n${shown}` : shown);
        const read = clipped.file
          ? `Read ${clipped.totalChars} chars of structured data; a preview in content, all in file.`
          : `Read ${clipped.totalChars} chars of structured data, all in content.`;
        return {
          text: frame(clipped.text),
          structuredText: frame(read),
          data: {
            content: clipped.preview,
            clipped: clipped.file ? (true as const) : undefined,
            totalChars: clipped.totalChars,
            file: clipped.file,
          },
        };
      }
      const scope = input.scope ?? "page";
      await settleFreshPage(tab);
      const read = await pageBound(
        (async (): Promise<
          | { early: { note: string; file: string | undefined } }
          | {
              text: string;
              frameText: string;
              body: Awaited<ReturnType<typeof readTabBody>> | undefined;
            }
        > => {
          const bodyType = input.target ? undefined : await tabBodyType(tab.page);
          const body =
            bodyType && bodyType.kind !== "html"
              ? await readTabBody(tab, bodyType, store)
              : undefined;
          if (body && body.text === undefined)
            return { early: { note: body.note ?? "", file: body.file } };
          const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
          const text: string =
            body?.text !== undefined
              ? body.text
              : input.format === "markdown"
                ? locator
                  ? await elementMarkdown(locator)
                  : await pageMarkdown(tab.page, scope)
                : locator
                  ? await locator.innerText()
                  : await pageText(tab.page, scope);
          const frameText =
            input.frames && !locator && body === undefined
              ? await framesText(tab.page, input.format === "markdown" ? "markdown" : "text")
              : "";
          return { text, frameText, body };
        })(),
        "read_page",
      );
      if ("early" in read) return { text: read.early.note, data: { file: read.early.file } };
      const { text, frameText, body } = read;
      const whole = frameText ? `${text}\n\n${frameText}` : text;
      const window = clipWindow(whole, input.offset ?? 0, maxChars);
      const part = window.start > 0 || window.hasMore;
      const file = part
        ? await store.writeOnce("read", `${tab.id}-read-${contentHash(whole)}.txt`, whole)
        : undefined;
      const footer = window.hasMore
        ? `\n[chars ${window.start}-${window.end} of ${window.totalChars}; pass offset=${window.end} for more]`
        : `\n[chars ${window.start}-${window.end} of ${window.totalChars}; end of text]`;
      const saved = file ? `\n[All ${window.totalChars} chars saved to ${file}.]` : "";
      const note = body?.note ? `\n${body.note}` : "";
      const shown =
        window.start === 0 ? `the first ${window.end}` : `chars ${window.start}-${window.end}`;
      const sentence = part
        ? `Read ${window.totalChars} chars; ${shown} in content, all in file.${window.hasMore ? " Pass nextOffset as offset for the next part." : ""}`
        : `Read ${window.totalChars} chars, all in content.`;
      return {
        text: untrusted(tab.page.url(), window.text + footer) + saved + note,
        structuredText: untrusted(tab.page.url(), sentence),
        data: {
          content: window.text,
          chars: { start: window.start, end: window.end, total: window.totalChars },
          nextOffset: window.hasMore ? window.end : undefined,
          clipped: part ? (true as const) : undefined,
          totalChars: window.totalChars,
          file,
          notes: body?.note ? [body.note] : undefined,
        },
      };
    },
  });

  async function structuredData(tab: Tab, maxChars: number) {
    const data = await pageBound(extractPage(tab.page), "read_page");
    const tables = await inSequence(data.tables, async (table, index) => {
      const file = await store.write(
        "extract",
        store.uniqueName(`${tab.id}-table-${index + 1}`, "csv"),
        toCsv(table.rows),
      );
      return {
        caption: table.caption,
        rows: table.rows.length,
        columns: table.rows[0]?.length ?? 0,
        header: table.rows[0],
        file,
      };
    });
    const body = JSON.stringify({ jsonld: data.jsonld, meta: data.meta, tables }, null, 2);
    return {
      summary: summarizeStructured(data),
      clipped: await clipToFile(store, "extract", `${tab.id}-structured`, body, maxChars),
    };
  }

  defineTool(server, deps, {
    name: "screenshot",
    title: "Screenshot",
    description:
      "Capture the viewport (default), the whole scrollable page (full_page) or one element (target) as a JPEG. The image is returned inline and saved to a file whose path is in the result; full-page captures taller than 6000 px are saved only, and screenshots are deleted after 7 days. It first waits for the page's requests and content to settle, and when the page loads a new document meanwhile it captures the new one. Use it when you need to see something yourself: the visual state of a page, an image or chart, or whether one element looks right. The image enters this conversation, so for text use read_page or snapshot; to check a page against a design, mockup or earlier screenshot use compare_design; for visual QA across many pages use ask_pages with mode review. Those two send images to a model without bringing them into this conversation.",
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe("Capture only this element (ref or selector). Takes no full_page."),
      full_page: z
        .boolean()
        .optional()
        .describe(
          "Capture the whole scrollable page instead of the viewport. Takes no target. Default false.",
        ),
      quality: z.number().int().min(20).max(100).optional().describe("JPEG quality. Default 70."),
      save_only: z
        .boolean()
        .optional()
        .describe(
          "Save the file and return only its path, without the inline image. Default false.",
        ),
    },
    output: { file: z.string() },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.target !== undefined && input.full_page === true)
        throw new ToolError(
          "full_page captures the whole page and target captures one element, so they do not go together.",
          "Pass target for the element, or full_page for the whole page.",
        );
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      const fullPage = input.full_page ?? false;
      const image = await captureSettled(
        tab,
        { format: "jpeg", quality: input.quality ?? 70, locator, fullPage },
        Date.now() + CAPTURE_MS,
      );
      const file = await store.write(
        "screenshots",
        store.uniqueName(`${tab.id}-${tab.page.url()}`, "jpg"),
        image,
      );
      const pageHeight = fullPage
        ? await tab.page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0)
        : 0;
      const saved = (sentence: (path: string) => string) => ({
        text: sentence(file),
        structuredText: sentence(fieldPointer("file")),
        data: { file },
      });
      if (input.save_only) return saved((path) => `Screenshot saved to ${path}`);
      if (pageHeight > INLINE_SCREENSHOT_MAX_HEIGHT)
        return saved(
          (path) =>
            `Screenshot saved to ${path}. The page is ${pageHeight}px tall, too large to return inline; read the file, or capture a target or the viewport.`,
        );
      return {
        ...saved((path) => `Screenshot of ${shownUrl(tab.page.url())} saved to ${path}`),
        images: [{ data: image, mimeType: "image/jpeg" }],
      };
    },
  });
}

const CAPTURE_MS = 20_000;
const CONTEXT_LOST = /Execution context was destroyed|Cannot find context with specified id/;
const NEW_DOCUMENT = Symbol("new document");

function watchNewDocument(page: Page) {
  const { promise, resolve } = Promise.withResolvers<typeof NEW_DOCUMENT>();
  const onRequest = (request: Request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      resolve(NEW_DOCUMENT);
  };
  page.on("request", onRequest);
  return {
    loaded: promise,
    stop: () => {
      page.off("request", onRequest);
    },
  };
}

const keptLoading = () =>
  new ToolError(
    `The page kept loading new documents for ${CAPTURE_MS / 1000} s, so no screenshot was taken.`,
    "Wait until it stays on one page (wait_for), then take the screenshot again.",
  );

async function captureSettled(
  tab: Tab,
  options: Omit<CaptureOptions, "timeoutMs">,
  deadline: number,
  retried = false,
): Promise<Buffer> {
  await settleForCapture(tab);
  if (retried && Date.now() >= deadline) throw keptLoading();
  const watch = watchNewDocument(tab.page);
  const shot = capture(tab.page, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
  shot.catch(() => undefined);
  try {
    const result = await Promise.race([shot, watch.loaded]);
    if (result !== NEW_DOCUMENT) return result;
  } catch (cause) {
    if (retried && Date.now() >= deadline) throw keptLoading();
    if (!CONTEXT_LOST.test(messageOf(cause))) throw cause;
  } finally {
    watch.stop();
  }
  if (Date.now() >= deadline) throw keptLoading();
  return captureSettled(tab, options, deadline, true);
}
