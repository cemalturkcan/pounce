import { expect, test } from "bun:test";
import { z } from "zod";
import {
  BROWSE_TOOL_DEFINITIONS,
  BROWSE_TOOLS,
  type BrowseInput,
  browseDefinitions,
  browseTool,
  toModelImage,
} from "./tool-table.ts";
import { MAX_IMAGE_BYTES, type TranscodeTarget } from "../ask/model-images.ts";
import { collectToolCallbacks } from "../tools/callbacks.ts";
import type { ToolDeps } from "../tools/common.ts";

const mapped = (name: string, input: BrowseInput) => browseTool(name)?.toMcp(input, "t7");

test("actions map to their MCP tool on the current tab with include_diff", () => {
  expect(mapped("click", { target: "e3" })).toStrictEqual({
    tab: "t7",
    target: "e3",
    include_diff: true,
  });
  expect(mapped("hover", { target: "e4", tab: "t9" })).toStrictEqual({
    tab: "t9",
    target: "e4",
    include_diff: true,
  });
  expect(mapped("press", { key: "Escape" })).toStrictEqual({
    tab: "t7",
    key: "Escape",
    include_diff: true,
  });
  expect(mapped("scroll", { direction: "down", amount: 600 })).toStrictEqual({
    tab: "t7",
    direction: "down",
    amount: 600,
    include_diff: true,
  });
});

test("a browse scroll to the top or bottom becomes a scroll jump", () => {
  expect(mapped("scroll", { direction: "bottom" })).toStrictEqual({
    tab: "t7",
    to: "bottom",
    include_diff: true,
  });
});

test("select_option and search become fill calls, search with submit", () => {
  expect(browseTool("select_option")?.mcp).toBe("fill");
  expect(mapped("select_option", { target: "e5", option: "Yearly" })).toStrictEqual({
    tab: "t7",
    target: "e5",
    value: "Yearly",
    include_diff: true,
  });
  expect(mapped("search", { target: "e6", text: "lamp" })).toStrictEqual({
    tab: "t7",
    target: "e6",
    value: "lamp",
    submit: true,
    include_diff: true,
  });
});

test("find becomes a snapshot query", () => {
  expect(browseTool("find")?.mcp).toBe("snapshot");
  expect(mapped("find", { query: "Yearly", regex: true })).toStrictEqual({
    tab: "t7",
    query: "Yearly",
    regex: true,
  });
});

test("extract becomes read_page with format structured", () => {
  expect(browseTool("extract")?.mcp).toBe("read_page");
  expect(mapped("extract", {})).toStrictEqual({ tab: "t7", format: "structured" });
});

test("close_tab becomes tabs closing that one tab with force", () => {
  expect(browseTool("close_tab")?.mcp).toBe("tabs");
  expect(browseTool("close_tab")?.toMcp({ tab: "t8" }, "t8")).toStrictEqual({
    close: ["t8"],
    force: true,
  });
});

test("read_text becomes read_page on the whole page scope and navigate never forces", () => {
  expect(browseTool("read_text")?.mcp).toBe("read_page");
  expect(mapped("read_text", { format: "markdown", offset: 12000 })).toStrictEqual({
    tab: "t7",
    scope: "page",
    format: "markdown",
    offset: 12000,
  });
  expect(mapped("navigate", { url: "back" })).toStrictEqual({ tab: "t7", url: "back" });
  expect(
    browseTool("navigate")?.schema.safeParse({ url: "https://a.test", force: true }).success,
  ).toBe(false);
});

test("every mapped call fits the input schema of its MCP tool", () => {
  // SAFETY: registering the tools only stores their callbacks; no dependency is read until a callback runs, and this test never runs one
  const callbacks = collectToolCallbacks({} as ToolDeps);
  const samples = new Map<string, BrowseInput>([
    ["find", { query: "Yearly", regex: false }],
    ["read_text", { target: "e1", format: "text", offset: 0, frames: true }],
    ["snapshot", { target: "e1", interactive: true, boxes: true }],
    ["screenshot", { target: "e1", full_page: false }],
    ["extract", {}],
    ["click", { target: "e1" }],
    ["hover", { target: "e1" }],
    ["scroll", { target: "e1", direction: "up", amount: 10 }],
    ["press", { key: "Escape", target: "e1" }],
    ["select_option", { target: "e1", option: "x" }],
    ["search", { target: "e1", text: "x" }],
    ["wait_for", { text: "Done" }],
    ["navigate", { url: "https://a.test" }],
    ["dismiss_overlays", {}],
    ["close_tab", { tab: "t8" }],
  ]);
  for (const tool of BROWSE_TOOLS) {
    if (!tool.mcp) continue;
    const sample = samples.get(tool.name);
    expect(sample, tool.name).toBeDefined();
    expect(tool.schema.safeParse(sample).success).toBe(true);
    const target = callbacks.get(tool.mcp);
    expect(target, tool.mcp).toBeDefined();
    const parsed = (target?.schema ?? z.object({}))
      .strict()
      .safeParse(tool.toMcp(sample ?? {}, "t7"));
    expect(parsed.success).toBe(true);
  }
});

test("the tool definitions are built once with stable bytes and strict schemas", () => {
  expect(JSON.stringify(browseDefinitions())).toBe(JSON.stringify(BROWSE_TOOL_DEFINITIONS));
  for (const definition of BROWSE_TOOL_DEFINITIONS) {
    expect(definition.description.length).toBeGreaterThan(20);
    expect(definition.inputSchema.additionalProperties).toBe(false);
  }
  expect(BROWSE_TOOL_DEFINITIONS.map((definition) => definition.name)).toStrictEqual([
    "find",
    "read_text",
    "snapshot",
    "screenshot",
    "extract",
    "click",
    "hover",
    "scroll",
    "press",
    "select_option",
    "search",
    "wait_for",
    "navigate",
    "dismiss_overlays",
    "list_tabs",
    "close_tab",
  ]);
});

function jpeg(width: number, height: number, size: number) {
  const bytes = Buffer.alloc(size);
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ]).copy(bytes);
  return bytes;
}

test("16: small screenshots go to the model as they are, oversized ones are re-encoded", async () => {
  const calls: TranscodeTarget[] = [];
  const transcode = async (_bytes: Buffer, target: TranscodeTarget) => {
    calls.push(target);
    return Buffer.from("small");
  };
  const small = jpeg(800, 600, 2000);
  expect(await toModelImage(small, "image/jpeg", transcode, "shot")).toStrictEqual({
    mediaType: "image/jpeg",
    data: small.toString("base64"),
    label: "shot",
  });
  expect(calls.length).toBe(0);
  const large = await toModelImage(
    jpeg(1600, 9000, MAX_IMAGE_BYTES + 1),
    "image/jpeg",
    transcode,
    "tall",
  );
  expect(large.data).toBe(Buffer.from("small").toString("base64"));
  expect(calls.length > 0).toBe(true);
});
