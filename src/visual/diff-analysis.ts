import { Worker } from "node:worker_threads";
import { z } from "zod";
import { inSequence } from "../shared/async.ts";
import { errorFrom, messageOf } from "../shared/errors.ts";
import {
  type Box,
  clusterRegions,
  crop,
  diffImages,
  renderDiffImage,
  resize,
  type RgbaImage,
} from "./pixels.ts";
import { decodePng, encodePng } from "./png.ts";
import { imageSize } from "../ask/model-images.ts";
import { DIFF_WORKER_URL } from "../workers.ts";

export const REPORTED_REGION_LIMIT = 200;
const WORKER_PIXEL_THRESHOLD = 1_000_000;

const rawBytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array);
const pngBytes = rawBytes.transform((bytes) => toBuffer(bytes));
const sizeSchema = z.object({ width: z.number(), height: z.number() });
const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
const regionSchema = boxSchema.extend({
  id: z.string(),
  area: z.number(),
  diffPixels: z.number(),
  mismatch: z.number(),
});
const imageSchema = sizeSchema.extend({ data: rawBytes });

export const analysisInputSchema = z.object({
  reference: pngBytes,
  page: pngBytes,
  tolerance: z.number(),
  minArea: z.number(),
  mergeGap: z.number(),
  regionLimit: z.number(),
  crops: z.number(),
  cropPadding: z.number(),
});

const analysisCropSchema = z.object({
  region: regionSchema,
  box: boxSchema,
  reference: imageSchema,
  page: imageSchema,
  referencePng: pngBytes,
  pagePng: pngBytes,
});

const analysisResultSchema = z.object({
  reference: imageSchema,
  page: imageSchema,
  referenceSize: sizeSchema,
  pageSize: sizeSchema,
  scaledPage: z.boolean(),
  notes: z.array(z.string()),
  diffPixels: z.number(),
  diffRatio: z.number(),
  regions: z.array(regionSchema),
  regionsFound: z.number(),
  diffPng: pngBytes,
  crops: z.array(analysisCropSchema),
});

type AnalysisInput = z.output<typeof analysisInputSchema>;
type AnalysisResult = z.output<typeof analysisResultSchema>;

function toBuffer(bytes: Uint8Array) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function aspectMatches(a: { width: number; height: number }, b: { width: number; height: number }) {
  return Math.abs(a.width / a.height - b.width / b.height) <= 0.01 * (a.width / a.height);
}

function align(reference: RgbaImage, page: RgbaImage, notes: string[]) {
  if (reference.width === page.width && reference.height === page.height)
    return { reference, page, scaledPage: false };
  if (aspectMatches(reference, page)) {
    notes.push(
      `The page capture (${page.width}x${page.height}) has the reference's proportions but not its size, so it was scaled to ${reference.width}x${reference.height} before comparing; pass device_scale_factor to capture at the reference's scale instead.`,
    );
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
  return {
    x,
    y,
    width: Math.min(width, region.x + region.width + pad) - x,
    height: Math.min(height, region.y + region.height + pad) - y,
  };
}

export async function analyzeImages(input: AnalysisInput): Promise<AnalysisResult> {
  const [referenceImage, pageImage] = await Promise.all([
    decodePng(input.reference),
    decodePng(input.page),
  ]);
  const notes: string[] = [];
  const aligned = align(referenceImage, pageImage, notes);
  const diff = diffImages(aligned.reference, aligned.page, { tolerance: input.tolerance });
  const found = clusterRegions(diff, { minArea: input.minArea, mergeGap: input.mergeGap });
  const regions = found.slice(0, input.regionLimit);
  const diffPng = await encodePng(renderDiffImage(aligned.page, diff, regions));
  const crops = await inSequence(regions.slice(0, input.crops), async (region) => {
    const box = padBox(
      region,
      input.cropPadding,
      aligned.reference.width,
      aligned.reference.height,
    );
    const reference = crop(aligned.reference, box);
    const page = crop(aligned.page, box);
    const [referencePng, pagePng] = await Promise.all([encodePng(reference), encodePng(page)]);
    return { region, box, reference, page, referencePng, pagePng };
  });
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

function analyzeInWorker(input: AnalysisInput, signal?: AbortSignal) {
  return new Promise<AnalysisResult>((resolve, reject) => {
    const worker = new Worker(DIFF_WORKER_URL, { workerData: input });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      action();
      void worker.terminate();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The comparison was cancelled."),
        ),
      );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message) =>
      finish(() => {
        const decoded = analysisResultSchema.safeParse(message);
        if (decoded.success) resolve(decoded.data);
        else
          reject(
            new Error(
              `the image comparison worker sent an invalid result: ${messageOf(decoded.error)}`,
            ),
          );
      }),
    );
    worker.once("error", (cause: unknown) => finish(() => reject(errorFrom(cause))));
    worker.once("exit", (code) =>
      finish(() => reject(new Error(`the image comparison worker exited with code ${code}`))),
    );
  });
}

export function runAnalysis(input: AnalysisInput, signal?: AbortSignal) {
  if (Math.max(pixelsOf(input.reference), pixelsOf(input.page)) <= WORKER_PIXEL_THRESHOLD)
    return analyzeImages(input);
  return analyzeInWorker(input, signal);
}
