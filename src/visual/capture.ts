import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CDPSession, Locator, Page } from "playwright-core";
import { withDeadline, withTimeout, TIMED_OUT } from "../shared/async.ts";
import { capture, pageZoom } from "../page/capture.ts";
import { reapplyEmulatedViewport } from "../browser/emulate.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import { imageSize } from "../ask/model-images.ts";
import { isDecodablePng, isPng } from "./png.ts";

const STEP_TIMEOUT_MS = 20_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_PIXELS_HIGH = 16_384;

const bounded = <T>(promise: Promise<T>, label: string, ms = STEP_TIMEOUT_MS) =>
  withTimeout(
    promise,
    ms,
    () =>
      new ToolError(
        `compare_design: ${label} did not finish within ${ms} ms.`,
        "The page may be busy; try again, or reload the tab.",
      ),
  );

async function transcodeInPage(page: Page, bytes: Buffer) {
  const base64 = await bounded(
    page.evaluate(async (data: string) => {
      const binary = atob(data);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1)
        array[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([array]), {
        colorSpaceConversion: "none",
        premultiplyAlpha: "none",
      });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = new Uint8Array(
        await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer(),
      );
      let text = "";
      for (let index = 0; index < png.length; index += 0x8000)
        text += String.fromCharCode(...png.subarray(index, index + 0x8000));
      return btoa(text);
    }, bytes.toString("base64")),
    "decoding the reference image in the browser",
    CAPTURE_TIMEOUT_MS,
  ).catch((cause: unknown) => {
    if (cause instanceof ToolError) throw cause;
    throw new ToolError(
      `The reference is not an image the browser can decode (PNG, JPEG, WebP or GIF): ${messageOf(cause).split("\n")[0]}`,
    );
  });
  return Buffer.from(base64, "base64");
}

export async function loadReference(page: Page, referencePath: string) {
  if (!path.isAbsolute(referencePath))
    throw new ToolError(`reference must be an absolute path, got ${referencePath}.`);
  const bytes = await readFile(referencePath).catch(() => undefined);
  if (!bytes)
    throw new ToolError(
      `Cannot read the reference image ${referencePath}.`,
      "Pass the absolute path of a PNG or JPEG export, or of an earlier screenshot.",
    );
  const png = isPng(bytes) && isDecodablePng(bytes) ? bytes : await transcodeInPage(page, bytes);
  const size = imageSize(png);
  if (!size) throw new ToolError(`The reference ${referencePath} could not be read as an image.`);
  return {
    png,
    width: size.width,
    height: size.height,
    decodedBy: png === bytes ? ("node" as const) : ("browser" as const),
  };
}

type Metrics = { width: number; height: number; deviceScaleFactor: number };

export const readMetrics = (page: Page) =>
  bounded(
    page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio,
    })),
    "reading the viewport",
  );

async function settle(page: Page) {
  await withDeadline(
    page.evaluate(async () => {
      await Promise.race([
        document.fonts?.ready,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }),
    5000,
  );
}

async function restoreViewport(page: Page, session: CDPSession, before: Metrics) {
  await withDeadline(session.send("Emulation.clearDeviceMetricsOverride"), 5000);
  await withDeadline(session.detach(), 5000);
  if (page.isClosed()) return undefined;
  const emulated = await withDeadline(reapplyEmulatedViewport(page), 5000);
  const playwrightViewport = page.viewportSize();
  if (emulated !== true && playwrightViewport) {
    await withDeadline(
      page.setViewportSize({
        width: playwrightViewport.width + 1,
        height: playwrightViewport.height,
      }),
      5000,
    );
    await withDeadline(page.setViewportSize(playwrightViewport), 5000);
  }
  await settle(page);
  const after = await withDeadline(readMetrics(page), 5000);
  if (after === TIMED_OUT)
    return "Could not read the viewport after the capture to check it was restored.";
  if (
    after.width !== before.width ||
    after.height !== before.height ||
    after.deviceScaleFactor !== before.deviceScaleFactor
  ) {
    return `The viewport was ${before.width}x${before.height} @${before.deviceScaleFactor}x before the capture and is ${after.width}x${after.height} @${after.deviceScaleFactor}x now; use tab_resize or emulate to set it back.`;
  }
  return undefined;
}

async function screenshotWith(
  page: Page,
  session: CDPSession,
  metrics: Metrics,
  mode: { locator?: Locator; fullPage: boolean },
) {
  const zoom = await bounded(pageZoom(session), "reading the zoom");
  await bounded(
    session.send("Emulation.setDeviceMetricsOverride", {
      width: Math.round(metrics.width * zoom),
      height: Math.round(metrics.height * zoom),
      deviceScaleFactor: metrics.deviceScaleFactor / zoom,
      mobile: false,
    }),
    "setting the viewport",
  );
  await settle(page);
  const options = {
    format: "png" as const,
    timeoutMs: CAPTURE_TIMEOUT_MS,
    pixelsPerCss: metrics.deviceScaleFactor,
    session,
  };
  if (mode.locator) return capture(page, { ...options, locator: mode.locator });
  if (mode.fullPage) {
    const layout = layoutMetricsSchema.parse(
      await bounded(session.send("Page.getLayoutMetrics"), "measuring the page"),
    );
    const height = Math.min(
      Math.ceil(layout.cssContentSize?.height ?? metrics.height),
      Math.floor(MAX_CAPTURE_PIXELS_HIGH / metrics.deviceScaleFactor),
    );
    return capture(page, {
      ...options,
      clip: { x: 0, y: 0, width: metrics.width, height: Math.max(height, 1) },
    });
  }
  const [x = 0, y = 0] = await bounded(
    page.evaluate(() => [window.scrollX, window.scrollY]),
    "reading the scroll position",
  );
  return capture(page, {
    ...options,
    clip: { x, y, width: metrics.width, height: metrics.height },
  });
}

const layoutMetricsSchema = z.object({
  cssContentSize: z.object({ height: z.number() }).optional(),
});

export async function captureAt(
  page: Page,
  metrics: Metrics,
  mode: { locator?: Locator; fullPage: boolean },
) {
  const before = await readMetrics(page);
  const session = await bounded(page.context().newCDPSession(page), "opening a DevTools session");
  let png: Buffer | undefined;
  let restoreNote: string | undefined;
  try {
    png = await screenshotWith(page, session, metrics, mode);
  } finally {
    restoreNote = await restoreViewport(page, session, before);
  }
  return { png, restoreNote };
}
