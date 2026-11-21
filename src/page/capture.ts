import type { CDPSession, Locator, Page } from "playwright-core";
import { withDeadline, withTimeout } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";

type CssRect = { x: number; y: number; width: number; height: number };

type CaptureOptions = {
  format: "jpeg" | "png";
  quality?: number;
  timeoutMs: number;
  pixelsPerCss?: number;
  fullPage?: boolean;
  clip?: CssRect;
  locator?: Locator;
  session?: CDPSession;
};

export async function pageZoom(session: CDPSession) {
  const layout = await session.send("Page.getLayoutMetrics");
  return layout.cssVisualViewport.zoom ?? 1;
}

async function elementRect(page: Page, locator: Locator, timeoutMs: number): Promise<CssRect> {
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
  const box = await locator.boundingBox({ timeout: timeoutMs });
  if (!box || box.width < 1 || box.height < 1)
    throw new ToolError(
      "The target element has no visible box to capture.",
      "Check the ref or selector with snapshot, or capture the viewport instead.",
    );
  const [scrollX, scrollY] = await page.evaluate(() => [window.scrollX, window.scrollY]);
  return {
    x: box.x + (scrollX ?? 0),
    y: box.y + (scrollY ?? 0),
    width: box.width,
    height: box.height,
  };
}

const EDGE_SLACK = 1;

const inside = (rect: CssRect, area: CssRect) =>
  rect.x >= area.x - EDGE_SLACK &&
  rect.y >= area.y - EDGE_SLACK &&
  rect.x + rect.width <= area.x + area.width + EDGE_SLACK &&
  rect.y + rect.height <= area.y + area.height + EDGE_SLACK;

async function captureWith(page: Page, session: CDPSession, options: CaptureOptions) {
  const target = options.locator
    ? await elementRect(page, options.locator, options.timeoutMs)
    : options.clip;
  const layout = await session.send("Page.getLayoutMetrics");
  const [ratio = 1, innerWidth = 0, innerHeight = 0] = await page.evaluate(() => [
    window.devicePixelRatio,
    window.innerWidth,
    window.innerHeight,
  ]);
  const visual = layout.cssVisualViewport;
  const zoom = visual.zoom ?? 1;
  const pinch = visual.scale ?? 1;
  const viewport = {
    x: visual.pageX,
    y: visual.pageY,
    width: innerWidth / pinch,
    height: innerHeight / pinch,
  };
  const pixelsPerCss = options.pixelsPerCss ?? 1;
  let rect = target ?? viewport;
  let magnify = 1;
  if (!target && options.fullPage) {
    rect = {
      x: 0,
      y: 0,
      width: Math.max(layout.cssContentSize.width, innerWidth),
      height: Math.max(layout.cssContentSize.height, innerHeight),
    };
  } else if (!target) {
    magnify = pinch;
  }
  const beyond = !inside(rect, viewport);
  const params = {
    format: options.format,
    clip: {
      x: rect.x * zoom,
      y: rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
      scale: (magnify * pixelsPerCss) / ratio,
    },
    captureBeyondViewport: beyond,
  };
  const shot = await session.send(
    "Page.captureScreenshot",
    options.format === "jpeg" && options.quality !== undefined
      ? { ...params, quality: options.quality }
      : params,
  );
  return Buffer.from(shot.data, "base64");
}

export async function capture(page: Page, options: CaptureOptions) {
  const timeout = () =>
    new ToolError(
      `The screenshot did not finish within ${options.timeoutMs} ms.`,
      "The page may be busy; try again, or reload the tab.",
    );
  if (options.session)
    return withTimeout(captureWith(page, options.session, options), options.timeoutMs, timeout);
  const session = await withTimeout(page.context().newCDPSession(page), options.timeoutMs, timeout);
  try {
    return await withTimeout(captureWith(page, session, options), options.timeoutMs, timeout);
  } finally {
    await withDeadline(
      session.detach().catch(() => undefined),
      5000,
    );
  }
}
