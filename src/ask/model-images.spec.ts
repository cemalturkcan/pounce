import { expect, test } from "bun:test";
import {
  describeSent,
  imageSize,
  MAX_IMAGE_BYTES,
  prepareModelImage,
  type Transcode,
  type TranscodeTarget,
} from "./model-images.ts";

function fakeTranscoder(bytesPerPixel: (target: TranscodeTarget) => number) {
  const seen: TranscodeTarget[] = [];
  const transcode: Transcode = async (_bytes, target) => {
    seen.push(target);
    const size = Math.ceil(target.width * target.height * bytesPerPixel(target));
    const magic = target.type === "image/jpeg" ? [0xff, 0xd8, 0xff] : [0x89, 0x50, 0x4e, 0x47];
    return Buffer.concat([Buffer.from(magic), Buffer.alloc(Math.max(0, size - magic.length))]);
  };
  return { transcode, seen };
}

const png = (width: number, height: number, size = 100) => ({
  bytes: Buffer.alloc(size),
  width,
  height,
  encoded: { type: "image/png" as const },
});

test("a large tile is sent at its captured resolution as JPEG 80", async () => {
  const { transcode, seen } = fakeTranscoder(() => 0.3);
  const prepared = await prepareModelImage(png(1920, 1600), "jpeg", transcode, "a.md tile 1/3");
  expect(seen).toStrictEqual([{ type: "image/jpeg", quality: 80, width: 1920, height: 1600 }]);
  expect(prepared.image.mediaType).toBe("image/jpeg");
  expect(prepared.image.label).toBe("a.md tile 1/3");
  expect([prepared.width, prepared.height, prepared.downscaled]).toStrictEqual([
    1920,
    1600,
    undefined,
  ]);
  expect(Buffer.from(prepared.image.data, "base64").length).toBe(prepared.bytes);
});

test("an image already encoded as JPEG 80 is sent as is", async () => {
  const { transcode, seen } = fakeTranscoder(() => 0.3);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const prepared = await prepareModelImage(
    { bytes, width: 800, height: 600, encoded: { type: "image/jpeg", quality: 80 } },
    "jpeg",
    transcode,
    "viewport",
  );
  expect(seen).toStrictEqual([]);
  expect(prepared.image.data).toBe(bytes.toString("base64"));
});

test("a PNG crop under the limit stays PNG without re-encoding", async () => {
  const { transcode, seen } = fakeTranscoder(() => 1);
  const prepared = await prepareModelImage(png(300, 200, 5000), "png", transcode, "R1 design");
  expect(seen).toStrictEqual([]);
  expect(prepared.image.mediaType).toBe("image/png");
});

test("an oversized image is recompressed under 5 MB of base64 at the same dimensions when that is enough", async () => {
  const { transcode, seen } = fakeTranscoder((target) => (target.quality ?? 100) / 20);
  const prepared = await prepareModelImage(
    png(1000, 1000, MAX_IMAGE_BYTES + 10),
    "png",
    transcode,
    "big",
  );
  expect(
    seen.map((target) => `${target.type} ${target.quality} ${target.width}x${target.height}`),
  ).toStrictEqual(["image/jpeg 90 1000x1000", "image/jpeg 70 1000x1000"]);
  expect(prepared.image.data.length).toBeLessThan(5_000_000);
  expect([prepared.width, prepared.height, prepared.downscaled]).toStrictEqual([
    1000,
    1000,
    undefined,
  ]);
});

test("only when recompression is not enough is the image downscaled in 85% steps until it fits", async () => {
  const { transcode, seen } = fakeTranscoder(() => 5);
  const prepared = await prepareModelImage(
    png(1000, 1000, MAX_IMAGE_BYTES * 2),
    "jpeg",
    transcode,
    "huge",
  );
  expect(seen.slice(0, 4).map((target) => `${target.quality} ${target.width}`)).toStrictEqual([
    "80 1000",
    "70 1000",
    "60 1000",
    "50 1000",
  ]);
  expect(
    seen.slice(4).map((target) => `${target.quality} ${target.width}x${target.height}`),
  ).toStrictEqual(["50 850x850"]);
  expect(prepared.image.data.length).toBeLessThan(5_000_000);
  expect(prepared.downscaled).toStrictEqual({
    from: { width: 1000, height: 1000 },
    to: { width: 850, height: 850 },
  });
  expect([prepared.width, prepared.height]).toStrictEqual([850, 850]);
});

test("imageSize reads PNG and JPEG headers", async () => {
  const { encodePng } = await import("../visual/png.ts");
  const { createImage } = await import("../visual/pixels.ts");
  expect(imageSize(await encodePng(createImage(17, 9)))).toStrictEqual({ width: 17, height: 9 });
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03,
    0x20,
  ]);
  expect(imageSize(jpeg)).toStrictEqual({ width: 800, height: 600 });
  expect(imageSize(Buffer.from("nope"))).toBe(undefined);
});

test("only an image with a side over 8000 px is downscaled to fit 8000 before encoding", async () => {
  const { transcode, seen } = fakeTranscoder(() => 0.1);
  const tall = await prepareModelImage(png(1280, 9500), "jpeg", transcode, "whole design");
  expect(seen).toStrictEqual([{ type: "image/jpeg", quality: 80, width: 1078, height: 8000 }]);
  expect([tall.width, tall.height]).toStrictEqual([1078, 8000]);
  expect(tall.downscaled).toStrictEqual({
    from: { width: 1280, height: 9500 },
    to: { width: 1078, height: 8000 },
    reason: "side",
  });
  expect(describeSent([tall])).toMatch(
    /whole design was larger than 8000 px on a side and was downscaled from 1280x9500 to 1078x8000/,
  );
  const { transcode: second, seen: none } = fakeTranscoder(() => 0.1);
  const limit = await prepareModelImage(png(8000, 400, 100), "png", second, "wide");
  expect(none).toStrictEqual([]);
  expect([limit.width, limit.height, limit.downscaled]).toStrictEqual([8000, 400, undefined]);
});
