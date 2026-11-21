import { z } from "zod";
import type { AskImage, AskImageMediaType, AskToolDefinition } from "../ask/adapter.ts";
import {
  imageSize,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_SIDE,
  prepareModelImage,
  type Transcode,
} from "../ask/model-images.ts";

type BrowseGuard = "click" | "press" | "select" | "search" | "navigate";

const toolValue = z.union([z.string(), z.number(), z.boolean()]);

export const browseInput = z
  .object({
    tab: z.string().optional(),
    target: z.string().optional(),
    url: z.string().optional(),
    key: z.string().optional(),
    option: z.string().optional(),
    text: z.string().optional(),
  })
  .catchall(toolValue);

export type BrowseInput = z.infer<typeof browseInput>;
export type McpArguments = Partial<Record<string, z.infer<typeof toolValue>>>;

export type BrowseTool = {
  name: string;
  description: string;
  schema: z.ZodObject;
  mcp?: string;
  toMcp(input: BrowseInput, tab: string): McpArguments;
  guard?: BrowseGuard;
  action?: boolean;
};

const tab = z
  .string()
  .optional()
  .describe("Which of this task's tabs to use, such as t14. Default: the tab you used last.");
const target = z
  .string()
  .min(1)
  .describe(
    "The element: a ref from the latest find or snapshot of the tab, such as e12 or f2e12, or a selector such as text=Yearly.",
  );

const strip = (input: BrowseInput) =>
  Object.fromEntries(
    Object.entries(input).filter(([key, value]) => key !== "tab" && value !== undefined),
  );
const onTab = (input: BrowseInput, current: string) => ({
  tab: input.tab ?? current,
});
const plain = (input: BrowseInput, current: string) => ({
  ...onTab(input, current),
  ...strip(input),
});
const withDiff = (input: BrowseInput, current: string) => ({
  ...plain(input, current),
  include_diff: true,
});

