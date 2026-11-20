import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AskImage } from "./ask-adapter.ts";
import { withTimeout } from "./async.ts";
import type { BrowserManager, Tab } from "./browser.ts";
import { capture } from "./capture.ts";
import { MAX_IMAGES_PER_CALL } from "./ask.ts";
import { ToolError } from "./errors.ts";
import { settleRendering } from "./settle.ts";
import { browserTranscoder, imageSize, JPEG_QUALITY, type PreparedImage, prepareModelImage } from "./model-images.ts";

export type ImageMode = "none" | "auto" | "viewport" | "full";
export type RegionRequest = { target: string };
export type PageVisualStats = { textChars: number; viewport: { width: number; height: number }; pageHeight: number; mediaArea: number };
export type PageImages = { images: AskImage[]; prepared: PreparedImage[]; files: string[]; kind: "none" | "viewport" | "tiles"; tiles: number; regions: number; notes: string[] };

export const TILE_OVERLAP = 80;
const MEDIA_SHARE = 0.4;
const CHARS_PER_10K_PX = 2;
const STEP_MS = 20_000;

export function looksVisual(stats: PageVisualStats) {
  if (stats.textChars === 0) return true;
  const viewportArea = stats.viewport.width * stats.viewport.height;
  if (viewportArea > 0 && stats.mediaArea / viewportArea >= MEDIA_SHARE) return true;
  const pageArea = stats.viewport.width * Math.max(stats.pageHeight, stats.viewport.height);
  return pageArea > 0 && stats.textChars / (pageArea / 10_000) < CHARS_PER_10K_PX;
}

type ScreenPosition = { x: number; y: number; viewport: number; height: number };

function scrollToTop(top: number): ScreenPosition {
  window.scrollTo({ left: 0, top, behavior: "instant" });
  const root = document.scrollingElement ?? document.documentElement;
  return { x: window.scrollX, y: window.scrollY, viewport: window.innerHeight, height: root.scrollHeight };
}

function restoreScroll(position: { x: number; y: number }) {
  window.scrollTo({ left: position.x, top: position.y, behavior: "instant" });
}

const bounded = <T>(promise: Promise<T>, label: string) =>
  withTimeout(promise, STEP_MS, () => new ToolError(`ask_pages: ${label} did not finish within ${STEP_MS} ms.`));

export function measurePage(tab: Tab) {
  return bounded(
    tab.page.evaluate(() => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      let mediaArea = 0;
      for (const element of document.querySelectorAll("img, canvas, video, svg, picture, iframe")) {
        if (element.tagName.toLowerCase() === "svg" && element.parentElement?.closest("svg")) continue;
        const rect = element.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
        mediaArea += visibleWidth * visibleHeight;
      }
      const root = document.scrollingElement ?? document.documentElement;
      return {
        textChars: (document.body?.innerText ?? "").trim().length,
        viewport: { width, height },
        pageHeight: root.scrollHeight,
        mediaArea: Math.min(mediaArea, width * height),
      };
    }),
    "measuring the page",
  );
}

async function captureScreens(page: Tab["page"]) {
  const shots: Buffer[] = [];
  const start = await bounded(page.evaluate(() => ({ x: window.scrollX, y: window.scrollY })), "reading the scroll position");
  try {
    let top = 0;
    let previous = Number.NEGATIVE_INFINITY;
    while (shots.length < MAX_IMAGES_PER_CALL) {
      const at = await bounded(page.evaluate(scrollToTop, top), "scrolling the page");
      if (at.y <= previous) break;
      previous = at.y;
      await settleRendering(page);
      shots.push(await capture(page, { format: "jpeg", quality: JPEG_QUALITY, timeoutMs: STEP_MS }));
      const height = await bounded(page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollHeight), "measuring the page");
      if (at.y + at.viewport >= height - 1) break;
      top = at.y + Math.max(1, at.viewport - TILE_OVERLAP);
    }
  } finally {
    await bounded(page.evaluate(restoreScroll, start), "restoring the scroll position").catch(() => undefined);
  }
  return shots;
}

export async function capturePageImages(
  manager: BrowserManager,
  tab: Tab,
  options: { mode: ImageMode; regions: RegionRequest[]; source: string; dir: string; base: string },
): Promise<PageImages> {
  const result: PageImages = { images: [], prepared: [], files: [], kind: "none", tiles: 0, regions: 0, notes: [] };
  const { page } = tab;
  const transcode = browserTranscoder(page);
  const keep = async (buffer: Buffer, suffix: string, label: string) => {
    const name = `${options.base}.${suffix}.jpg`;
    await writeFile(path.join(options.dir, name), buffer);
    result.files.push(path.join(options.dir, name));
    const size = imageSize(buffer);
    if (!size) throw new ToolError(`ask_pages: the screenshot ${name} has no readable size.`);
    const prepared = await prepareModelImage({ bytes: buffer, ...size, encoded: { type: "image/jpeg", quality: JPEG_QUALITY } }, "jpeg", transcode, label);
    result.prepared.push(prepared);
    result.images.push(prepared.image);
  };
  let mode = options.mode;
  if (mode === "auto") mode = looksVisual(await measurePage(tab)) ? "viewport" : "none";
  if (mode === "viewport") {
    await keep(await capture(page, { format: "jpeg", quality: JPEG_QUALITY, timeoutMs: STEP_MS }), "viewport", `${options.source} viewport`);
    result.kind = "viewport";
  } else if (mode === "full") {
    const screens = await captureScreens(page);
    for (const [index, shot] of screens.entries()) await keep(shot, `tile-${index + 1}`, `${options.source} tile ${index + 1}/${screens.length}`);
    result.kind = "tiles";
    result.tiles = screens.length;
  }
  for (const [index, region] of options.regions.entries()) {
    try {
      const locator = await manager.resolve(tab, region.target);
      await keep(await capture(page, { format: "jpeg", quality: JPEG_QUALITY, timeoutMs: STEP_MS, locator }), `region-${index + 1}`, `${options.source} region ${region.target}`);
      result.regions += 1;
    } catch (error) {
      result.notes.push(`region ${region.target} was not captured: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}`);
    }
  }
  return result;
}

export function describePageImages(source: string, images: PageImages) {
  const parts: string[] = [];
  if (images.kind === "viewport") parts.push("viewport");
  if (images.kind === "tiles") parts.push(`${images.tiles} tile(s)`);
  if (images.regions) parts.push(`${images.regions} region(s)`);
  const lines = parts.length ? [`${source}: ${parts.join(", ")}`] : [];
  for (const note of images.notes) lines.push(`${source}: ${note}`);
  return lines;
}
