import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Locator } from "playwright-core";
import type { Tab } from "../browser/tab.ts";
import { z } from "zod";
import { ToolError } from "../shared/errors.ts";
import {
  humanDrag,
  humanHover,
  humanHoverAt,
  humanScrollIntoView,
  humanScrollToEnd,
  humanWheel,
  plainDrag,
  plainHover,
  plainHoverAt,
  plainWheel,
} from "../page/human.ts";
import { checkpoint, recordAction } from "../shared/call-scope.ts";
import { elementAt, runAction, targetName } from "../page/page.ts";
import {
  chosenAim,
  defineTool,
  humanParam,
  includeDiffParam,
  includeSnapshotParam,
  NO_DOM_CHANGE,
  pointParams,
  tabParam,
  targetParam,
  type ToolDeps,
} from "./common.ts";
import { pageBound } from "../page/bound.ts";

const DRAG_REACTION_MS = 1000;

type ScrollMove =
  | { kind: "into-view"; target: string }
  | { kind: "jump"; to: "top" | "bottom" }
  | { kind: "pixels"; direction: "down" | "up" | "left" | "right"; amount: number };

function mixed(extra: string, mode: string) {
  return new ToolError(`Give target, to, or direction and amount, not ${extra} with ${mode}.`);
}

export function scrollMove(input: {
  target?: string;
  to?: "top" | "bottom";
  direction?: "down" | "up" | "left" | "right";
  amount?: number;
}): ScrollMove {
  if (input.target !== undefined) {
    if (input.to !== undefined) throw mixed("target", "to");
    if (input.direction !== undefined) throw mixed("target", "direction");
    if (input.amount !== undefined) throw mixed("target", "amount");
    return { kind: "into-view", target: input.target };
  }
  if (input.to !== undefined) {
    if (input.direction !== undefined) throw mixed("direction", "to");
    if (input.amount !== undefined) throw mixed("amount", "to");
    return { kind: "jump", to: input.to };
  }
  return { kind: "pixels", direction: input.direction ?? "down", amount: input.amount ?? 800 };
}

async function dispatchHtml5Drag(source: Locator, destination: Locator) {
  const drop = await destination.elementHandle();
  try {
    await source.evaluate((element, target) => {
      if (!target) return;
      const data = new DataTransfer();
      const fire = (node: Element, type: string, at: Element) => {
        const box = at.getBoundingClientRect();
        node.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer: data,
            clientX: box.x + box.width / 2,
            clientY: box.y + box.height / 2,
          }),
        );
      };
      fire(element, "dragstart", element);
      fire(target, "dragenter", target);
      fire(target, "dragover", target);
      fire(target, "drop", target);
      fire(element, "dragend", target);
    }, drop);
  } finally {
    await drop?.dispose();
  }
}

async function intoView(tab: Tab, locator: Locator, target: string, human: boolean) {
  const label = await targetName(tab, locator, target);
  return async () => {
    if (human) await humanScrollIntoView(tab, locator);
    else await locator.scrollIntoViewIfNeeded();
    return `Scrolled ${label} into view.`;
  };
}

async function jump(tab: Tab, to: "top" | "bottom", human: boolean) {
  const toBottom = to === "bottom";
  if (human) {
    const left = await humanScrollToEnd(tab, toBottom);
    if (left > 1) return `Scrolled toward the ${to}; the page is still ${left}px from it.`;
    return `Scrolled to the ${to}.`;
  }
  await pageBound(
    tab.page.evaluate(
      (bottom) => window.scrollTo(0, bottom ? document.documentElement.scrollHeight : 0),
      toBottom,
    ),
    "scroll",
  );
  return `Scrolled to the ${to}.`;
}

async function wheel(
  tab: Tab,
  direction: "down" | "up" | "left" | "right",
  amount: number,
  human: boolean,
) {
  const horizontal = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const vertical = direction === "up" ? -amount : direction === "down" ? amount : 0;
  if (human) await humanWheel(tab, horizontal, vertical);
  else await plainWheel(tab, horizontal, vertical);
  return `Scrolled ${direction} ${amount}px.`;
}

