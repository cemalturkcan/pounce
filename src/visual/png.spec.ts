import { expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import { decodePng, encodePng, isPng, UnsupportedPngError } from "./png.ts";
import { createImage } from "./pixels.ts";
import { pixel } from "../../tests/pixels.ts";

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function handmadePng(options: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace?: number;
  rows: Buffer[];
  filters?: number[];
  extra?: Buffer[];
}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width, 0);
  header.writeUInt32BE(options.height, 4);
  header[8] = options.bitDepth;
  header[9] = options.colorType;
  header[12] = options.interlace ?? 0;
  const raw = Buffer.concat(
    options.rows.map((row, index) =>
      Buffer.concat([Buffer.from([options.filters?.[index] ?? 0]), row]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...(options.extra ?? []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function filterRows(rows: Buffer[], bpp: number, filters: number[]) {
  return rows.map((row, y) => {
    const previous = rows[y - 1] ?? Buffer.alloc(row.length);
    const out = Buffer.alloc(row.length);
    for (let x = 0; x < row.length; x += 1) {
      const left = x >= bpp ? (row[x - bpp] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= bpp ? (previous[x - bpp] ?? 0) : 0;
      const value = row[x] ?? 0;
      const filter = filters[y] ?? 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter] ?? 0;
      out[x] = (value - predictor) & 0xff;
    }
    return out;
  });
}

test("encodePng and decodePng round-trip an RGBA image with transparency", async () => {
  const image = createImage(7, 5, [10, 20, 30, 255]);
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = (index * 7) % 256;
    image.data[index + 3] = (index * 13) % 256;
  }
  const encoded = await encodePng(image);
  expect(isPng(encoded)).toBe(true);
  const decoded = await decodePng(encoded);
  expect([decoded.width, decoded.height]).toStrictEqual([7, 5]);
  expect(Buffer.from(decoded.data)).toStrictEqual(Buffer.from(image.data));
});

test("decodePng undoes all five row filters", async () => {
  const width = 4;
  const rows = Array.from({ length: 5 }, (_value, y) =>
    Buffer.from(Array.from({ length: width * 3 }, (_item, x) => (x * 31 + y * 17) % 256)),
  );
  const filters = [0, 1, 2, 3, 4];
  const png = handmadePng({
    width,
    height: 5,
    bitDepth: 8,
    colorType: 2,
    rows: filterRows(rows, 3, filters),
    filters,
  });
  const decoded = await decodePng(png);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const row = rows[y] ?? Buffer.alloc(0);
      expect(pixel(decoded, x, y)).toStrictEqual([
        row[x * 3] ?? 0,
        row[x * 3 + 1] ?? 0,
        row[x * 3 + 2] ?? 0,
        255,
      ]);
    }
  }
});

test("decodePng reads grayscale, gray with alpha, 16-bit and palette images with tRNS", async () => {
  const gray = await decodePng(
    handmadePng({ width: 2, height: 1, bitDepth: 8, colorType: 0, rows: [Buffer.from([0, 200])] }),
  );
  expect(pixel(gray, 1, 0)).toStrictEqual([200, 200, 200, 255]);
  const grayAlpha = await decodePng(
    handmadePng({ width: 1, height: 1, bitDepth: 8, colorType: 4, rows: [Buffer.from([90, 128])] }),
  );
  expect(pixel(grayAlpha, 0, 0)).toStrictEqual([90, 90, 90, 128]);
  const deep = await decodePng(
    handmadePng({
      width: 1,
      height: 1,
      bitDepth: 16,
      colorType: 6,
      rows: [Buffer.from([0x12, 0x34, 0xab, 0xcd, 0xff, 0x00, 0x80, 0x00])],
    }),
  );
  expect(pixel(deep, 0, 0)).toStrictEqual([0x12, 0xab, 0xff, 0x80]);
  const palette = await decodePng(
    handmadePng({
      width: 4,
      height: 1,
      bitDepth: 2,
      colorType: 3,
      rows: [Buffer.from([0b00011011])],
      extra: [
        chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9])),
        chunk("tRNS", Buffer.from([255, 0])),
      ],
    }),
  );
  expect([
    pixel(palette, 0, 0),
    pixel(palette, 1, 0),
    pixel(palette, 2, 0),
    pixel(palette, 3, 0),
  ]).toStrictEqual([
    [255, 0, 0, 255],
    [0, 255, 0, 0],
    [0, 0, 255, 255],
    [9, 9, 9, 255],
  ]);
});

test("decodePng refuses interlaced and malformed files with UnsupportedPngError", async () => {
  await expect(
    decodePng(
      handmadePng({
        width: 1,
        height: 1,
        bitDepth: 8,
        colorType: 2,
        interlace: 1,
        rows: [Buffer.from([1, 2, 3])],
      }),
    ),
  ).rejects.toThrow(UnsupportedPngError);
  await expect(decodePng(Buffer.from("not a png at all"))).rejects.toThrow(UnsupportedPngError);
  expect(isPng(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
});
