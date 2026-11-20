import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askPages, renderAskResults, type AskAdapterSource, type AskDocument } from "./ask.ts";
import type { BrowserManager, Tab } from "./browser.ts";
import { collectPages, normalizeUrl, renderCollectIndex } from "./collect.ts";
import { describeError, ToolError } from "./errors.ts";
import { extractPage, summarizeStructured, toCsv } from "./extract.ts";
import { describeEmulation, emulate, resetEmulation, VIEWPORT_PRESETS } from "./emulate.ts";
import { describeJob, type JobRunner } from "./jobs.ts";
import { elementMarkdown, pageMarkdown } from "./markdown.ts";
import { addRule, buildHar, clearRules, listRules, removeRule } from "./network.ts";
import { clipHeadTail, clipWindow, untrusted, type OutputStore, type Redactor } from "./output.ts";
import { describePage, pageText, rawSnapshot, renderSnapshot, runAction } from "./page.ts";
import { runScript, serializeValue } from "./script.ts";
import type { SecretField, SecretStore } from "./secrets.ts";
import { describeOverlayClicks, dismissOverlays } from "./overlays.ts";
import { appendSiteNote, readSiteNotes, siteHost, siteNotesHint, siteNotesPath } from "./sites.ts";
import { buildMatcher, findInSnapshot } from "./snapshot.ts";
import { exportIndexedDb, listIndexedDb, readIndexedDbStore, readWebStorage, splitStoreKey, storageOrigin } from "./storage.ts";

export type ToolDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  jobs: JobRunner;
  ask: AskAdapterSource;
};

type ToolImage = { data: Buffer; mimeType: string };
type ToolOutput = string | { text: string; images?: ToolImage[] };

type ToolSpec<Shape extends z.ZodRawShape> = {
  name: string;
  title: string;
  description: string;
  input: Shape;
  readOnly?: boolean;
  destructive?: boolean;
  handler: (input: z.infer<z.ZodObject<Shape>>, owner: string) => Promise<ToolOutput>;
};

const INLINE_SCREENSHOT_MAX_HEIGHT = 6000;
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "set-cookie", "proxy-authorization", "x-api-key"]);

const tabParam = z.string().describe("Tab id from tabs_list or tab_open, for example t1.");
const targetParam = z
  .string()
  .describe("Element to act on: a ref from the latest snapshot of this tab (e12, or f1e3 inside an iframe), or a Playwright selector such as #id, text=Sign in, or role=button[name=\"Save\"].");
const includeSnapshotParam = z
  .boolean()
  .optional()
  .describe("Append a fresh snapshot of the page to the result, saving a separate snapshot call. Default false.");
const includeDiffParam = z
  .boolean()
  .optional()
  .describe("Append only the snapshot lines the action added or removed, instead of a whole snapshot. Costs one extra snapshot before the action. Default false.");
const timeoutParam = (fallback: number) =>
  z.number().int().min(100).max(120_000).optional().describe(`How long to wait before failing, in milliseconds. Default ${fallback}.`);
const waitUntilParam = z
  .enum(["commit", "domcontentloaded", "load"])
  .optional()
  .describe("Navigation milestone to wait for. Default domcontentloaded; load also waits for images and subframes.");