export function registerGestureTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "hover",
    title: "Hover",
    description:
      "Move the mouse over an element, or to a point given as x and y viewport coordinates, and leave it there, to reveal menus, tooltips or controls that only appear on hover. The result names what is under the mouse and says whether the page changed; take a snapshot afterwards (or pass include_snapshot) to get refs for what appeared.",
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe(
          "Element to hover: a ref or a selector as for other actions. Omit it and give x and y to hover over a point.",
        ),
      ...pointParams,
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const aim = await chosenAim(tab, input);
      const settings = {
        includeSnapshot: input.include_snapshot,
        includeDiff: input.include_diff,
        noChangeText: NO_DOM_CHANGE,
      };
      if ("point" in aim) {
        const { point } = aim;
        const hit = await elementAt(tab.page, point);
        recordAction(`hovering at (${point.x}, ${point.y})${hit ? ` over ${hit}` : ""}`);
        return runAction(
          manager,
          store,
          tab,
          async () => {
            if (input.human) await humanHoverAt(tab, point);
            else await plainHoverAt(tab, point);
            return `Hovering at (${point.x}, ${point.y})${hit ? ` over ${hit}` : ""}.`;
          },
          settings,
        );
      }
      const locator = await manager.resolve(tab, aim.target);
      const label = await targetName(tab, locator, aim.target);
      recordAction(`hovering ${label}`);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          if (input.human) await humanHover(tab, locator);
          else await plainHover(tab, locator);
          return `Hovering ${label}.`;
        },
        settings,
      );
    },
  });

  defineTool(server, deps, {
    name: "drag",
    title: "Drag and drop",
    description:
      "Drag one element (target) onto another (to): press on it with the mouse, move to the drop element, release. When the page does not react to the mouse drag, HTML5 drag-and-drop events (dragstart, dragover, drop, dragend) are sent instead, and the result says so; when it reacts to neither, the result begins with The page did not react. Works for sortable lists, kanban boards and drop zones. For dragging by pixel offsets, such as a slider without a drop target or drawing on a canvas, use run_script with page.mouse.",
    input: {
      tab: tabParam,
      target: targetParam.describe("Element to drag (ref or selector)."),
      to: targetParam.describe("Element to drop it onto (ref or selector)."),
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const source = await manager.resolve(tab, input.target);
      const destination = await manager.resolve(tab, input.to);
      const sourceLabel = await targetName(tab, source, input.target);
      const destinationLabel = await targetName(tab, destination, input.to);
      const dragging = `dragging ${sourceLabel} onto ${destinationLabel}`;
      recordAction(dragging);
      return runAction(
        manager,
        store,
        tab,
        async ({ mutations }) => {
          if (input.human) await humanDrag(tab, source, destination);
          else await plainDrag(tab, source, destination);
          const dragged = `Dragged ${sourceLabel} onto ${destinationLabel}`;
          const deadline = Date.now() + DRAG_REACTION_MS;
          const reacted = async (): Promise<boolean> =>
            (await mutations()) !== "unchanged" || (Date.now() < deadline && reacted());
          if (await reacted()) return `${dragged}.`;
          checkpoint();
          await dispatchHtml5Drag(source, destination);
          if ((await mutations()) !== "unchanged")
            return `${dragged} with HTML5 drag events; the page did not react to the mouse drag.`;
          return `The page did not react to ${dragging}, neither to the mouse drag nor to HTML5 drag events.`;
        },
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: "",
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "scroll",
    title: "Scroll",
    description:
      "Scroll an element into view (target), jump to the top or bottom of the page (to), or scroll by pixels (direction and amount, default down 800). direction and amount turn the mouse wheel where the pointer last was, so after a hover over a scrollable list or panel they scroll that instead of the page; target and to always move the page. Use it on pages that load more content as you scroll, such as feeds and lazy-loaded lists, or to bring something into view before a screenshot; action tools already scroll their own target into view. To gather everything from a long infinite-scroll list, save_pages with scroll or a loop in run_script does it in one call.",
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe("Scroll this element into view (ref or selector). Give alone."),
      to: z
        .enum(["top", "bottom"])
        .optional()
        .describe("Jump to the top or bottom of the page. Give alone."),
      direction: z
        .enum(["down", "up", "left", "right"])
        .optional()
        .describe("Direction to scroll by pixels. Default down."),
      amount: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .optional()
        .describe("Distance in pixels. Default 800."),
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const move = scrollMove(input);
      const tab = manager.getTab(input.tab);
      const human = input.human === true;
      return runAction(
        manager,
        store,
        tab,
        move.kind === "into-view"
          ? await intoView(tab, await manager.resolve(tab, move.target), move.target, human)
          : move.kind === "jump"
            ? () => jump(tab, move.to, human)
            : () => wheel(tab, move.direction, move.amount, human),
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });
}
