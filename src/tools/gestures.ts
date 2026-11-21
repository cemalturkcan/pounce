import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../shared/errors.ts";
import { runAction } from "../page/page.ts";
import {
  defineTool,
  includeDiffParam,
  includeSnapshotParam,
  NO_DOM_CHANGE,
  tabParam,
  targetParam,
  type ToolDeps,
} from "./common.ts";
import { pageBound } from "../page/bound.ts";

export function registerGestureTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "hover",
    title: "Hover",
    description:
      "Move the mouse over an element and leave it there, to reveal menus, tooltips or controls that only appear on hover. The result says whether the page changed; take a snapshot afterwards (or pass include_snapshot) to get refs for what appeared.",
    input: {
      tab: tabParam,
      target: targetParam,
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
          await locator.hover();
          return `Hovering ${input.target}.`;
        },
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "drag",
    title: "Drag and drop",
    description:
      "Drag one element onto another with real mouse events: press on the source, move to the target, release. Works for sortable lists, kanban boards, sliders with a drop target, and HTML5 drag and drop. For dragging by pixel offsets, such as a slider without a drop target or drawing on a canvas, use run_script with page.mouse.",
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
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "scroll",
    title: "Scroll",
    description:
      "Scroll an element into view, or scroll the page by a number of pixels or to the top or bottom. Use it on pages that load more content as you scroll, such as feeds and lazy-loaded lists, or to bring something into view before a screenshot; action tools already scroll their own target into view. To gather everything from a long infinite-scroll list, collect_pages with scroll or a loop in run_script does it in one call.",
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe(
          "Scroll this element into view (ref or selector). When set, direction and amount are ignored.",
        ),
      direction: z
        .enum(["down", "up", "left", "right", "top", "bottom"])
        .optional()
        .describe("Direction to scroll the page; top and bottom jump to the ends. Default down."),
      amount: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe("Distance in pixels for down, up, left and right. Default 800."),
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
            await pageBound(
              tab.page.evaluate(
                (toBottom) =>
                  window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0),
                direction === "bottom",
              ),
              "scroll",
            );
            return `Scrolled to the ${direction}.`;
          }
          const horizontal = direction === "left" ? -amount : direction === "right" ? amount : 0;
          const vertical = direction === "up" ? -amount : direction === "down" ? amount : 0;
          await tab.page.mouse.wheel(horizontal, vertical);
          return `Scrolled ${direction} ${amount}px.`;
        },
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "upload",
    title: "Upload files",
    description:
      "Attach local files to a file input, or to a button that opens a file chooser. Use it for avatars, documents, attachments and imports; fill refuses file inputs. Paths are on the machine running this server and must exist. The result says whether the page changed, as for click.",
    input: {
      tab: tabParam,
      target: targetParam.describe(
        "The file input, or the button that opens the file chooser (ref or selector).",
      ),
      paths: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .describe("Absolute paths of the files to attach."),
    },
    handler: async (input) => {
      const infos = await Promise.all(
        input.paths.map((filePath) => stat(filePath).catch(() => undefined)),
      );
      const missingIndex = infos.findIndex((info) => !info?.isFile());
      if (missingIndex !== -1) throw new ToolError(`No file at ${input.paths[missingIndex]}.`);
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const isFileInput = await locator.evaluate(
            (element) => element instanceof HTMLInputElement && element.type === "file",
          );
          if (isFileInput) {
            await locator.setInputFiles(input.paths);
          } else {
            const [chooser] = await Promise.all([
              tab.page.waitForEvent("filechooser"),
              locator.click(),
            ]);
            await chooser.setFiles(input.paths);
          }
          return `Attached ${input.paths.length} file(s) to ${input.target}.`;
        },
        { noChangeText: NO_DOM_CHANGE },
      );
    },
  });
}
