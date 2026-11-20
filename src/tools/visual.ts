import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../ask.ts";
import { untrusted } from "../output.ts";
import { compareDesign, DEFAULTS } from "../visual.ts";
import { defineTool, tabParam, targetParam, type ToolDeps } from "./common.ts";

export function registerVisualTools(server: McpServer, deps: ToolDeps) {
  defineTool(server, deps, {
    name: "compare_design",
    title: "Compare page with design",
    description: [
      "Compare the live page with its intended look, a design export (PNG or JPEG of a Figma frame) or an earlier screenshot used as a baseline, and return a short list of differing regions without either image entering this conversation. Use it for design QA of a page you built and for visual regression against a saved baseline.",
      "Pixel layer, always: the tab is captured at the reference's size (viewport width and height = reference size / device_scale_factor), compared pixel by pixel with an anti-aliasing tolerance, and differing pixels are grouped into regions with a bounding box in reference pixels, area and share of differing pixels. Model layer, unless model is none: each of the largest regions is cropped from both images and described by a model through the model adapter (element, property, design value vs. page value, severity), and one whole-image call lists design elements missing on the page.",
      "The pixel layer knows nothing about layout: one shifted section shows up as one large region, and without the model the regions are only boxes. Haiku can miss one or two pixel differences in spacing or shade; use sonnet or opus when those matter. Files are written to a folder under the output directory: the page screenshot, a diff image with regions outlined, crops of design and page per region, and report.json with every region; their paths are in the result. The viewport is restored after the capture.",
    ].join("\n"),
    input: {
      tab: tabParam,
      reference: z.string().min(1).describe("Absolute path of the design image (PNG, JPEG, WebP) or of an earlier screenshot to use as a baseline."),
      target: targetParam.optional().describe("Compare only this element (ref or selector); the reference is then an export of that element."),
      full_page: z.boolean().optional().describe("Capture the whole scrollable page; the viewport height is then the smaller of the reference height and 1080 CSS px. Default false."),
      width: z.number().int().min(100).max(7680).optional().describe("Viewport width in CSS pixels. Default: reference width / device_scale_factor (current width with target)."),
      height: z.number().int().min(100).max(8640).optional().describe("Viewport height in CSS pixels. Default: reference height / device_scale_factor (current height with target)."),
      device_scale_factor: z.number().min(0.5).max(4).optional().describe("Device pixel ratio for the capture; 2 for a design exported at @2x. Default 1."),
      tolerance: z.number().min(0).max(1).optional().describe(`Color difference a pixel may have and still match, 0 (exact) to 1. Default ${DEFAULTS.tolerance}.`),
      min_region_area: z.number().int().min(1).max(1_000_000).optional().describe(`Regions with a smaller bounding box, in reference pixels, are dropped as noise. Default ${DEFAULTS.minRegionArea}.`),
      max_regions: z.number().int().min(1).max(100).optional().describe(`How many of the largest regions the model describes. Default ${DEFAULTS.maxRegions}.`),
      model: z.string().optional().describe("haiku (default), sonnet, opus, any model id the adapter accepts, or none for the pixel layer only."),
      concurrency: z.number().int().min(1).max(8).optional().describe(`Model calls running at once. Default ${DEFAULTS.concurrency}.`),
      max_output_tokens: z.number().int().min(1000).max(DEFAULT_MAX_OUTPUT_TOKENS).optional().describe("Output token limit per model call, thinking included. Default 128000, the model's maximum."),
    },
    readOnly: true,
    handler: async (input, _owner, signal) => {
      const tab = deps.manager.getTab(input.tab);
      const report = await compareDesign(deps, tab, input.reference, {
        target: input.target,
        fullPage: input.full_page,
        width: input.width,
        height: input.height,
        deviceScaleFactor: input.device_scale_factor,
        tolerance: input.tolerance,
        minRegionArea: input.min_region_area,
        maxRegions: input.max_regions,
        model: input.model,
        concurrency: input.concurrency,
        maxOutputTokens: input.max_output_tokens,
        signal,
      });
      const heading = `Compared ${tab.id} (${report.url}) with ${report.reference}`;
      return report.model ? untrusted(report.url, `${heading}\n${report.text}`) : `${heading}\n${report.text}`;
    },
  });
}
