import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { modelId } from "../ask/adapter.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../ask/run.ts";
import { inSequence } from "../shared/async.ts";
import type { BrowserManager } from "../browser/manager.ts";
import type { OutputStore } from "../shared/output.ts";
import { REPORTED_REGION_LIMIT, runAnalysis } from "./diff-analysis.ts";
import type { RgbaImage } from "./pixels.ts";
import { browserTranscoder, describeSent } from "../ask/model-images.ts";
import { describeDifferences, type Finding, type ModelLayerResult } from "./model.ts";
import type { Tab } from "../browser/tab.ts";
import type { AskAdapterSource } from "../ask/adapter-source.ts";
import { type CompareReport, type ComparedRegion, renderReport } from "./report.ts";
import { captureAt, loadReference, readMetrics } from "./capture.ts";

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

type CompareDeps = { manager: BrowserManager; store: OutputStore; ask: AskAdapterSource };

export const DEFAULTS = {
  tolerance: 0.1,
  minRegionArea: 64,
  maxRegions: 10,
  mergeGap: 12,
  concurrency: 4,
  fullPageViewportHeight: 1080,
};
const CROP_PADDING = 16;
function isSelector(target: string | Locator | undefined): target is string {
  return typeof target === "string";
}

async function runModel(
  deps: CompareDeps,
  page: Page,
  options: CompareOptions,
  crops: Parameters<typeof describeDifferences>[1]["crops"],
  overview: { reference: RgbaImage; page: RgbaImage },
  deviceScaleFactor: number,
) {
  const id = modelId(options.model ?? "haiku");
  let adapter;
  try {
    adapter = await deps.ask.get();
  } catch (error) {
    return {
      note: `The model layer was skipped: ${error instanceof Error ? error.message : String(error)} Only the pixel layer is shown.`,
    };
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
  const note = result.setupError
    ? `The model layer stopped: ${result.setupError} Only the pixel layer is shown.`
    : undefined;
  return { result, id, adapter: adapter.name, note };
}

export async function compareDesign(
  deps: CompareDeps,
  tab: Tab,
  referencePath: string,
  options: CompareOptions = {},
): Promise<CompareReport> {
  const page = tab.page;
  const referenceImage = await loadReference(page, referencePath);
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  const tolerance = options.tolerance ?? DEFAULTS.tolerance;
  const minRegionArea = options.minRegionArea ?? DEFAULTS.minRegionArea;
  const maxRegions = options.maxRegions ?? DEFAULTS.maxRegions;
  const notes: string[] = [];
  const locator = isSelector(options.target)
    ? await deps.manager.resolve(tab, options.target)
    : options.target;
  const current = await readMetrics(page);
  const viewport = locator
    ? {
        width: options.width ?? current.width,
        height: options.height ?? current.height,
        deviceScaleFactor,
      }
    : {
        width: options.width ?? Math.max(1, Math.round(referenceImage.width / deviceScaleFactor)),
        height:
          options.height ??
          Math.max(
            1,
            Math.min(
              options.fullPage ? DEFAULTS.fullPageViewportHeight : Number.POSITIVE_INFINITY,
              Math.round(referenceImage.height / deviceScaleFactor),
            ),
          ),
        deviceScaleFactor,
      };
  const { png, restoreNote } = await captureAt(page, viewport, {
    locator,
    fullPage: options.fullPage ?? false,
  });
  if (restoreNote) notes.push(restoreNote);
  const mergeGap = options.mergeGap ?? Math.round(DEFAULTS.mergeGap * deviceScaleFactor);
  const analysis = await runAnalysis(
    {
      reference: referenceImage.png,
      page: png,
      tolerance,
      minArea: minRegionArea,
      mergeGap,
      regionLimit: REPORTED_REGION_LIMIT,
      crops: maxRegions,
      cropPadding: Math.round(CROP_PADDING * deviceScaleFactor),
    },
    options.signal,
  );
  notes.push(...analysis.notes);
  if (analysis.regionsFound > analysis.regions.length)
    notes.push(
      `${analysis.regionsFound} regions differ; only the ${analysis.regions.length} largest are reported and outlined.`,
    );
  const aligned = { reference: analysis.reference, page: analysis.page };
  const regions: ComparedRegion[] = analysis.regions;

  const name = deps.store
    .uniqueName(`${tab.id}-${path.basename(referencePath)}`, "run")
    .replace(/\.run$/, "");
  const dir = await deps.store.dir("visual", name);
  const save = (file: string, content: string | Buffer) =>
    deps.store.write("visual", path.join(name, file), content);
  const files = {
    dir,
    screenshot: await save("screenshot.png", png),
    diff: await save("diff.png", analysis.diffPng),
    report: path.join(dir, "report.json"),
  };

  const crops = analysis.crops;
  if (crops.length) await deps.store.dir("visual", path.join(name, "crops"));
  await inSequence(crops, async (item) => {
    const design = await save(
      path.join("crops", `${item.region.id}-design.png`),
      item.referencePng,
    );
    const pageCrop = await save(path.join("crops", `${item.region.id}-page.png`), item.pagePng);
    const target = regions.find((region) => region.id === item.region.id);
    if (target) target.crops = { design, page: pageCrop };
  });

  let modelNote: string | undefined;
  let model: CompareReport["model"];
  let missing: Finding[] | undefined;
  if ((options.model ?? "haiku") !== "none" && regions.length > 0) {
    const outcome = await runModel(
      deps,
      page,
      options,
      crops,
      { reference: aligned.reference, page: aligned.page },
      deviceScaleFactor,
    );
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
      model = {
        id: outcome.id,
        adapter: outcome.adapter,
        calls: outcome.result.calls,
        usage: outcome.result.usage,
        overviewError: outcome.result.overview?.error,
        setupError: outcome.result.setupError,
        images: describeSent(outcome.result.sent),
      };
      if (outcome.result.overview?.truncated) model.overviewTruncated = true;
    }
  }
  if (regions.length > maxRegions && (options.model ?? "haiku") !== "none")
    notes.push(
      `The model looked at the ${maxRegions} largest region(s); raise max_regions to describe more.`,
    );

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
    files,
  };
  if (missing) report.missing = missing;
  if (model) report.model = model;
  const text = renderReport(report, modelNote);
  await save("report.json", `${JSON.stringify({ ...report, modelNote }, null, 2)}\n`);
  return { ...report, text };
}
