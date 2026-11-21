import { promisify } from "node:util";
import { crc32, deflate, inflate } from "node:zlib";
import type { RgbaImage } from "./pixels.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const MAX_PIXELS = 120_000_000;
const deflateAsync = promisify(deflate);
const inflateAsync = promisify(inflate);

export class UnsupportedPngError extends Error {}

export function isPng(bytes: Buffer) {
  return bytes.length >= SIGNATURE.length && bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE);
}

type Header = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
};

function readChunks(bytes: Buffer) {
  if (!isPng(bytes)) throw new UnsupportedPngError("not a PNG file");
  let header: Header | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];
  let offset = SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new UnsupportedPngError(`truncated ${type} chunk`);
    if (type === "IHDR") {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8] ?? 0,
        colorType: body[9] ?? 0,
        interlace: body[12] ?? 0,
      };
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header || data.length === 0) throw new UnsupportedPngError("missing IHDR or IDAT");
  return { header, palette, transparency, data: Buffer.concat(data) };
}

function checkSupported(header: Header) {
  const channels = CHANNELS.get(header.colorType);
  if (channels === undefined) throw new UnsupportedPngError(`color type ${header.colorType}`);
  if (header.interlace !== 0) throw new UnsupportedPngError("interlaced PNG");
  const lowDepthAllowed = header.colorType === 0 || header.colorType === 3;
  const depthOk =
    header.bitDepth === 8 ||
    (header.bitDepth === 16 && header.colorType !== 3) ||
    ([1, 2, 4].includes(header.bitDepth) && lowDepthAllowed);
  if (!depthOk)
    throw new UnsupportedPngError(
      `bit depth ${header.bitDepth} with color type ${header.colorType}`,
    );
  if (header.width === 0 || header.height === 0 || header.width * header.height > MAX_PIXELS)
    throw new UnsupportedPngError(`image size ${header.width}x${header.height}`);
  return channels;
}

function paeth(left: number, up: number, upLeft: number) {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  return pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
}

function unfilter(raw: Buffer, height: number, stride: number, bpp: number) {
  const out = Buffer.alloc(height * stride);
  if (raw.length < height * (stride + 1))
    throw new UnsupportedPngError("image data is shorter than the header says");
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    const previous = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[source + x] ?? 0;
      const left = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (out[previous + x] ?? 0) : 0;
      const upLeft = x >= bpp && y > 0 ? (out[previous + x - bpp] ?? 0) : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new UnsupportedPngError(`row filter ${filter}`);
      out[row + x] = (value + predictor) & 0xff;
    }
  }
  return out;
}

function sampleAt(row: Buffer, rowStart: number, index: number, bitDepth: number) {
  if (bitDepth === 8) return row[rowStart + index] ?? 0;
  if (bitDepth === 16) return row[rowStart + index * 2] ?? 0;
  const perByte = 8 / bitDepth;
  const byte = row[rowStart + Math.floor(index / perByte)] ?? 0;
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << bitDepth) - 1);
}

export function isDecodablePng(bytes: Buffer) {
  try {
    checkSupported(readChunks(bytes).header);
    return true;
  } catch (error) {
    if (error instanceof UnsupportedPngError) return false;
    throw error;
  }
}

export async function decodePng(bytes: Buffer): Promise<RgbaImage> {
  const { header, palette, transparency, data } = readChunks(bytes);
  const channels = checkSupported(header);
  const { width, height, bitDepth, colorType } = header;
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const raw = await inflateAsync(data).catch((error: Error) => {
    throw new UnsupportedPngError(`compressed data: ${error.message}`);
  });
  const pixels = unfilter(raw, height, stride, bpp);
  const out = new Uint8Array(width * height * 4);
  const grayScale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;
  const transparentGray =
    colorType === 0 && transparency && transparency.length >= 2
      ? transparency.readUInt16BE(0)
      : undefined;
  const transparentRgb =
    colorType === 2 && transparency && transparency.length >= 6
      ? [transparency.readUInt16BE(0), transparency.readUInt16BE(2), transparency.readUInt16BE(4)]
      : undefined;
  const rawValue = (rowStart: number, index: number) =>
    bitDepth === 16
      ? pixels.readUInt16BE(rowStart + index * 2)
      : sampleAt(pixels, rowStart, index, bitDepth);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      if (colorType === 3) {
        const index = sampleAt(pixels, rowStart, x, bitDepth);
        out[target] = palette?.[index * 3] ?? 0;
        out[target + 1] = palette?.[index * 3 + 1] ?? 0;
        out[target + 2] = palette?.[index * 3 + 2] ?? 0;
        out[target + 3] = transparency?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const gray = Math.round(sampleAt(pixels, rowStart, x * channels, bitDepth) * grayScale);
        out[target] = gray;
        out[target + 1] = gray;
        out[target + 2] = gray;
        out[target + 3] =
          colorType === 4
            ? sampleAt(pixels, rowStart, x * 2 + 1, bitDepth)
            : transparentGray === rawValue(rowStart, x)
              ? 0
              : 255;
      } else {
        for (let channel = 0; channel < 3; channel += 1)
          out[target + channel] = sampleAt(pixels, rowStart, x * channels + channel, bitDepth);
        const matchesKey =
          transparentRgb?.every(
            (value, channel) => value === rawValue(rowStart, x * 3 + channel),
          ) ?? false;
        out[target + 3] =
          colorType === 6 ? sampleAt(pixels, rowStart, x * 4 + 3, bitDepth) : matchesKey ? 0 : 255;
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type: string, body: Buffer) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
  return Buffer.concat([head, body, crc]);
}

export async function encodePng(image: RgbaImage, options: { level?: number } = {}) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 1;
    const row = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? (image.data[row + x - 4] ?? 0) : 0;
      raw[target + 1 + x] = ((image.data[row + x] ?? 0) - left) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", await deflateAsync(raw, { level: options.level ?? 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
