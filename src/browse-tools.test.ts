import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { BROWSE_TOOL_DEFINITIONS, BROWSE_TOOLS, browseDefinitions, browseTool, toModelImage } from "./browse-tools.ts";
import { MAX_IMAGE_BYTES } from "./model-images.ts";
import { collectToolCallbacks } from "./tools/callbacks.ts";
import type { ToolDeps } from "./tools/common.ts";

const mapped = (name: string, input: Record<string, unknown>) => browseTool(name)?.toMcp(input, "t7");

test("actions map to their MCP tool on the current tab with include_diff", () => {
  assert.deepEqual(mapped("click", { target: "e3" }), { tab: "t7", target: "e3", include_diff: true });
  assert.deepEqual(mapped("hover", { target: "e4", tab: "t9" }), { tab: "t9", target: "e4", include_diff: true });
  assert.deepEqual(mapped("press", { key: "Escape" }), { tab: "t7", key: "Escape", include_diff: true });
  assert.deepEqual(mapped("scroll", { direction: "down", amount: 600 }), { tab: "t7", direction: "down", amount: 600, include_diff: true });
});

test("select_option and search become fill calls, search with submit", () => {
  assert.equal(browseTool("select_option")?.mcp, "fill");
  assert.deepEqual(mapped("select_option", { target: "e5", option: "Yearly" }), { tab: "t7", target: "e5", text: "Yearly", include_diff: true });
  assert.deepEqual(mapped("search", { target: "e6", text: "lamp" }), { tab: "t7", target: "e6", text: "lamp", submit: true, include_diff: true });
});

test("read_text reads the whole page scope and navigate never forces", () => {
  assert.deepEqual(mapped("read_text", { format: "markdown", offset: 12000 }), { tab: "t7", scope: "page", format: "markdown", offset: 12000 });
  assert.deepEqual(mapped("navigate", { url: "back" }), { tab: "t7", url: "back" });
  assert.equal(browseTool("navigate")?.schema.safeParse({ url: "https://a.test", force: true }).success, false);
});

test("every mapped call fits the input schema of its MCP tool", () => {
  const callbacks = collectToolCallbacks({} as ToolDeps);
  const samples: Record<string, Record<string, unknown>> = {
    find: { query: "Yearly", regex: false },
    read_text: { target: "e1", format: "text", offset: 0, frames: true },
    snapshot: { target: "e1", interactive: true, boxes: true },
    screenshot: { target: "e1", full_page: false },
    extract: {},
    click: { target: "e1" },
    hover: { target: "e1" },
    scroll: { target: "e1", direction: "up", amount: 10 },
    press: { key: "Escape", target: "e1" },
    select_option: { target: "e1", option: "x" },
    search: { target: "e1", text: "x" },
    wait_for: { text: "Done" },
    navigate: { url: "https://a.test" },
    dismiss_overlays: {},
    close_tab: { tab: "t8" },
  };
  for (const tool of BROWSE_TOOLS) {
    if (!tool.mcp) continue;
    const sample = samples[tool.name];
    assert.ok(sample, `no sample for ${tool.name}`);
    assert.equal(tool.schema.safeParse(sample).success, true, tool.name);
    const target = callbacks.get(tool.mcp);
    assert.ok(target, `${tool.mcp} is not a tool`);
    const parsed = z.strictObject(target.shape).safeParse(tool.toMcp(sample, "t7"));
    assert.equal(parsed.success, true, `${tool.name}: ${JSON.stringify(parsed.error?.issues)}`);
  }
});

test("the tool definitions are built once with stable bytes and strict schemas", () => {
  assert.equal(JSON.stringify(browseDefinitions()), JSON.stringify(BROWSE_TOOL_DEFINITIONS));
  for (const definition of BROWSE_TOOL_DEFINITIONS) {
    assert.ok(definition.description.length > 20, definition.name);
    assert.equal(definition.inputSchema.additionalProperties, false, definition.name);
  }
  assert.deepEqual(
    BROWSE_TOOL_DEFINITIONS.map((definition) => definition.name),
    ["find", "read_text", "snapshot", "screenshot", "extract", "click", "hover", "scroll", "press", "select_option", "search", "wait_for", "navigate", "dismiss_overlays", "list_tabs", "close_tab"],
  );
});

function jpeg(width: number, height: number, size: number) {
  const bytes = Buffer.alloc(size);
  Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff]).copy(bytes);
  return bytes;
}

test("16: small screenshots go to the model as they are, oversized ones are re-encoded", async () => {
  const calls: unknown[] = [];
  const transcode = async (_bytes: Buffer, target: unknown) => {
    calls.push(target);
    return Buffer.from("small");
  };
  const small = jpeg(800, 600, 2000);
  assert.deepEqual(await toModelImage(small, "image/jpeg", transcode, "shot"), { mediaType: "image/jpeg", data: small.toString("base64"), label: "shot" });
  assert.equal(calls.length, 0);
  const large = await toModelImage(jpeg(1600, 9000, MAX_IMAGE_BYTES + 1), "image/jpeg", transcode, "tall");
  assert.equal(large.data, Buffer.from("small").toString("base64"));
  assert.equal(calls.length > 0, true);
});
