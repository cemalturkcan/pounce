import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CDPSession, Locator, Page } from "playwright-core";
import { type AskAdapterSource, DEFAULT_MAX_OUTPUT_TOKENS, describeUsage, modelId } from "./ask.ts";
import { withDeadline, withTimeout, TIMED_OUT } from "./async.ts";
import type { BrowserManager, Tab } from "./browser.ts";
import { reapplyEmulatedViewport } from "./emulate.ts";
import { ToolError } from "./errors.ts";
import type { OutputStore } from "./output.ts";
import { REPORTED_REGION_LIMIT, runAnalysis } from "./diff-analysis.ts";
import type { Region, RgbaImage } from "./pixels.ts";
import { isDecodablePng, isPng } from "./png.ts";
import { browserTranscoder, describeSent, imageSize } from "./model-images.ts";
import { describeDifferences, type Finding, type ModelLayerResult } from "./visual-model.ts";

export type CompareOptions = {
  target?: string | Locator;
  fullPage?: boolean;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  tolerance?: number;
  minRegionArea?: number;
  maxRegions?: number;
  mergeGap?: number;
  model?: string;
  concurrency?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CompareDeps = { manager: BrowserManager; store: OutputStore; ask: AskAdapterSource };

export type ComparedRegion = Region & { findings?: Finding[]; same?: boolean; modelError?: string; truncated?: boolean; crops?: { design: string; page: string } };

export type CompareReport = {
  url: string;
  reference: string;
  referenceSize: { width: number; height: number };
  pageSize: { width: number; height: number };
  compared: { width: number; height: number };
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scaledPage: boolean;
  notes: string[];
  tolerance: number;
  minRegionArea: number;
  diffPixels: number;
  diffRatio: number;
  regions: ComparedRegion[];
  missing?: Finding[];
  model?: { id: string; adapter: string; calls: number; usage?: Record<string, number>; overviewError?: string; overviewTruncated?: boolean; setupError?: string; images: string };
  files: { dir: string; screenshot: string; diff: string; report: string };
  text: string;
};

export const DEFAULTS = { tolerance: 0.1, minRegionArea: 64, maxRegions: 10, mergeGap: 12, concurrency: 4, fullPageViewportHeight: 1080 };
const STEP_TIMEOUT_MS = 20_000;
const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_PIXELS_HIGH = 16_384;
const CROP_PADDING = 16;
const MAX_LISTED_EXTRA = 20;

const bounded = <T>(promise: Promise<T>, label: string, ms = STEP_TIMEOUT_MS) =>
  withTimeout(promise, ms, () => new ToolError(`compare_design: ${label} did not finish within ${ms} ms.`, "The page may be busy; try again, or reload the tab."));

async function transcodeInPage(page: Page, bytes: Buffer) {
  const base64 = await bounded(
    page.evaluate(async (data: string) => {
      const binary = atob(data);
      const array = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
      const bitmap = await createImageBitmap(new Blob([array]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
      let text = "";
      for (let index = 0; index < png.length; index += 0x8000) text += String.fromCharCode(...png.subarray(index, index + 0x8000));
      return btoa(text);
    }, bytes.toString("base64")),
    "decoding the reference image in the browser",
    CAPTURE_TIMEOUT_MS,
  ).catch((error: unknown) => {
    if (error instanceof ToolError) throw error;
    throw new ToolError(`The reference is not an image the browser can decode (PNG, JPEG, WebP or GIF): ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
  });
  return Buffer.from(base64, "base64");
}

export async function loadReference(page: Page, referencePath: string) {
  if (!path.isAbsolute(referencePath)) throw new ToolError(`reference must be an absolute path, got ${referencePath}.`);
  const bytes = await readFile(referencePath).catch(() => undefined);
  if (!bytes) throw new ToolError(`Cannot read the reference image ${referencePath}.`, "Pass the absolute path of a PNG or JPEG export, or of an earlier screenshot.");
  const png = isPng(bytes) && isDecodablePng(bytes) ? bytes : await transcodeInPage(page, bytes);
  const size = imageSize(png);
  if (!size) throw new ToolError(`The reference ${referencePath} could not be read as an image.`);
  return { png, width: size.width, height: size.height, decodedBy: png === bytes ? ("node" as const) : ("browser" as const) };
}

type Metrics = { width: number; height: number; deviceScaleFactor: number };

const readMetrics = (page: Page) =>
  bounded(
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio })),
    "reading the viewport",
  );

async function settle(page: Page) {
  await withDeadline(
    page.evaluate(async () => {
      await Promise.race([document.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 2000))]);
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
    await withDeadline(page.setViewportSize({ width: playwrightViewport.width + 1, height: playwrightViewport.height }), 5000);
    await withDeadline(page.setViewportSize(playwrightViewport), 5000);
  }
  await settle(page);
  const after = await withDeadline(readMetrics(page), 5000);
  if (after === TIMED_OUT) return "Could not read the viewport after the capture to check it was restored.";
  if (after.width !== before.width || after.height !== before.height || after.deviceScaleFactor !== before.deviceScaleFactor) {
    return `The viewport was ${before.width}x${before.height} @${before.deviceScaleFactor}x before the capture and is ${after.width}x${after.height} @${after.deviceScaleFactor}x now; use tab_resize or emulate to set it back.`;
  }
  return undefined;
}

async function screenshotWith(page: Page, session: CDPSession, metrics: Metrics, mode: { locator?: Locator; fullPage: boolean }) {
  await bounded(session.send("Emulation.setDeviceMetricsOverride", { width: metrics.width, height: metrics.height, deviceScaleFactor: metrics.deviceScaleFactor, mobile: false }), "setting the viewport");
  await settle(page);
  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  if (mode.locator) {
    await bounded(mode.locator.scrollIntoViewIfNeeded({ timeout: STEP_TIMEOUT_MS }), "scrolling to the target");
    const box = await bounded(mode.locator.boundingBox({ timeout: STEP_TIMEOUT_MS }), "measuring the target");
    if (!box || box.width < 1 || box.height < 1) throw new ToolError("The target element has no visible box to capture.", "Check the ref or selector with snapshot, or compare the viewport instead.");
    const scroll = await bounded(page.evaluate(() => [window.scrollX, window.scrollY]), "reading the scroll position");
    clip = { x: box.x + (scroll[0] ?? 0), y: box.y + (scroll[1] ?? 0), width: box.width, height: box.height, scale: 1 };
  } else if (mode.fullPage) {
    const layout = (await bounded(session.send("Page.getLayoutMetrics"), "measuring the page")) as { cssContentSize?: { height: number } };
    const height = Math.min(Math.ceil(layout.cssContentSize?.height ?? metrics.height), Math.floor(MAX_CAPTURE_PIXELS_HIGH / metrics.deviceScaleFactor));
    clip = { x: 0, y: 0, width: metrics.width, height: Math.max(height, 1), scale: 1 };
  }
  const shot = (await bounded(
    session.send("Page.captureScreenshot", clip ? { format: "png", clip, captureBeyondViewport: true } : { format: "png" }),
    "taking the screenshot",
    CAPTURE_TIMEOUT_MS,
  )) as { data: string };
  return Buffer.from(shot.data, "base64");
}

async function captureAt(page: Page, metrics: Metrics, mode: { locator?: Locator; fullPage: boolean }) {
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

function percent(value: number) {
  return `${(value * 100).toFixed(value < 0.001 && value > 0 ? 3 : 2)}%`;
}

function findingLine(finding: Finding) {
  return `[${finding.severity}] [${finding.property}] ${finding.text}`;
}

function regionLine(region: ComparedRegion, deviceScaleFactor: number) {
  const css = deviceScaleFactor === 1 ? "" : ` (CSS ${Math.round(region.x / deviceScaleFactor)},${Math.round(region.y / deviceScaleFactor)} ${Math.round(region.width / deviceScaleFactor)}x${Math.round(region.height / deviceScaleFactor)})`;
  const cutOff = region.truncated ? " (model answer cut off, findings may be incomplete)" : "";
  const head = `${region.id} x ${region.x} y ${region.y}, ${region.width}x${region.height} px${css}, ${Math.round(region.mismatch * 100)}% differ${cutOff}`;
  if (region.findings?.length) return [`${head}: ${findingLine(region.findings[0] as Finding)}`, ...region.findings.slice(1).map((finding) => `   ${findingLine(finding)}`)];
  if (region.same) return [`${head}: the model saw no real difference (likely rendering noise)`];
  if (region.modelError) return [`${head}: pixel difference only (model call failed: ${region.modelError})`];
  return [`${head}: pixel difference only`];
}

export function renderReport(report: Omit<CompareReport, "text">, modelNote?: string) {
  const lines: string[] = [];
  const count = report.regions.length;
  lines.push(
    count
      ? `${count} region(s) differ; ${percent(report.diffRatio)} of the compared pixels (tolerance ${report.tolerance}, regions under ${report.minRegionArea} px² dropped).`
      : `No differences above tolerance ${report.tolerance} (regions under ${report.minRegionArea} px² are dropped); ${report.diffPixels} scattered pixel(s) differ.`,
  );
  lines.push(`Reference ${report.referenceSize.width}x${report.referenceSize.height}, page capture ${report.pageSize.width}x${report.pageSize.height} at viewport ${report.viewport.width}x${report.viewport.height} @${report.viewport.deviceScaleFactor}x. Coordinates are reference pixels.`);
  for (const note of report.notes) lines.push(note);
  const listed = report.regions.filter((region) => region.crops || report.regions.indexOf(region) < MAX_LISTED_EXTRA);
  if (listed.length) lines.push("");
  for (const region of listed) lines.push(...regionLine(region, report.viewport.deviceScaleFactor));
  if (count > listed.length) lines.push(`…and ${count - listed.length} smaller region(s), listed in the report JSON.`);
  if (report.missing?.length) {
    lines.push("", "Missing on the page (whole-image check):");
    for (const finding of report.missing) lines.push(`- ${findingLine(finding)}`);
  }
  if (report.model) {
    const usage = report.model.usage ? describeUsage(report.model.usage) : "not reported";
    lines.push("", `Model: ${report.model.id} through ${report.model.adapter}, ${report.model.calls} call(s). Usage: ${usage}.`, report.model.images);
    if (report.model.overviewError) lines.push(`The whole-image check failed: ${report.model.overviewError}`);
    if (report.model.overviewTruncated) lines.push("The whole-image check was cut off; its list may be incomplete.");
  }
  if (modelNote) lines.push("", modelNote);
  lines.push("", `Diff image: ${report.files.diff}`, `Screenshot: ${report.files.screenshot}`, `Report JSON: ${report.files.report}`);
  if (report.regions.some((region) => region.crops)) lines.push(`Region crops (design and page per region): ${path.join(report.files.dir, "crops")}`);
  return lines.join("\n");
}

async function runModel(deps: CompareDeps, page: Page, options: CompareOptions, crops: Parameters<typeof describeDifferences>[1]["crops"], overview: { reference: RgbaImage; page: RgbaImage }, deviceScaleFactor: number) {
  const id = modelId(options.model ?? "haiku");
  let adapter;
  try {
    adapter = await deps.ask.get();
  } catch (error) {
    return { note: `The model layer was skipped: ${error instanceof Error ? error.message : String(error)} Only the pixel layer is shown.` };
  }
  const result: ModelLayerResult = await describeDifferences(adapter, {
    crops,
    overview,
    model: id,
    maxTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    concurrency: options.concurrency ?? DEFAULTS.concurrency,
    timeoutMs: options.timeoutMs,
    deviceScaleFactor,
    transcode: browserTranscoder(page),
    signal: options.signal,
  });
  const note = result.setupError ? `The model layer stopped: ${result.setupError} Only the pixel layer is shown.` : undefined;
  return { result, id, adapter: adapter.name, note };
}

export async function compareDesign(deps: CompareDeps, tab: Tab, referencePath: string, options: CompareOptions = {}): Promise<CompareReport> {
  const page = tab.page;
  const referenceImage = await loadReference(page, referencePath);
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  const tolerance = options.tolerance ?? DEFAULTS.tolerance;
  const minRegionArea = options.minRegionArea ?? DEFAULTS.minRegionArea;
  const maxRegions = options.maxRegions ?? DEFAULTS.maxRegions;
  const notes: string[] = [];
  const locator = typeof options.target === "string" ? await deps.manager.resolve(tab, options.target) : options.target;
  const current = await readMetrics(page);
  const viewport = locator
    ? { width: options.width ?? current.width, height: options.height ?? current.height, deviceScaleFactor }
    : {
        width: options.width ?? Math.max(1, Math.round(referenceImage.width / deviceScaleFactor)),
        height: options.height ?? Math.max(1, Math.min(options.fullPage ? DEFAULTS.fullPageViewportHeight : Number.POSITIVE_INFINITY, Math.round(referenceImage.height / deviceScaleFactor))),
        deviceScaleFactor,
      };
  const { png, restoreNote } = await captureAt(page, viewport, { locator, fullPage: options.fullPage ?? false });
  if (restoreNote) notes.push(restoreNote);
  const mergeGap = options.mergeGap ?? Math.round(DEFAULTS.mergeGap * deviceScaleFactor);
  const analysis = await runAnalysis(
    { reference: referenceImage.png, page: png, tolerance, minArea: minRegionArea, mergeGap, regionLimit: REPORTED_REGION_LIMIT, crops: maxRegions, cropPadding: Math.round(CROP_PADDING * deviceScaleFactor) },
    options.signal,
  );
  notes.push(...analysis.notes);
  if (analysis.regionsFound > analysis.regions.length) notes.push(`${analysis.regionsFound} regions differ; only the ${analysis.regions.length} largest are reported and outlined.`);
  const aligned = { reference: analysis.reference, page: analysis.page };
  const regions: ComparedRegion[] = analysis.regions;

  const name = deps.store.uniqueName(`${tab.id}-${path.basename(referencePath)}`, "run").replace(/\.run$/, "");
  const dir = await deps.store.dir("visual", name);
  const save = (file: string, content: string | Buffer) => deps.store.write("visual", path.join(name, file), content);
  const files = { dir, screenshot: await save("screenshot.png", png), diff: await save("diff.png", analysis.diffPng), report: path.join(dir, "report.json") };

  const crops = analysis.crops;
  if (crops.length) await deps.store.dir("visual", path.join(name, "crops"));
  for (const item of crops) {
    const design = await save(path.join("crops", `${item.region.id}-design.png`), item.referencePng);
    const pageCrop = await save(path.join("crops", `${item.region.id}-page.png`), item.pagePng);
    const target = regions.find((region) => region.id === item.region.id);
    if (target) target.crops = { design, page: pageCrop };
  }

  let modelNote: string | undefined;
  let model: CompareReport["model"];
  let missing: Finding[] | undefined;
  if ((options.model ?? "haiku") !== "none" && regions.length > 0) {
    const outcome = await runModel(deps, page, options, crops, { reference: aligned.reference, page: aligned.page }, deviceScaleFactor);
    modelNote = outcome.note;
    if (outcome.result && outcome.id && outcome.adapter) {
      for (const verdict of outcome.result.regions) {
        const target = regions.find((region) => region.id === verdict.id);
        if (!target) continue;
        target.findings = verdict.findings;
        if (verdict.same) target.same = true;
        if (verdict.error && !outcome.result.setupError) target.modelError = verdict.error;
        if (verdict.truncated) target.truncated = true;
      }
      missing = outcome.result.overview?.findings;
      model = { id: outcome.id, adapter: outcome.adapter, calls: outcome.result.calls, usage: outcome.result.usage, overviewError: outcome.result.overview?.error, ...(outcome.result.overview?.truncated ? { overviewTruncated: true } : {}), setupError: outcome.result.setupError, images: describeSent(outcome.result.sent) };
    }
  }
  if (regions.length > maxRegions && (options.model ?? "haiku") !== "none") notes.push(`The model looked at the ${maxRegions} largest region(s); raise max_regions to describe more.`);

  const report: Omit<CompareReport, "text"> = {
    url: page.url(),
    reference: referencePath,
    referenceSize: { width: referenceImage.width, height: referenceImage.height },
    pageSize: analysis.pageSize,
    compared: { width: aligned.reference.width, height: aligned.reference.height },
    viewport,
    scaledPage: analysis.scaledPage,
    notes,
    tolerance,
    minRegionArea,
    diffPixels: analysis.diffPixels,
    diffRatio: analysis.diffRatio,
    regions,
    ...(missing ? { missing } : {}),
    ...(model ? { model } : {}),
    files,
  };
  const text = renderReport(report, modelNote);
  await save("report.json", `${JSON.stringify({ ...report, modelNote }, null, 2)}\n`);
  return { ...report, text };
}
