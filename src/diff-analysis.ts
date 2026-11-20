import { Worker } from "node:worker_threads";
import { type Box, clusterRegions, crop, diffImages, type Region, renderDiffImage, resize, type RgbaImage } from "./pixels.ts";
import { decodePng, encodePng } from "./png.ts";
import { imageSize } from "./model-images.ts";

export const REPORTED_REGION_LIMIT = 200;
export const WORKER_PIXEL_THRESHOLD = 1_000_000;

export type AnalysisInput = {
  reference: Buffer;
  page: Buffer;
  tolerance: number;
  minArea: number;
  mergeGap: number;
  regionLimit: number;
  crops: number;
  cropPadding: number;
};

export type AnalysisCrop = { region: Region; box: Box; reference: RgbaImage; page: RgbaImage; referencePng: Buffer; pagePng: Buffer };

export type AnalysisResult = {
  reference: RgbaImage;
  page: RgbaImage;
  referenceSize: { width: number; height: number };
  pageSize: { width: number; height: number };
  scaledPage: boolean;
  notes: string[];
  diffPixels: number;
  diffRatio: number;
  regions: Region[];
  regionsFound: number;
  diffPng: Buffer;
  crops: AnalysisCrop[];
};

function aspectMatches(a: { width: number; height: number }, b: { width: number; height: number }) {
  return Math.abs(a.width / a.height - b.width / b.height) <= 0.01 * (a.width / a.height);
}

export function align(reference: RgbaImage, page: RgbaImage, notes: string[]) {
  if (reference.width === page.width && reference.height === page.height) return { reference, page, scaledPage: false };
  if (aspectMatches(reference, page)) {
    notes.push(`The page capture (${page.width}x${page.height}) has the reference's proportions but not its size, so it was scaled to ${reference.width}x${reference.height} before comparing; pass device_scale_factor to capture at the reference's scale instead.`);
    return { reference, page: resize(page, reference.width, reference.height), scaledPage: true };
  }
  const width = Math.min(reference.width, page.width);
  const height = Math.min(reference.height, page.height);
  notes.push(
    `Sizes differ: reference ${reference.width}x${reference.height}, page ${page.width}x${page.height}. Only the top-left ${width}x${height} was compared${reference.height > page.height ? `; the reference continues ${reference.height - page.height}px below the end of the page capture` : ""}${page.height > reference.height ? `; the page continues ${page.height - reference.height}px below the end of the reference` : ""}${reference.width !== page.width ? "; widths differ, so check width and device_scale_factor" : ""}.`,
  );
  const box = { x: 0, y: 0, width, height };
  return { reference: crop(reference, box), page: crop(page, box), scaledPage: false };
}

function padBox(region: Box, pad: number, width: number, height: number): Box {
  const x = Math.max(0, region.x - pad);
  const y = Math.max(0, region.y - pad);
  return { x, y, width: Math.min(width, region.x + region.width + pad) - x, height: Math.min(height, region.y + region.height + pad) - y };
}

export async function analyzeImages(input: AnalysisInput): Promise<AnalysisResult> {
  const [referenceImage, pageImage] = await Promise.all([decodePng(input.reference), decodePng(input.page)]);
  const notes: string[] = [];
  const aligned = align(referenceImage, pageImage, notes);
  const diff = diffImages(aligned.reference, aligned.page, { tolerance: input.tolerance });
  const found = clusterRegions(diff, { minArea: input.minArea, mergeGap: input.mergeGap });
  const regions = found.slice(0, input.regionLimit);
  const diffPng = await encodePng(renderDiffImage(aligned.page, diff, regions));
  const crops: AnalysisCrop[] = [];
  for (const region of regions.slice(0, input.crops)) {
    const box = padBox(region, input.cropPadding, aligned.reference.width, aligned.reference.height);
    const reference = crop(aligned.reference, box);
    const page = crop(aligned.page, box);
    crops.push({ region, box, reference, page, referencePng: await encodePng(reference), pagePng: await encodePng(page) });
  }
  return {
    reference: aligned.reference,
    page: aligned.page,
    referenceSize: { width: referenceImage.width, height: referenceImage.height },
    pageSize: { width: pageImage.width, height: pageImage.height },
    scaledPage: aligned.scaledPage,
    notes,
    diffPixels: diff.count,
    diffRatio: diff.count / Math.max(1, diff.width * diff.height),
    regions,
    regionsFound: found.length,
    diffPng,
    crops,
  };
}

function pixelsOf(png: Buffer) {
  const size = imageSize(png);
  return size ? size.width * size.height : Number.POSITIVE_INFINITY;
}

function revive(result: AnalysisResult): AnalysisResult {
  const buffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ...result,
    diffPng: buffer(result.diffPng),
    crops: result.crops.map((item) => ({ ...item, referencePng: buffer(item.referencePng), pagePng: buffer(item.pagePng) })),
  };
}

export function analyzeInWorker(input: AnalysisInput, signal?: AbortSignal) {
  return new Promise<AnalysisResult>((resolve, reject) => {
    const worker = new Worker(new URL("./diff-worker.ts", import.meta.url), { workerData: input });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
      void worker.terminate();
    };
    const onAbort = () => finish(() => reject(signal?.reason instanceof Error ? signal.reason : new Error("The comparison was cancelled.")));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (result: AnalysisResult) => finish(() => resolve(revive(result))));
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => finish(() => reject(new Error(`the image comparison worker exited with code ${code}`))));
  });
}

export function runAnalysis(input: AnalysisInput, signal?: AbortSignal) {
  if (Math.max(pixelsOf(input.reference), pixelsOf(input.page)) <= WORKER_PIXEL_THRESHOLD) return analyzeImages(input);
  return analyzeInWorker(input, signal);
}