export const BROWSE_TOOLS: BrowseTool[] = [
  {
    name: "find",
    description:
      "Search the page's elements for text, a role or a value and return the matching lines with their refs and context. Use it first to locate a control such as a toggle, tab, button or link by its words.",
    schema: z.strictObject({
      query: z
        .string()
        .min(1)
        .describe(
          "Words to look for, such as Yearly, Specifications or Shipping; matched case-insensitively.",
        ),
      regex: z.boolean().optional().describe("Treat query as a regular expression."),
      tab,
    }),
    mcp: "find",
    toMcp: plain,
  },
  {
    name: "read_text",
    description:
      "Read the visible text of the page, or of one element with target. Long text comes in parts: the result says the offset to pass for the next part. markdown keeps headings, lists, tables and link URLs.",
    schema: z.strictObject({
      target: target.optional(),
      format: z.enum(["text", "markdown"]).optional().describe("text (default) or markdown."),
      offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Character offset to continue from, as the previous result said."),
      frames: z.boolean().optional().describe("Also read the text inside iframes."),
      tab,
    }),
    mcp: "read_text",
    toMcp: (input, current) => ({ ...onTab(input, current), scope: "page", ...strip(input) }),
  },
  {
    name: "snapshot",
    description:
      "List the page's elements as an indented tree with a ref on each, to see what you can act on. interactive true lists only buttons, links and fields, which is much shorter; target lists only one part of the page. Prefer find when you know the words you are after.",
    schema: z.strictObject({
      target: target.optional(),
      interactive: z.boolean().optional().describe("Only buttons, links and fields."),
      boxes: z.boolean().optional().describe("Add each element's position on screen."),
      tab,
    }),
    mcp: "snapshot",
    toMcp: plain,
  },
  {
    name: "screenshot",
    description:
      "Take a picture of what a visitor sees: the screen, the whole page with full_page, or one element with target. Use it for charts, images, hover effects and how a part of the page looks.",
    schema: z.strictObject({
      target: target.optional(),
      full_page: z.boolean().optional().describe("The whole page instead of the screen."),
      tab,
    }),
    mcp: "screenshot",
    toMcp: plain,
  },
  {
    name: "extract",
    description:
      "Return the data the page declares for machines: product prices and availability, and every table as rows. Often the most exact source of a price or a spec.",
    schema: z.strictObject({ tab }),
    mcp: "extract",
    toMcp: plain,
  },
  {
    name: "click",
    description:
      "Click an element by ref or selector, such as a toggle, a tab, a 'show more' button, an accordion header or a same-site link. The result says whether the page navigated or changed and lists the snapshot lines that changed. Buttons that buy, sign in, submit, subscribe, delete or download are refused.",
    schema: z.strictObject({ target, tab }),
    mcp: "click",
    toMcp: withDiff,
    guard: "click",
    action: true,
  },
  {
    name: "hover",
    description:
      "Move the mouse over an element and leave it there, to reveal menus, tooltips and card details that appear on hover. The result lists what appeared.",
    schema: z.strictObject({ target, tab }),
    mcp: "hover",
    toMcp: withDiff,
  },
  {
    name: "scroll",
    description:
      "Scroll an element into view with target, or scroll the page in a direction, to reach content that loads late or sits further down.",
    schema: z.strictObject({
      target: target.optional(),
      direction: z
        .enum(["down", "up", "left", "right", "top", "bottom"])
        .optional()
        .describe("Default down; top and bottom jump to the ends."),
      amount: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe("Pixels to scroll. Default 800."),
      tab,
    }),
    mcp: "scroll",
    toMcp: withDiff,
  },
  {
    name: "press",
    description:
      "Press a key: Escape closes a menu or dialog, Tab and Shift+Tab move focus, the arrow keys, PageUp, PageDown, Home and End move through lists and tabs, Space toggles. Enter works only outside forms. With target, the element gets focus first.",
    schema: z.strictObject({
      key: z.string().min(1).describe("Key name, such as Escape, ArrowDown or Shift+Tab."),
      target: target.optional(),
      tab,
    }),
    mcp: "press",
    toMcp: withDiff,
    guard: "press",
    action: true,
  },
  {
    name: "select_option",
    description:
      "Pick an option in a select box, or set a radio button or checkbox (option true or false), such as a region, size or billing period that changes what the page shows. Not for sign-in, checkout or other forms that send data.",
    schema: z.strictObject({
      target,
      option: z.string().describe("The option's label or value, or true or false for a checkbox."),
      tab,
    }),
    mcp: "fill",
    toMcp: (input, current) => ({
      ...onTab(input, current),
      target: input.target,
      text: input.option,
      include_diff: true,
    }),
    guard: "select",
    action: true,
  },
  {
    name: "search",
    description:
      "Type words into the site's search box and press Enter, to find a page of this site. Only search boxes are accepted.",
    schema: z.strictObject({
      target,
      text: z.string().min(1).describe("What to search for."),
      tab,
    }),
    mcp: "fill",
    toMcp: (input, current) => ({
      ...onTab(input, current),
      target: input.target,
      text: input.text,
      submit: true,
      include_diff: true,
    }),
    guard: "search",
    action: true,
  },
  {
    name: "wait_for",
    description:
      "Wait until a text appears, an element reaches a state, or the URL contains a text, for content that loads after an action. Give one of text, target or url.",
    schema: z.strictObject({
      text: z.string().min(1).optional().describe("Wait until this text is visible."),
      target: target.optional(),
      state: z
        .enum(["visible", "hidden", "attached", "detached"])
        .optional()
        .describe("State for target. Default visible."),
      url: z.string().min(1).optional().describe("Wait until the URL contains this."),
      tab,
    }),
    mcp: "wait_for",
    toMcp: plain,
  },
  {
    name: "navigate",
    description:
      "Load a URL of this site or of an allowed site in the tab, or go back or reload. Refs from before stop working; take a new find or snapshot.",
    schema: z.strictObject({ url: z.string().min(1).describe("A URL, or back or reload."), tab }),
    mcp: "navigate",
    toMcp: plain,
    guard: "navigate",
  },
  {
    name: "dismiss_overlays",
    description:
      "Close cookie banners, newsletter pop-ups and other overlays that cover the page, when a click fails because something is in the way.",
    schema: z.strictObject({ tab }),
    mcp: "dismiss_overlays",
    toMcp: plain,
  },
  {
    name: "list_tabs",
    description:
      "List this task's tabs with their URLs: the page you started on and any tabs a click opened.",
    schema: z.strictObject({}),
    toMcp: () => ({}),
  },
  {
    name: "close_tab",
    description: "Close a tab that a click opened during this task, when you are done with it.",
    schema: z.strictObject({ tab: z.string().min(1).describe("The tab to close, such as t15.") }),
    mcp: "tab_close",
    toMcp: (input) => ({ tab: input.tab, force: true }),
  },
];

export function browseTool(name: string) {
  return BROWSE_TOOLS.find((tool) => tool.name === name);
}

export function browseInputOf(tool: BrowseTool) {
  return tool.schema.pipe(browseInput);
}

export function browseDefinitions(): AskToolDefinition[] {
  return BROWSE_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema, { io: "input" }),
  }));
}

export const BROWSE_TOOL_DEFINITIONS = browseDefinitions();

export async function toModelImage(
  bytes: Buffer,
  mediaType: AskImageMediaType,
  transcode: Transcode,
  label: string,
): Promise<AskImage> {
  const size = imageSize(bytes);
  const fits =
    bytes.length <= MAX_IMAGE_BYTES &&
    (!size || Math.max(size.width, size.height) <= MAX_IMAGE_SIDE);
  if (fits || !size) return { mediaType, data: bytes.toString("base64"), label };
  const format = mediaType === "image/png" ? "png" : "jpeg";
  return (
    await prepareModelImage(
      { bytes, width: size.width, height: size.height },
      format,
      transcode,
      label,
    )
  ).image;
}