function defineTool<Shape extends z.ZodRawShape>(server: McpServer, deps: ToolDeps, spec: ToolSpec<Shape>) {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: Record<string, unknown>,
    callback: (input: unknown, extra: { sessionId?: string }) => Promise<unknown>,
  ) => void;

  register(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.input,
      annotations: {
        readOnlyHint: spec.readOnly ?? false,
        destructiveHint: spec.destructive ?? false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      try {
        const output = await spec.handler(input as z.infer<z.ZodObject<Shape>>, extra.sessionId ?? "stdio");
        const text = typeof output === "string" ? output : output.text;
        const images = typeof output === "string" ? [] : (output.images ?? []);
        return {
          content: [
            { type: "text", text: deps.redactor.redact(text) },
            ...images.map((image) => ({ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType })),
          ],
        };
      } catch (error) {
        return { content: [{ type: "text", text: deps.redactor.redact(describeError(error)) }], isError: true };
      }
    },
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function clipToFile(store: OutputStore, kind: string, label: string, text: string, maxChars: number) {
  const clipped = clipHeadTail(text, maxChars);
  if (!clipped.truncated) return text;
  const file = await store.write(kind, store.uniqueName(label, "txt"), text);
  return `${clipped.text}\n[truncated: ${clipped.totalChars} chars total. Full output saved to ${file}.]`;
}

function tabLine(tab: Tab, owner: string) {
  const ownership = tab.owner === owner ? "yours" : tab.owner === "browser" ? "unclaimed" : "other client";
  return `${tab.id} [${ownership}] ${tab.page.url()}`;
}

export function registerTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, secrets, redactor, jobs } = deps;

  type FieldInput = { target: string; text?: string; secret?: string; secret_field?: string; slowly?: boolean; timeout_ms?: number };

  async function fillField(tab: Tab, field: FieldInput) {
    if ((field.text === undefined) === (field.secret === undefined)) {
      throw new ToolError(`Give exactly one of text or secret for ${field.target}.`);
    }
    const locator = await manager.resolve(tab, field.target);
    const secretField: SecretField = field.secret_field ?? "password";
    const value = field.secret === undefined ? (field.text ?? "") : await secrets.get(field.secret, secretField);
    if (field.secret !== undefined) redactor.register(`${field.secret}:${secretField}`, value);

    const kind = await locator.evaluate(
      (element) => ({ tag: element.tagName.toLowerCase(), type: (element.getAttribute("type") ?? "").toLowerCase() }),
      undefined,
      { timeout: field.timeout_ms },
    );
    if (kind.tag === "input" && kind.type === "file") {
      throw new ToolError(`${field.target} is a file input.`, "Use upload with the file paths.");
    }
    const choice = kind.tag === "select" || kind.type === "checkbox" || kind.type === "radio";
    if (kind.tag === "select") {
      await locator.selectOption(value, { timeout: field.timeout_ms });
    } else if (choice) {
      await locator.setChecked(/^(true|1|on|yes|checked)$/i.test(value), { timeout: field.timeout_ms });
    } else if (field.slowly) {
      await locator.click({ timeout: field.timeout_ms });
      await locator.fill("", { timeout: field.timeout_ms });
      await locator.pressSequentially(value, { delay: 45 });
    } else {
      await locator.fill(value, { timeout: field.timeout_ms });
    }

    if (field.secret !== undefined) return { locator, summary: `Filled ${field.target} with secret ${field.secret} (${secretField}).` };
    const current = choice ? undefined : await locator.inputValue().catch(() => undefined);
    const mismatch =
      current !== undefined && current !== value
        ? ` The field now reads ${JSON.stringify(current.slice(0, 80))}; the page reformatted or rejected the input.`
        : "";
    return { locator, summary: `Filled ${field.target} (${value.length} chars).${mismatch}` };
  }

  defineTool(server, deps, {
    name: "tabs_list",
    title: "List tabs",
    description:
      "List the open tabs of the shared browser with their ids, owners and URLs, plus browser status (engine, Chrome version, profile and output directories). Tabs marked \"other client\" belong to another agent session and \"unclaimed\" ones were opened by the browser or the user; leave both alone unless the task is about them. Does not start the browser if it is not running.",
    input: {},
    readOnly: true,
    handler: async (_input, owner) => {
      const { config } = manager;
      const status = manager.running
        ? `Browser running: Chrome ${manager.version ?? "?"} via ${config.engine}${config.headless ? " (headless)" : ""}.`
        : "Browser not started yet; it launches on the first tab_open.";
      const lines = [status, `Profile: ${config.profileDir}`, `Output files: ${store.root}`, `Secret store: ${secrets.backend}`, `ask_pages adapter: ${deps.ask.label}`];
      const tabs = manager.listTabs();
      if (tabs.length === 0) return [...lines, "No tabs open."].join("\n");
      const titled = await Promise.all(
        tabs.map(async (tab) => `${tabLine(tab, owner)} "${await tab.page.title().catch(() => "")}"`),
      );
      return [...lines, "Tabs:", ...titled].join("\n");
    },
  });

  defineTool(server, deps, {
    name: "tab_open",
    title: "Open tab",
    description:
      "Open a new tab owned by this session and optionally navigate it. Returns the tab id to pass as `tab` to every other tool. Starts the browser on first use; the profile is persistent, so cookies and logins from earlier sessions are available.",
    input: {
      url: z.string().optional().describe("URL to load. https:// is assumed when no scheme is given. Omit for a blank tab."),
      wait_until: waitUntilParam,
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input, owner) => {
      const tab = await manager.openTab(owner);
      if (!input.url) return `Opened ${tab.id} (blank).`;
      const response = await tab.page.goto(normalizeUrl(input.url), { waitUntil: input.wait_until ?? "domcontentloaded" });
      const lines = [`Opened ${tab.id}: ${await describePage(tab.page)} (HTTP ${response?.status() ?? "-"})`];
      const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
      if (notes) lines.push(notes);
      if (input.include_snapshot) lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
      return lines.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "tab_close",
    title: "Close tab",
    description:
      "Close a tab and free its memory. Unsaved state in the page is lost; cookies, logins and other profile data stay. Close tabs you opened once the task no longer needs them, and leave tabs that belong to other sessions or the user open.",
    input: { tab: tabParam },
    destructive: true,
    handler: async (input) => {
      await manager.closeTab(input.tab);
      return `Closed ${input.tab}.`;
    },
  });

  defineTool(server, deps, {
    name: "tab_resize",
    title: "Resize viewport",
    description:
      "Set the viewport size of a tab in CSS pixels, for responsive checks or to change what a viewport screenshot covers. The size stays until the tab is resized again or closed; other tabs are not affected.",
    input: {
      tab: tabParam,
      width: z.number().int().min(200).max(7680).describe("Viewport width in CSS pixels."),
      height: z.number().int().min(200).max(4320).describe("Viewport height in CSS pixels."),
    },
    handler: async (input) => {
      await manager.getTab(input.tab).page.setViewportSize({ width: input.width, height: input.height });
      return `Viewport of ${input.tab} is now ${input.width}x${input.height}.`;
    },
  });

  defineTool(server, deps, {
    name: "navigate",
    title: "Navigate",
    description:
      "Load a URL in an existing tab, or move through its history. Returns the final URL, title and HTTP status. Refs from earlier snapshots of this tab stop working after navigation.",
    input: {
      tab: tabParam,
      url: z.string().describe("URL to load, or one of back, forward, reload. https:// is assumed when no scheme is given."),
      wait_until: waitUntilParam,
      timeout_ms: timeoutParam(30_000),
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const options = { waitUntil: input.wait_until ?? ("domcontentloaded" as const), timeout: input.timeout_ms };
      const history = { waitUntil: "commit" as const, timeout: input.timeout_ms };
      const response =
        input.url === "back"
          ? await tab.page.goBack(history)
          : input.url === "forward"
            ? await tab.page.goForward(history)
            : input.url === "reload"
              ? await tab.page.reload(options)
              : await tab.page.goto(normalizeUrl(input.url), options);
      if (input.url === "back" || input.url === "forward") {
        await tab.page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => undefined);
      }
      const lines = [`${await describePage(tab.page)} (HTTP ${response?.status() ?? "-"})`];
      lines.push(...manager.drainEvents(tab).map((event) => `Event: ${event}`));
      const notes = await siteNotesHint(manager.config.sitesDir, tab.page.url());
      if (notes) lines.push(notes);
      if (input.include_snapshot) lines.push("", await renderSnapshot(manager, store, tab, { maxChars: 12_000 }));
      return lines.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "snapshot",
    title: "Page snapshot",
    description:
      "Return the accessibility tree of the page as indented text. Each element carries a ref like [ref=e12] that click, fill and the other action tools accept as `target`; iframe content is included with refs like f1e3. This is the main way to see a page and to address elements. Refs stay valid until the page changes. Output above max_chars is cut in the middle and the full tree is saved to a file whose path is returned.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Limit the snapshot to this element's subtree (ref or selector)."),
      depth: z.number().int().min(1).max(50).optional().describe("Maximum tree depth to include."),
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
    name: "click",
    title: "Click",
    description:
      "Click an element. Waits for it to be visible, enabled and not covered, scrolls it into view, then clicks. The result says whether the page navigated, changed, or did not react, and reports dialogs, downloads and new tabs triggered by the click.",
    input: {
      tab: tabParam,
      target: targetParam,
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default left."),
      click_count: z.number().int().min(1).max(3).optional().describe("2 for a double click, 3 to select a paragraph. Default 1."),
      modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys held during the click."),
      timeout_ms: timeoutParam(8000),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await locator.click({
            button: input.button ?? "left",
            clickCount: input.click_count ?? 1,
            modifiers: input.modifiers,
            timeout: input.timeout_ms,
          });
          return `Clicked ${input.target}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "fill",
    title: "Fill field",
    description:
      "Set the value of a form control: types into text inputs and textareas, picks an option in a <select> by label or value, and checks or unchecks checkboxes and radios (text \"true\" or \"false\"). Replaces the existing value. To enter a stored credential, pass `secret` instead of `text`: the server reads it from the password store and types it, and the value never appears in this conversation. For file inputs use upload.",
    input: {
      tab: tabParam,
      target: targetParam,
      text: z.string().optional().describe("Value to enter. Give either text or secret."),
      secret: z.string().optional().describe("Name of a password-store entry from secrets_list, used instead of text."),
      secret_field: z.string().optional().describe("Which part of the secret to enter: password (default), username, otp for a current one-time code, or any other field name stored in the entry."),
      submit: z.boolean().optional().describe("Press Enter in the field afterwards. Default false."),
      slowly: z.boolean().optional().describe("Type key by key instead of setting the value at once, for fields that react to individual keystrokes such as autocomplete. Default false."),
      timeout_ms: timeoutParam(8000),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const { locator, summary } = await fillField(tab, input);
          if (input.submit) await locator.press("Enter");
          return summary;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "fill_form",
    title: "Fill several fields",
    description:
      "Fill many form controls in one call, in order, with the same rules as fill (text inputs, selects by label or value, checkboxes and radios with true or false, stored secrets by name). Stops at the first field that cannot be filled and reports which fields were done. Afterwards it reports any field the browser marks invalid, with the browser's validation message, and can click a submit button.",
    input: {
      tab: tabParam,
      fields: z
        .array(
          z.object({
            target: targetParam,
            text: z.string().optional().describe("Value to enter. Give either text or secret."),
            secret: z.string().optional().describe("Name of a password-store entry, used instead of text."),
            secret_field: z.string().optional().describe("password (default), username, otp, or another field of the entry."),
          }),
        )
        .min(1)
        .max(60)
        .describe("Fields to fill, in order."),
      submit: targetParam.optional().describe("Element to click after all fields are filled, usually the submit button (ref or selector)."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const lines: string[] = [];
          const filled: { target: string; locator: Awaited<ReturnType<typeof fillField>>["locator"] }[] = [];
          for (const field of input.fields) {
            try {
              const result = await fillField(tab, field);
              filled.push({ target: field.target, locator: result.locator });
              lines.push(result.summary);
            } catch (error) {
              throw new ToolError(
                `Filled ${filled.length} of ${input.fields.length} fields, then ${field.target} failed: ${describeError(error).split("\n")[0]}`,
                lines.length ? `Done before the failure:\n${lines.join("\n")}` : undefined,
              );
            }
          }
          for (const entry of filled) {
            const message = await entry.locator
              .evaluate((element) => {
                const control = element as HTMLInputElement;
                return control.validity && !control.validity.valid ? control.validationMessage || "invalid" : "";
              })
              .catch(() => "");
            if (message) lines.push(`Invalid: ${entry.target} — ${message}`);
          }
          if (input.submit) {
            await (await manager.resolve(tab, input.submit)).click();
            lines.push(`Clicked ${input.submit}.`);
          }
          return lines.join("\n");
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "press",
    title: "Press key",
    description:
      "Press a key or key combination, on a specific element or on whatever has focus. Uses Playwright key names: Enter, Escape, Tab, ArrowDown, Backspace, a, Control+a, Shift+Tab.",
    input: {
      tab: tabParam,
      key: z.string().min(1).describe("Key or combination, for example Enter or Control+a."),
      target: targetParam.optional().describe("Focus this element first (ref or selector). Omit to send the key to the focused element."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      return runAction(
        manager,
        store,
        tab,
        async () => {
          if (locator) await locator.press(input.key);
          else await tab.page.keyboard.press(input.key);
          return `Pressed ${input.key}${input.target ? ` on ${input.target}` : ""}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "hover",
    title: "Hover",
    description:
      "Move the mouse over an element and leave it there, to reveal menus, tooltips or controls that only appear on hover. Take a snapshot afterwards (or pass include_snapshot) to get refs for what appeared.",
    input: { tab: tabParam, target: targetParam, include_snapshot: includeSnapshotParam, include_diff: includeDiffParam },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await locator.hover();
          return `Hovering ${input.target}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "drag",
    title: "Drag and drop",
    description:
      "Drag one element onto another with real mouse events: press on the source, move to the target, release. Works for sortable lists, sliders with a drop target, and HTML5 drag and drop. For dragging by pixel offsets use run_script with page.mouse.",
    input: {
      tab: tabParam,
      from: targetParam.describe("Element to drag (ref or selector)."),
      to: targetParam.describe("Element to drop onto (ref or selector)."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const source = await manager.resolve(tab, input.from);
      const destination = await manager.resolve(tab, input.to);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await source.dragTo(destination);
          return `Dragged ${input.from} onto ${input.to}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "scroll",
    title: "Scroll",
    description:
      "Scroll an element into view, or scroll the page. Needed for pages that load more content as you scroll; action tools already scroll their target into view on their own.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Scroll this element into view (ref or selector). When set, direction and amount are ignored."),
      direction: z.enum(["down", "up", "left", "right", "top", "bottom"]).optional().describe("Direction to scroll the page; top and bottom jump to the ends. Default down."),
      amount: z.number().int().min(1).max(100_000).optional().describe("Distance in pixels for down, up, left and right. Default 800."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      const direction = input.direction ?? "down";
      const amount = input.amount ?? 800;
      return runAction(
        manager,
        store,
        tab,
        async () => {
          if (locator) {
            await locator.scrollIntoViewIfNeeded();
            return `Scrolled ${input.target} into view.`;
          }
          if (direction === "top" || direction === "bottom") {
            await tab.page.evaluate((toBottom) => window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0), direction === "bottom");
            return `Scrolled to the ${direction}.`;
          }
          const horizontal = direction === "left" ? -amount : direction === "right" ? amount : 0;
          const vertical = direction === "up" ? -amount : direction === "down" ? amount : 0;
          await tab.page.mouse.wheel(horizontal, vertical);
          return `Scrolled ${direction} ${amount}px.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "upload",
    title: "Upload files",
    description:
      "Attach local files to a file input, or to a button that opens a file chooser. Paths are on the machine running this server and must exist.",
    input: {
      tab: tabParam,
      target: targetParam.describe("The file input, or the button that opens the file chooser (ref or selector)."),
      paths: z.array(z.string().min(1)).min(1).max(20).describe("Absolute paths of the files to attach."),
    },
    handler: async (input) => {
      for (const filePath of input.paths) {
        const info = await stat(filePath).catch(() => undefined);
        if (!info?.isFile()) throw new ToolError(`No file at ${filePath}.`);
      }
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(manager, store, tab, async () => {
        const isFileInput = await locator.evaluate((element) => element instanceof HTMLInputElement && element.type === "file");
        if (isFileInput) {
          await locator.setInputFiles(input.paths);
        } else {
          const [chooser] = await Promise.all([tab.page.waitForEvent("filechooser"), locator.click()]);
          await chooser.setFiles(input.paths);
        }
        return `Attached ${input.paths.length} file(s) to ${input.target}.`;
      });
    },
  });

  defineTool(server, deps, {
    name: "wait_for",
    title: "Wait for condition",
    description:
      "Wait until one condition holds: text becomes visible, an element reaches a state, the URL matches, or a network response arrives. Give exactly one of text, target, url, request. Response waits only see responses that arrive after this call starts, so for a request triggered by a click, check network_requests afterwards instead.",
    input: {
      tab: tabParam,
      text: z.string().optional().describe("Wait until this text is visible on the page."),
      target: targetParam.optional().describe("Wait for this element (ref or selector) to reach `state`."),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional().describe("State for target. Default visible."),
      url: z.string().optional().describe("Wait until the tab's URL contains this text, or matches it as a glob when it contains *."),
      request: z.string().optional().describe("Wait for a network response whose URL contains this text."),
      timeout_ms: timeoutParam(10_000),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 10_000;
      const given = [input.text, input.target, input.url, input.request].filter((value) => value !== undefined).length;
      if (given !== 1) throw new ToolError("Give exactly one of text, target, url, request.");

      if (input.text !== undefined) {
        await tab.page.getByText(input.text).first().waitFor({ state: "visible", timeout });
        return `Text ${JSON.stringify(input.text)} is visible.`;
      }
      if (input.target !== undefined) {
        const state = input.state ?? "visible";
        await manager.locate(tab, input.target).waitFor({ state, timeout });
        return `${input.target} is ${state}.`;
      }
      if (input.url !== undefined) {
        const expected = input.url;
        await tab.page.waitForURL(expected.includes("*") ? expected : (url) => url.href.includes(expected), { timeout });
        return `URL is now ${tab.page.url()}`;
      }
      const expected = input.request ?? "";
      const response = await tab.page.waitForResponse((candidate) => candidate.url().includes(expected), { timeout });
      return `${response.request().method()} ${response.status()} ${response.url()}`;
    },
  });

  defineTool(server, deps, {
    name: "evaluate",
    title: "Evaluate JavaScript in page",
    description:
      "Run JavaScript inside the page and return the result as JSON. Accepts an expression (document.title), a function (() => window.appState), or statements with an explicit return (const x = 1; return x). Async code is awaited. Runs in the page's own JavaScript world by default, so page globals are visible. For work that spans several elements, pages or tabs use run_script, which runs on the server with the full Playwright API.",
    input: {
      tab: tabParam,
      expression: z.string().min(1).max(100_000).describe("JavaScript to run in the page."),
      world: z.enum(["main", "isolated"]).optional().describe("main sees the page's own globals; isolated shares only the DOM and cannot be observed or broken by page scripts. Default main."),
      timeout_ms: timeoutParam(15_000),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the result; longer results are saved to a file. Default 8000."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 15_000;
      const run = (source: string) =>
        input.world === "isolated" ? (tab.page.evaluate(source) as Promise<unknown>) : manager.evaluateMain<unknown>(tab.page, source);
      const asExpression = `(async () => { const value = (${input.expression}\n); return typeof value === "function" ? value() : value; })()`;
      const asStatements = `(async () => {\n${input.expression}\n})()`;
      const attempt = run(asExpression).catch((error: unknown) => {
        if (/SyntaxError/.test(String(error))) return run(asStatements);
        throw error;
      });
      const value = await withTimeout(
        attempt,
        timeout,
        () =>
          new ToolError(
            `evaluate timed out after ${timeout} ms.`,
            "The page script may still be running. If later calls on this tab hang, close the tab and open a new one.",
          ),
      );
      const text = await clipToFile(store, "evaluate", `${tab.id}-evaluate`, serializeValue(value), input.max_chars ?? 8000);
      return untrusted(tab.page.url(), text);
    },
  });

  defineTool(server, deps, {
    name: "run_script",
    title: "Run Playwright script",
    description: [
      "Run an async JavaScript function body on the server with the Playwright API, to do many steps in one call: loops over pages or rows, multi-tab flows, scraping, form batches. Use `return` to send back a value (returned as JSON) and log() for progress lines.",
      "In scope: page (Playwright Page of `tab`), context (BrowserContext; context.request makes HTTP calls with the browser's cookies), tab(id), tabId(page), openTab(url?) -> Page, closeTab(pageOrId), ref(ref, page?) -> Locator, snapshot(page?, {interactive, target, depth}), text(page?, scope), links(page?), extract(page?) -> {jsonld, meta, tables}, save(name, content) -> file path, secrets.fill(targetOrLocator, name, field?), secrets.list(query?), sleep(ms), log(...), signal (aborted when a background job is cancelled), fetch, URL, Buffer.",
      "The script runs in the server process without require or process. A script that hits timeout_ms is reported as failed but browser calls it already started may still complete. Save bulky results with save() and return the paths rather than returning large data.",
    ].join("\n"),
    input: {
      code: z.string().min(1).max(200_000).describe("Body of an async function, for example: const rows = await page.locator('tr').allInnerTexts(); return rows.length;"),
      tab: tabParam.optional().describe("Tab bound to `page` in the script. Omit when the script opens its own tabs."),
      timeout_ms: z.number().int().min(1000).max(900_000).optional().describe("Time limit in milliseconds. Default 120000."),
      background: z.boolean().optional().describe("Start the script as a background job and return its id at once, for long runs. No time limit applies; follow it with jobs, or read its log file. Default false."),
      label: z.string().optional().describe("Short description shown in the jobs list, for background runs."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the returned value and logs; the rest is saved to a file. Default 10000."),
    },
    handler: async (input, owner) => {
      const tab = input.tab ? manager.getTab(input.tab) : undefined;
      if (input.background) {
        const job = await jobs.start(deps, owner, tab, input.code, input.label ?? "");
        return `Started background job ${job.id}. Log: ${job.logFile}\nCheck it with jobs (action status, id ${job.id}); the result is written to ${job.resultFile} when it ends.`;
      }
      const result = await runScript(deps, owner, tab, input.code, { timeoutMs: input.timeout_ms ?? 120_000 });
      const sections = [`Returned: ${serializeValue(result.value)}`];
      if (result.logs.length) sections.push(`Logs:\n${result.logs.join("\n")}`);
      if (tab && !tab.page.isClosed()) sections.push(...manager.drainEvents(tab).map((event) => `Event: ${event}`));
      return clipToFile(store, "scripts", "run-script-result", sections.join("\n"), input.max_chars ?? 10_000);
    },
  });

  defineTool(server, deps, {
    name: "collect_pages",
    title: "Collect many pages",
    description:
      "Open a list of URLs in parallel tabs, save each page's content to files, close the tabs, and return a compact index (status, final URL, title, text length, file names, short preview). Use it to gather many pages without loading them into the conversation; then read or grep the files you need. Per page it can save the visible text, the list of links, the accessibility snapshot, and a screenshot.",
    input: {
      urls: z.array(z.string().min(1)).min(1).max(200).describe("URLs to load. https:// is assumed when no scheme is given."),
      include: z
        .array(z.enum(["text", "markdown", "links", "snapshot", "screenshot", "structured"]))
        .optional()
        .describe("What to save per page. markdown saves the content as a .md file with headings, lists, links, code blocks and tables kept. structured saves JSON-LD, meta tags and tables as JSON and adds product name, price and availability to the index when the page declares them. Default [\"text\"]."),
      scope: z.enum(["main", "page"]).optional().describe("For text and markdown: main keeps the main content area when the page marks one; page keeps everything. Default main."),
      full_page: z.boolean().optional().describe("For screenshot: capture the whole scrollable page instead of the viewport. Default true."),
      concurrency: z.number().int().min(1).max(12).optional().describe("Tabs loading at once. Default 6."),
      wait_until: waitUntilParam,
      settle_ms: z.number().int().min(0).max(30_000).optional().describe("Extra wait after the navigation milestone, for pages that render content with JavaScript. Default 800."),
      timeout_ms: timeoutParam(30_000),
      preview_chars: z.number().int().min(0).max(2000).optional().describe("Characters of text shown per page in the index; 0 for none. Default 160."),
      label: z.string().optional().describe("Short name used in the output folder name."),
    },
    handler: async (input, owner) => {
      const { dir, results } = await collectPages(manager, store, owner, {
        urls: input.urls,
        include: input.include ?? ["text"],
        scope: input.scope ?? "main",
        concurrency: input.concurrency ?? 6,
        waitUntil: input.wait_until ?? "domcontentloaded",
        settleMs: input.settle_ms ?? 800,
        timeoutMs: input.timeout_ms ?? 30_000,
        fullPage: input.full_page ?? true,
        previewChars: input.preview_chars ?? 160,
        label: input.label,
      });
      return renderCollectIndex(dir, results);
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
    name: "network_requests",
    title: "Network requests",
    description:
      "List recent network responses and failures of a tab (id, method, status, type, URL), newest last, or return the headers and body of one request by id. Useful for finding the API call behind a page and reading its JSON directly. Credential headers are masked.",
    input: {
      tab: tabParam,
      id: z.number().int().optional().describe("Return details and response body of this request id instead of the list."),
      pattern: z.string().optional().describe("Keep only requests whose URL contains this, case-insensitive."),
      failed_only: z.boolean().optional().describe("Keep only failed requests and HTTP status 400 or higher. Default false."),
      types: z.array(z.string()).optional().describe("Keep only these resource types, for example [\"xhr\", \"fetch\", \"document\"]."),
      limit: z.number().int().min(1).max(400).optional().describe("Maximum entries to list. Default 40."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for a response body. Default 8000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.id !== undefined) {
        const entry = tab.network.find((candidate) => candidate.id === input.id);
        if (!entry) throw new ToolError(`Request ${input.id} is no longer in the buffer of ${tab.id}.`, "List requests again; only the most recent ones are kept.");
        const lines = [`${entry.method} ${entry.status ?? entry.failure} ${entry.url}`];
        if (entry.response) {
          const headers = await entry.response.allHeaders().catch(() => ({}) as Record<string, string>);
          for (const [name, value] of Object.entries(headers)) {
            lines.push(`${name}: ${SENSITIVE_HEADERS.has(name.toLowerCase()) ? "<masked>" : value}`);
          }
          const body = entry.body
            ? entry.body.toString("utf8")
            : await entry.response.text().catch((error: Error) => `<body unavailable: ${error.message.split("\n")[0]}>`);
          lines.push("", await clipToFile(store, "network", `${tab.id}-request-${entry.id}`, body, input.max_chars ?? 8000));
        }
        return untrusted(tab.page.url(), lines.join("\n"));
      }

      const pattern = input.pattern?.toLowerCase();
      const entries = tab.network
        .filter((entry) => !pattern || entry.url.toLowerCase().includes(pattern))
        .filter((entry) => !input.failed_only || entry.failure !== undefined || (entry.status ?? 0) >= 400)
        .filter((entry) => !input.types || input.types.includes(entry.resourceType))
        .slice(-(input.limit ?? 40));
      if (entries.length === 0) return `No matching network entries for ${tab.page.url()}.`;
      return untrusted(
        tab.page.url(),
        entries.map((entry) => `#${entry.id} ${entry.method} ${entry.status ?? `FAILED ${entry.failure}`} ${entry.resourceType} ${entry.url.slice(0, 300)}`).join("\n"),
      );
    },
  });

  defineTool(server, deps, {
    name: "network_export",
    title: "Export network as HAR",
    description:
      "Write the captured network traffic of a tab to a HAR 1.2 file (request and response headers, post data, timings, and response bodies up to 2 MB each) and return its path. The file opens in browser DevTools and other HAR tools, and can be searched with file tools. It contains cookies and tokens as sent. Capture covers the most recent 1000 requests since the tab was opened.",
    input: {
      tab: tabParam,
      pattern: z.string().optional().describe("Export only requests whose URL contains this, case-insensitive."),
      types: z.array(z.string()).optional().describe("Export only these resource types, for example [\"xhr\", \"fetch\"]."),
      include_bodies: z.boolean().optional().describe("Include response bodies. Default true."),
      label: z.string().optional().describe("Short name used in the file name."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const pattern = input.pattern?.toLowerCase();
      const entries = tab.network
        .filter((entry) => !pattern || entry.url.toLowerCase().includes(pattern))
        .filter((entry) => !input.types || input.types.includes(entry.resourceType));
      if (entries.length === 0) return `No matching network entries captured for ${tab.id}.`;
      const har = await buildHar(entries, input.include_bodies ?? true, tab.page.url());
      const file = await store.write("har", store.uniqueName(input.label ?? `${tab.id}-network`, "har"), JSON.stringify(har, null, 1));
      return `Exported ${entries.length} requests to ${file}`;
    },
  });

  defineTool(server, deps, {
    name: "intercept",
    title: "Intercept requests",
    description: [
      "Add, list or remove rules that intercept the network requests of a tab. A rule matches request URLs by substring (or regex) and applies one mode:",
      "block aborts the request; modify changes the outgoing request (headers, method, body, or target URL) and lets it continue; mock answers without contacting the server; patch_response fetches the real response and replaces text in its body.",
      "Rules stay active until removed or the tab closes, and each reports how many requests it has hit. The Cookie header cannot be changed by a rule; use cookies to add or change cookies instead. For logic beyond these modes, call page.route() from run_script.",
    ].join("\n"),
    input: {
      tab: tabParam,
      action: z.enum(["add", "list", "remove", "clear"]).describe("add creates a rule; list shows rules and hit counts; remove deletes rule_id; clear deletes all rules of the tab."),
      url: z.string().optional().describe("For add: match requests whose URL contains this text."),
      regex: z.boolean().optional().describe("Treat url as a case-insensitive regular expression. Default false."),
      mode: z.enum(["block", "modify", "mock", "patch_response"]).optional().describe("For add: what the rule does. Default modify."),
      set_headers: z.record(z.string(), z.string()).optional().describe("modify, patch_response: request headers to set or override."),
      remove_headers: z.array(z.string()).optional().describe("modify, patch_response: request header names to remove."),
      method: z.string().optional().describe("modify: replace the HTTP method."),
      post_data: z.string().optional().describe("modify: replace the request body."),
      rewrite_url: z.string().optional().describe("modify: send the request to this URL instead (same protocol)."),
      mock_status: z.number().int().min(100).max(599).optional().describe("mock: HTTP status. Default 200."),
      mock_headers: z.record(z.string(), z.string()).optional().describe("mock: response headers."),
      mock_content_type: z.string().optional().describe("mock: Content-Type. Default application/json."),
      mock_body: z.string().optional().describe("mock: response body."),
      replacements: z
        .array(z.object({ find: z.string().min(1), replace: z.string() }))
        .optional()
        .describe("patch_response: literal text replacements applied to the response body in order."),
      rule_id: z.number().int().optional().describe("For remove: the rule number from list."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      if (input.action === "list") return listRules(tab);
      if (input.action === "clear") return `Removed ${await clearRules(tab)} rules from ${tab.id}.`;
      if (input.action === "remove") {
        if (input.rule_id === undefined) throw new ToolError("remove needs rule_id.");
        const removed = await removeRule(tab, input.rule_id);
        return `Removed rule #${removed.id} (${removed.summary}) after ${removed.hits} hits.`;
      }
      if (!input.url) throw new ToolError("add needs url.");
      const rule = await addRule(tab, {
        url: input.url,
        regex: input.regex ?? false,
        mode: input.mode ?? "modify",
        setHeaders: input.set_headers,
        removeHeaders: input.remove_headers,
        method: input.method,
        postData: input.post_data,
        rewriteUrl: input.rewrite_url,
        mockStatus: input.mock_status,
        mockHeaders: input.mock_headers,
        mockBody: input.mock_body,
        mockContentType: input.mock_content_type,
        replacements: input.replacements,
      });
      return `Added rule #${rule.id} on ${tab.id}: ${rule.summary}. It applies to requests made from now on.`;
    },
  });

  defineTool(server, deps, {
    name: "cookies",
    title: "Cookies",
    description:
      "Read, set, delete or export the browser's cookies. The cookie jar is shared by all tabs of the profile. list shows matching cookies with their attributes; set adds or replaces one cookie, which is then sent with matching requests; delete removes matching cookies; export writes all matching cookies with full values to a JSON file. Deleting or replacing a session cookie signs the user out of that site.",
    input: {
      action: z.enum(["list", "set", "delete", "export"]).describe("What to do."),
      tab: tabParam.optional().describe("For list and export: only cookies that would be sent to this tab's current URL. For set: default URL for the cookie."),
      domain: z.string().optional().describe("For list, delete, export: keep cookies whose domain contains this. For set: the cookie's domain, for example .example.com."),
      name: z.string().optional().describe("Cookie name. Required for set; a filter for list, delete and export."),
      value: z.string().optional().describe("For set: cookie value."),
      path: z.string().optional().describe("For set: cookie path. Default /."),
      url: z.string().optional().describe("For set: URL the cookie belongs to, as an alternative to domain and path."),
      expires_in_seconds: z.number().int().optional().describe("For set: lifetime from now. Omit for a session cookie."),
      http_only: z.boolean().optional().describe("For set. Default false."),
      secure: z.boolean().optional().describe("For set. Default true for https URLs."),
      same_site: z.enum(["Strict", "Lax", "None"]).optional().describe("For set."),
      full_values: z.boolean().optional().describe("For list: show whole values instead of the first 60 characters. Default false."),
    },
    handler: async (input) => {
      const context = await manager.ensureContext();
      const tab = input.tab ? manager.getTab(input.tab) : undefined;

      if (input.action === "set") {
        if (!input.name || input.value === undefined) throw new ToolError("set needs name and value.");
        const url = input.domain ? undefined : (input.url ?? tab?.page.url());
        if (!input.domain && !url) throw new ToolError("set needs domain, url, or tab to know which site the cookie belongs to.");
        await context.addCookies([
          {
            name: input.name,
            value: input.value,
            ...(input.domain ? { domain: input.domain, path: input.path ?? "/" } : { url }),
            expires: input.expires_in_seconds === undefined ? undefined : Math.floor(Date.now() / 1000) + input.expires_in_seconds,
            httpOnly: input.http_only,
            secure: input.secure ?? (input.domain ? undefined : url?.startsWith("https:")),
            sameSite: input.same_site,
          },
        ]);
        return `Set cookie ${input.name} for ${input.domain ?? url}.`;
      }

      const domain = input.domain?.toLowerCase();
      const cookies = (await context.cookies(tab ? [tab.page.url()] : undefined))
        .filter((cookie) => !domain || cookie.domain.toLowerCase().includes(domain))
        .filter((cookie) => !input.name || cookie.name === input.name);

      if (input.action === "delete") {
        if (!input.domain && !input.name) throw new ToolError("delete needs domain or name, so it cannot wipe every cookie by accident.");
        for (const cookie of cookies) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
        return `Deleted ${cookies.length} cookies.`;
      }
      if (cookies.length === 0) return "No matching cookies.";
      if (input.action === "export") {
        const file = await store.write("cookies", store.uniqueName(input.domain ?? tab?.id ?? "cookies", "json"), JSON.stringify(cookies, null, 2));
        return `Exported ${cookies.length} cookies to ${file}`;
      }
      return cookies
        .map((cookie) => {
          const value = input.full_values || cookie.value.length <= 60 ? cookie.value : `${cookie.value.slice(0, 60)}… (${cookie.value.length} chars)`;
          const flags = [cookie.httpOnly ? "HttpOnly" : "", cookie.secure ? "Secure" : "", cookie.sameSite, cookie.expires > 0 ? `expires ${new Date(cookie.expires * 1000).toISOString().slice(0, 10)}` : "session"].filter(Boolean).join(" ");
          return `${cookie.domain}${cookie.path} ${cookie.name}=${value} [${flags}]`;
        })
        .join("\n");
    },
  });

  defineTool(server, deps, {
    name: "jobs",
    title: "Background jobs",
    description:
      "List, inspect or cancel background jobs started by run_script with background: true. status shows the state, the most recent log lines and the log and result file paths. Jobs are kept in memory, so they end if the server restarts. Cancelling aborts the script at its next browser call or sleep and closes the tabs it opened.",
    input: {
      action: z.enum(["list", "status", "cancel"]).describe("list shows all jobs; status and cancel need id."),
      id: z.string().optional().describe("Job id such as j1."),
    },
    handler: async (input) => {
      if (input.action === "list") {
        const all = jobs.list();
        return all.length ? all.map((job) => describeJob(job, false)).join("\n") : "No background jobs.";
      }
      if (!input.id) throw new ToolError(`${input.action} needs id.`);
      if (input.action === "cancel") {
        const job = jobs.cancel(input.id);
        await Promise.race([job.finished, new Promise((resolve) => setTimeout(resolve, 3000))]);
        return describeJob(job, true);
      }
      return describeJob(jobs.get(input.id), true);
    },
  });

  defineTool(server, deps, {
    name: "request",
    title: "Send HTTP request with the browser session",
    description: [
      "Send an HTTP request that carries the browser's cookies, and return the status, headers and body. Two uses: call a site's API directly instead of scraping the rendered page, and replay a captured request with changes (from_request takes an id from network_requests and copies its method, URL, headers and body; any field given here overrides the copy).",
      "via browser (default) sends from the browser's network stack outside any page: no CORS limits, good for downloads and cross-site calls. via page runs fetch() inside the tab, so the request has the page's origin, referrer and same-site context, which some APIs require.",
      "Replaying a request that changes data (POST, PUT, DELETE) repeats its effect. Bodies above max_chars and binary responses are saved to a file.",
    ].join("\n"),
    input: {
      tab: tabParam.optional().describe("Tab to take from_request from, and the page to run in for via page."),
      from_request: z.number().int().optional().describe("Id of a captured request (from network_requests) to replay."),
      url: z.string().optional().describe("Request URL. Required unless from_request is given."),
      method: z.string().optional().describe("HTTP method. Default GET, or the replayed request's method."),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to set or override."),
      remove_headers: z.array(z.string()).optional().describe("Header names to drop from a replayed request."),
      query: z.record(z.string(), z.string()).optional().describe("Query parameters to set or override on the URL."),
      body: z.string().optional().describe("Request body. For JSON, pass the JSON text and a content-type header."),
      via: z.enum(["browser", "page"]).optional().describe("Where the request is sent from. Default browser."),
      save: z.boolean().optional().describe("Always save the response body to a file and return its path. Default false."),
      timeout_ms: timeoutParam(30_000),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the body in the result. Default 8000."),
    },
    handler: async (input) => {
      const tab = input.tab ? manager.getTab(input.tab) : undefined;
      const source = input.from_request === undefined ? undefined : tab?.network.find((entry) => entry.id === input.from_request);
      if (input.from_request !== undefined && !source) {
        throw new ToolError(`Request ${input.from_request} is not in the buffer${tab ? ` of ${tab.id}` : ""}.`, "Pass the tab it was captured in, and list network_requests for current ids.");
      }
      const rawUrl = input.url ?? source?.url;
      if (!rawUrl) throw new ToolError("Give url or from_request.");
      const url = new URL(normalizeUrl(rawUrl));
      for (const [name, value] of Object.entries(input.query ?? {})) url.searchParams.set(name, value);

      const headers: Record<string, string> = {};
      if (source) {
        const dropped = new Set(["host", "content-length", "cookie", "connection", ...(input.remove_headers ?? []).map((name) => name.toLowerCase())]);
        for (const [name, value] of Object.entries(await source.request.allHeaders())) {
          if (!name.startsWith(":") && !dropped.has(name.toLowerCase())) headers[name] = value;
        }
      }
      Object.assign(headers, input.headers ?? {});
      const method = (input.method ?? source?.method ?? "GET").toUpperCase();
      const body = input.body ?? source?.request.postData() ?? undefined;
      const timeout = input.timeout_ms ?? 30_000;

      let status: number;
      let responseHeaders: Record<string, string>;
      let payload: Buffer;
      if (input.via === "page") {
        if (!tab) throw new ToolError("via page needs tab.");
        const result = await tab.page.evaluate(
          async ([target, init]) => {
            const response = await fetch(target, init);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = "";
            for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
            return { status: response.status, headers: Object.fromEntries(response.headers), base64: btoa(binary) };
          },
          [url.href, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body, credentials: "include" as const }] as const,
        );
        status = result.status;
        responseHeaders = result.headers;
        payload = Buffer.from(result.base64, "base64");
      } else {
        const context = await manager.ensureContext();
        const response = await context.request.fetch(url.href, { method, headers, data: body, timeout, failOnStatusCode: false });
        status = response.status();
        responseHeaders = response.headers();
        payload = await response.body();
      }

      const contentType = responseHeaders["content-type"] ?? "";
      const isText = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|[\w.+-]*\+json|[\w.+-]*\+xml))/i.test(contentType) || payload.length === 0;
      const lines = [`${method} ${url.href} → HTTP ${status}`, `content-type: ${contentType || "-"} · ${payload.length} bytes`];
      for (const name of ["location", "set-cookie", "content-disposition", "retry-after", "x-ratelimit-remaining"]) {
        if (responseHeaders[name]) lines.push(`${name}: ${name === "set-cookie" ? "<masked>" : responseHeaders[name]}`);
      }
      if (!isText || input.save) {
        const extension = /json/i.test(contentType) ? "json" : /html/i.test(contentType) ? "html" : /pdf/i.test(contentType) ? "pdf" : isText ? "txt" : "bin";
        const file = await store.write("requests", store.uniqueName(url.hostname + url.pathname, extension), payload);
        lines.push(`Body saved to ${file}`);
        if (!isText) return lines.join("\n");
      }
      lines.push("", await clipToFile(store, "requests", url.hostname + url.pathname, payload.toString("utf8"), input.max_chars ?? 8000));
      return untrusted(url.href, lines.join("\n"));
    },
  });

  defineTool(server, deps, {
    name: "extract",
    title: "Extract structured data",
    description:
      "Return the machine-readable data a page declares: JSON-LD objects (products with price and availability, articles, events, breadcrumbs), Open Graph and other meta tags, and every HTML table as rows. Tables are also saved as CSV files. Faster and more reliable than reading prices or specs out of the page text when the site provides them; a price here is what the page declares, which can differ from a signed-in or checkout price.",
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
      "Save the current page to a file and return its path: pdf (printed page, as from the print dialog), mhtml (single-file archive with images and styles, opens in Chrome), or html (the current DOM as markup). Use it to keep receipts, invoices, confirmations and reference pages.",
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

  defineTool(server, deps, {
    name: "handoff",
    title: "Hand a step to the user",
    description:
      "Ask the user to do something in the browser that only they can do (a CAPTCHA, a code sent to their phone or email, a passkey or bank approval), then wait until it is done. Brings the tab to the front, shows a desktop notification with your message, and returns when the given condition holds. Give one of until_text, until_gone or until_url; with none it waits for the tab to navigate. If the time runs out the user has not finished: ask them in the conversation rather than retrying.",
    input: {
      tab: tabParam,
      message: z.string().min(1).max(300).describe("What the user needs to do, in one sentence, for example: Enter the SMS code on the bank page."),
      until_text: z.string().optional().describe("Done when this text is visible on the page."),
      until_gone: z.string().optional().describe("Done when this text is no longer visible, for example the challenge prompt."),
      until_url: z.string().optional().describe("Done when the tab's URL contains this."),
      timeout_ms: z.number().int().min(5000).max(1_800_000).optional().describe("How long to wait for the user. Default 300000 (5 minutes)."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 300_000;
      await tab.page.bringToFront().catch(() => undefined);
      execFile("notify-send", ["-a", "web-agent", "-u", "critical", "The browser agent needs you", `${input.message} (tab ${tab.id})`], () => undefined);

      const waiting = input.until_text
        ? tab.page.getByText(input.until_text).first().waitFor({ state: "visible", timeout })
        : input.until_gone
          ? tab.page.getByText(input.until_gone).first().waitFor({ state: "hidden", timeout })
          : input.until_url
            ? tab.page.waitForURL((url) => url.href.includes(input.until_url ?? ""), { timeout })
            : tab.page.waitForEvent("framenavigated", { predicate: (frame) => frame === tab.page.mainFrame(), timeout });
      try {
        await waiting;
      } catch (error) {
        if (/Timeout/i.test(String(error))) {
          throw new ToolError(
            `The user has not completed the step within ${Math.round(timeout / 1000)} s: ${input.message}`,
            `Tab ${tab.id} is still at ${tab.page.url()}. Tell the user what is waiting and continue when they confirm.`,
          );
        }
        throw error;
      }
      return `The user completed the step. Tab ${tab.id} is at ${await describePage(tab.page)}`;
    },
  });

  defineTool(server, deps, {
    name: "site_notes",
    title: "Site notes",
    description:
      "Read or add to the notes kept for one website, a Markdown file per host name that survives between sessions. Record what took effort to find out: working selectors, API endpoints and their parameters, pagination schemes, login steps, rate limits and quirks; the next visit then starts from them. tab_open and navigate mention when a host has notes. Notes are written by agents, not by the site, and are not shared with any other machine.",
    input: {
      action: z.enum(["read", "append"]).describe("read returns the notes; append adds one dated line."),
      tab: tabParam.optional().describe("Use the host of this tab's current URL."),
      site: z.string().optional().describe("Host name or URL, for example shop.example.com, when no tab is given. A leading www. is ignored."),
      note: z.string().max(2000).optional().describe("For append: the note, one line, for example: search API is GET /api/search?q=&page= returning JSON; 24 items per page."),
    },
    handler: async (input) => {
      const source = input.site ?? (input.tab ? manager.getTab(input.tab).page.url() : undefined);
      if (!source) throw new ToolError("Give tab or site.");
      const host = siteHost(source);
      const { sitesDir } = manager.config;
      if (input.action === "append") {
        if (!input.note) throw new ToolError("append needs note.");
        const file = await appendSiteNote(sitesDir, host, input.note);
        return `Added a note for ${host} to ${file}.`;
      }
      const notes = await readSiteNotes(sitesDir, host);
      if (!notes) return `No notes for ${host} yet. Add one with action append once you learn something worth keeping.`;
      return `Notes for ${host} (${siteNotesPath(sitesDir, host)}):\n${notes.trimEnd()}`;
    },
  });

  defineTool(server, deps, {
    name: "dismiss_overlays",
    title: "Dismiss cookie banners and modals",
    description:
      "Make one pass over the page and its iframes, find cookie and consent banners, newsletter pop-ups and other modals, and click the control that closes each one, preferring reject all, then only necessary, then close, and accept only when nothing else is offered. Buttons are recognised by their accessible name in English, Turkish, German, French and Spanish. Reports what it clicked, or that nothing was found. Use it when a banner covers the page or a click reports that another element intercepts pointer events; it does not install anything that runs later, so call it again after a navigation if a new banner appears.",
    input: {
      tab: tabParam,
      allow_accept: z.boolean().optional().describe("Click an accept or OK button when a banner offers no reject or close control. Default true."),
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const allowAccept = input.allow_accept ?? true;
      return runAction(manager, store, tab, async () => describeOverlayClicks(await dismissOverlays(tab.page, allowAccept), allowAccept), {
        includeSnapshot: input.include_snapshot,
      });
    },
  });

  defineTool(server, deps, {
    name: "emulate",
    title: "Emulate device and conditions",
    description: [
      "Change how one tab presents itself and what conditions it runs under: viewport and mobile mode, color scheme, reduced motion, geolocation, time zone, locale, user agent, offline mode and network throttling. Settings combine across calls and stay until reset: true or until the tab closes; the result lists everything active.",
      "All settings apply to this tab only, except one: geolocation also grants the geolocation permission to the tab's current origin for the whole browser profile, and reset clears permission grants made by the agent. Locale changes Intl formatting and the Accept-Language header but not navigator.language in every Chrome version. Reload the page after changing locale, time zone or user agent so the site sees the new values from the start.",
      "For a plain viewport size without mobile emulation, tab_resize is simpler.",
    ].join("\n"),
    input: {
      tab: tabParam,
      viewport: z
        .object({
          preset: z.enum(Object.keys(VIEWPORT_PRESETS) as [keyof typeof VIEWPORT_PRESETS, ...(keyof typeof VIEWPORT_PRESETS)[]]).optional().describe("mobile 390x844 @3x with touch, tablet 820x1180 @2x with touch, laptop 1366x768, desktop 1920x1080."),
          width: z.number().int().min(200).max(7680).optional().describe("Width in CSS pixels; overrides the preset."),
          height: z.number().int().min(200).max(4320).optional().describe("Height in CSS pixels; overrides the preset."),
          mobile: z.boolean().optional().describe("Mobile mode with touch events; overrides the preset."),
          scale: z.number().min(1).max(4).optional().describe("Device pixel ratio; overrides the preset."),
        })
        .optional()
        .describe("Viewport to emulate: a preset, a size, or both."),
      color_scheme: z.enum(["light", "dark", "none"]).optional().describe("prefers-color-scheme to report; none removes the override."),
      reduced_motion: z.enum(["reduce", "no-preference", "none"]).optional().describe("prefers-reduced-motion to report; none removes the override."),
      geolocation: z
        .object({
          latitude: z.number().min(-90).max(90).describe("Latitude in degrees."),
          longitude: z.number().min(-180).max(180).describe("Longitude in degrees."),
          accuracy: z.number().min(0).optional().describe("Accuracy in meters. Default 10."),
        })
        .optional()
        .describe("Position reported by navigator.geolocation; the permission is granted to the tab's origin."),
      timezone: z.string().optional().describe("IANA time zone such as Europe/Istanbul; an empty string removes the override."),
      locale: z.string().optional().describe("Locale such as de-DE; an empty string removes the override."),
      user_agent: z.string().optional().describe("User agent string to send and report; an empty string removes the override."),
      offline: z.boolean().optional().describe("true cuts the tab off the network; false restores it."),
      network: z.enum(["slow3g", "fast3g", "none"]).optional().describe("Throttle the tab's network: slow3g about 2 s latency and 50 KB/s, fast3g about 560 ms and 180 KB/s, none removes throttling."),
      reset: z.boolean().optional().describe("Clear every setting this tool made on the tab before applying the others. Default false."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const lines: string[] = [];
      if (input.reset) {
        const cleared = await resetEmulation(tab.page);
        lines.push(cleared.length ? `Cleared: ${cleared.join(", ")}.` : "Nothing was being emulated.");
      }
      const settings = await emulate(tab.page, {
        viewport: input.viewport,
        colorScheme: input.color_scheme,
        reducedMotion: input.reduced_motion,
        geolocation: input.geolocation,
        timezone: input.timezone,
        locale: input.locale,
        offline: input.offline,
        network: input.network,
        userAgent: input.user_agent,
      });
      lines.push(describeEmulation(settings));
      return lines.join("\n");
    },
  });

  defineTool(server, deps, {
    name: "storage",
    title: "Site storage",
    description:
      "Read the localStorage, sessionStorage or IndexedDB of the origin a tab is on. list shows keys with value sizes (for IndexedDB: database/store names with record counts); get returns one value (for IndexedDB: every record of one store) clipped to max_chars with the full value saved to a file; export writes the whole area to a JSON file and returns its path. Values often hold tokens and app state, which makes this the quickest way to see what a single-page app knows. It only reads; to change storage use evaluate.",
    input: {
      tab: tabParam,
      action: z.enum(["list", "get", "export"]).describe("What to do."),
      area: z.enum(["local", "session", "indexeddb"]).describe("localStorage, sessionStorage, or IndexedDB."),
      key: z.string().optional().describe("For get: the storage key, or for indexeddb the database/store name (the store name alone works when it is unique)."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for get. Default 8000."),
    },
    readOnly: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const origin = storageOrigin(tab.page);
      const label = `${input.area}Storage`.replace("indexeddbStorage", "IndexedDB");
      if (input.area === "indexeddb") {
        if (input.action === "list") {
          const stores = await listIndexedDb(tab.page);
          if (stores.length === 0) return `No IndexedDB databases for ${origin}.`;
          return untrusted(tab.page.url(), stores.map((entry) => `${entry.database}/${entry.store} (${entry.count < 0 ? "?" : entry.count} records)`).join("\n"));
        }
        if (input.action === "export") {
          const { stores, data } = await exportIndexedDb(tab.page);
          const file = await store.write("storage", store.uniqueName(`${origin}-indexeddb`, "json"), JSON.stringify({ origin, databases: data }, null, 2));
          return `Exported ${stores.length} IndexedDB object stores of ${origin} to ${file}`;
        }
        if (!input.key) throw new ToolError("get needs key (database/store).");
        const found = splitStoreKey(input.key, await listIndexedDb(tab.page));
        const { records, truncated } = await readIndexedDbStore(tab.page, found.database, found.store);
        const note = truncated ? `\n[stopped after ${records.length} records; use export or run_script for the rest]` : "";
        const body = await clipToFile(store, "storage", `${origin}-${found.database}-${found.store}`, JSON.stringify(records, null, 2), input.max_chars ?? 8000);
        return untrusted(tab.page.url(), `${found.database}/${found.store}: ${records.length} records\n${body}${note}`);
      }
      const entries = await readWebStorage(tab.page, input.area);
      const keys = Object.keys(entries);
      if (input.action === "export") {
        const file = await store.write("storage", store.uniqueName(`${origin}-${input.area}`, "json"), JSON.stringify({ origin, area: input.area, entries }, null, 2));
        return `Exported ${keys.length} ${label} entries of ${origin} to ${file}`;
      }
      if (input.action === "list") {
        if (keys.length === 0) return `${label} of ${origin} is empty.`;
        return untrusted(tab.page.url(), keys.map((key) => `${key} (${entries[key]?.length ?? 0} chars)`).join("\n"));
      }
      if (input.key === undefined) throw new ToolError("get needs key.");
      const value = entries[input.key];
      if (value === undefined) throw new ToolError(`${label} of ${origin} has no key ${JSON.stringify(input.key)}.`, "List the keys with action list.");
      return untrusted(tab.page.url(), await clipToFile(store, "storage", `${origin}-${input.key}`, value, input.max_chars ?? 8000));
    },
  });

  defineTool(server, deps, {
    name: "ask_pages",
    title: "Ask a question over many pages",
    description: [
      "Answer one question over many pages without their content entering this conversation. The pages go to a smaller model (Claude Haiku by default) in a few large calls; each call returns short answer lines that name the page every fact came from, and this tool returns only those lines merged, the pages where nothing relevant was found, and any failed calls. The full answers are also saved to a file.",
      "Use it after collect_pages for comparisons, price or spec tables, or finding which pages mention something; give exactly one source of pages: files, dir (a collect_pages folder), urls (collected first), or tabs. The model sees only the page text, so it cannot click, follow links or check anything; for work that needs that, use run_script or a subagent. Answers are as reliable as a fast model reading quickly: verify the facts a decision depends on.",
    ].join("\n"),
    input: {
      question: z.string().min(3).max(4000).describe("The question, phrased so it can be answered from each page on its own, for example: What is the price and battery life of the laptop on this page?"),
      files: z.array(z.string().min(1)).max(500).optional().describe("Absolute paths of text or Markdown files to read."),
      dir: z.string().optional().describe("A collect_pages output folder; its .md files are used, or .txt where a page has no .md."),
      urls: z.array(z.string().min(1)).max(200).optional().describe("URLs to collect as Markdown first (like collect_pages) and then ask about."),
      tabs: z.array(tabParam).max(50).optional().describe("Open tabs whose current main content is read as Markdown."),
      batch_chars: z.number().int().min(5000).max(600_000).optional().describe("Total page characters per model call; pages are packed in order until this is reached. Default 150000."),
      max_pages_per_batch: z.number().int().min(1).max(100).optional().describe("Most pages in one model call. Default 20."),
      max_chars_per_page: z.number().int().min(1000).max(400_000).optional().describe("Longer pages keep their start and end and lose the middle. Default 30000."),
      concurrency: z.number().int().min(1).max(8).optional().describe("Model calls running at once. Default 4."),
      model: z.string().optional().describe("haiku (default), sonnet, or a full model id understood by the adapter."),
      timeout_ms: z.number().int().min(10_000).max(900_000).optional().describe("Time limit per model call in milliseconds. Default 180000."),
    },
    readOnly: true,
    handler: async (input, owner) => {
      const given = [input.files, input.dir, input.urls, input.tabs].filter((value) => value !== undefined).length;
      if (given !== 1) throw new ToolError("Give exactly one of files, dir, urls, tabs.");
      const documents: AskDocument[] = [];
      if (input.files) {
        for (const file of input.files) {
          const text = await readFile(file, "utf8").catch(() => undefined);
          if (text === undefined) throw new ToolError(`Cannot read ${file}.`, "Pass absolute paths of existing text files.");
          documents.push({ source: path.basename(file), text });
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
                settleMs: 800,
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
      const usable = documents.filter((document) => document.text.trim());
      if (usable.length === 0) throw new ToolError("All pages are empty.");

      const adapter = await deps.ask.get();
      const model = input.model ?? "haiku";
      const results = await askPages(adapter, {
        question: input.question,
        documents: usable,
        batchChars: input.batch_chars ?? 150_000,
        maxPagesPerBatch: input.max_pages_per_batch ?? 20,
        maxCharsPerPage: input.max_chars_per_page ?? 30_000,
        concurrency: input.concurrency ?? 4,
        model,
        maxTokens: 4000,
        timeoutMs: input.timeout_ms ?? 180_000,
      });
      const rendered = renderAskResults(input.question, results, adapter.name, model);
      const file = await store.write("ask", store.uniqueName(input.question, "md"), `${rendered}\n\n<!-- raw -->\n${JSON.stringify(results, null, 2)}\n`);
      return `${await clipToFile(store, "ask", "ask-answers", rendered, 12_000)}\nFull answers: ${file}`;
    },
  });

  defineTool(server, deps, {
    name: "secrets_list",
    title: "List stored secrets",
    description:
      "List the names of entries in the user's password store, without their values. Pass a name to fill(secret=...) to enter a credential into a page; the value is read and typed by the server and is masked in tool output.",
    input: {
      query: z.string().optional().describe("Keep only names containing this, case-insensitive, for example a site name."),
    },
    readOnly: true,
    handler: async (input) => {
      const names = await secrets.list(input.query);
      if (names.length === 0) return input.query ? `No secret name contains ${JSON.stringify(input.query)}.` : "The password store has no entries.";
      return names.join("\n");
    },
  });
}
