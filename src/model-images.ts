import type { Page } from "playwright-core";
import type { AskImage } from "./ask-adapter.ts";
import { withTimeout } from "./async.ts";
import { ToolError } from "./errors.ts";

export const MAX_IMAGE_BYTES = 3_750_000;
export const MAX_IMAGE_SIDE = 8000;
export const JPEG_QUALITY = 80;
const PNG_FALLBACK_QUALITY = 90;
const LOWER_QUALITIES = [70, 60, 50];
const DOWNSCALE_STEP = 0.85;
const MIN_SIDE = 16;
const TRANSCODE_TIMEOUT_MS = 30_000;

export type TranscodeTarget = { type: "image/jpeg" | "image/png"; quality?: number; width: number; height: number };
export type Transcode = (bytes: Buffer, target: TranscodeTarget) => Promise<Buffer>;
export type ImageSource = { bytes: Buffer; width: number; height: number; encoded?: { type: "image/jpeg" | "image/png"; quality?: number } };
export type Size = { width: number; height: number };
export type PreparedImage = { image: AskImage; bytes: number; width: number; height: number; downscaled?: { from: Size; to: Size; reason?: "side" } };

function fitSide(size: Size): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= MAX_IMAGE_SIDE) return size;
  const scale = MAX_IMAGE_SIDE / longest;
  return { width: Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.round(size.width * scale))), height: Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.round(size.height * scale))) };
}

export function imageSize(bytes: Buffer) {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
    }
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}

function ladder(format: "jpeg" | "png", width: number, height: number): TranscodeTarget[] {
  const first: TranscodeTarget = format === "png" ? { type: "image/png", width, height } : { type: "image/jpeg", quality: JPEG_QUALITY, width, height };
  const fallback: TranscodeTarget[] = format === "png" ? [{ type: "image/jpeg", quality: PNG_FALLBACK_QUALITY, width, height }] : [];
  return [first, ...fallback, ...LOWER_QUALITIES.map((quality): TranscodeTarget => ({ type: "image/jpeg", quality, width, height }))];
}

const sameEncoding = (source: ImageSource, target: TranscodeTarget) => source.encoded?.type === target.type && source.encoded.quality === target.quality;

export async function prepareModelImage(source: ImageSource, format: "jpeg" | "png", transcode: Transcode, label: string): Promise<PreparedImage> {
  const fitted = fitSide(source);
  const sideLimited = fitted.width !== source.width || fitted.height !== source.height;
  const prepared = (target: TranscodeTarget, bytes: Buffer): PreparedImage => {
    const resized = target.width !== source.width || target.height !== source.height;
    const reason = sideLimited && target.width === fitted.width && target.height === fitted.height ? { reason: "side" as const } : {};
    return {
      image: { mediaType: target.type, data: bytes.toString("base64"), label },
      bytes: bytes.length,
      width: target.width,
      height: target.height,
      ...(resized ? { downscaled: { from: { width: source.width, height: source.height }, to: { width: target.width, height: target.height }, ...reason } } : {}),
    };
  };
  let last: PreparedImage | undefined;
  for (const target of ladder(format, fitted.width, fitted.height)) {
    last = prepared(target, !sideLimited && sameEncoding(source, target) ? source.bytes : await transcode(source.bytes, target));
    if (last.bytes <= MAX_IMAGE_BYTES) return last;
  }
  const quality = LOWER_QUALITIES.at(-1);
  let size = fitted;
  while (Math.min(size.width, size.height) * DOWNSCALE_STEP >= MIN_SIDE) {
    size = { width: Math.round(size.width * DOWNSCALE_STEP), height: Math.round(size.height * DOWNSCALE_STEP) };
    const target: TranscodeTarget = { type: "image/jpeg", quality, ...size };
    last = prepared(target, await transcode(source.bytes, target));
    if (last.bytes <= MAX_IMAGE_BYTES) return last;
  }
  return last ?? prepared({ type: format === "png" ? "image/png" : "image/jpeg", width: fitted.width, height: fitted.height }, source.bytes);
}

export function browserTranscoder(page: Page): Transcode {
  return async (bytes, target) => {
    const base64 = await withTimeout(
      page.evaluate(
        async ({ data, type, quality, width, height }) => {
          const binary = atob(data);
          const array = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) array[index] = binary.charCodeAt(index);
          const bitmap = await createImageBitmap(new Blob([array]));
          const canvas = new OffscreenCanvas(width, height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no 2d context");
          if (type === "image/jpeg") {
            context.fillStyle = "#fff";
            context.fillRect(0, 0, width, height);
          }
          context.imageSmoothingQuality = "high";
          context.drawImage(bitmap, 0, 0, width, height);
          bitmap.close();
          const blob = await canvas.convertToBlob({ type, quality: quality === undefined ? undefined : quality / 100 });
          const out = new Uint8Array(await blob.arrayBuffer());
          let text = "";
          for (let index = 0; index < out.length; index += 0x8000) text += String.fromCharCode(...out.subarray(index, index + 0x8000));
          return btoa(text);
        },
        { data: bytes.toString("base64"), ...target },
      ),
      TRANSCODE_TIMEOUT_MS,
      () => new ToolError(`Re-encoding an image for the model did not finish within ${TRANSCODE_TIMEOUT_MS} ms.`),
    );
    return Buffer.from(base64, "base64");
  };
}

export function describeSent(prepared: PreparedImage[]) {
  const base64 = prepared.reduce((total, entry) => total + entry.image.data.length, 0);
  const lines = [`${prepared.length} image(s) sent to the model, ${(base64 / 1_000_000).toFixed(2)} MB as base64.`];
  for (const entry of prepared) {
    if (!entry.downscaled) continue;
    const { from, to, reason } = entry.downscaled;
    const why = reason === "side" ? `was larger than ${MAX_IMAGE_SIDE} px on a side` : "was over the 5 MB image limit after recompression";
    lines.push(`${entry.image.label ?? "image"} ${why} and was downscaled from ${from.width}x${from.height} to ${to.width}x${to.height}.`);
  }
  return lines.join("\n");
}
