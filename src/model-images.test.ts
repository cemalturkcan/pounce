import assert from "node:assert/strict";
import { test } from "node:test";
import { imageSize, MAX_IMAGE_BYTES, prepareModelImage, type Transcode, type TranscodeTarget } from "./model-images.ts";

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

const png = (width: number, height: number, size = 100) => ({ bytes: Buffer.alloc(size), width, height, encoded: { type: "image/png" as const } });

test("a large tile is sent at its captured resolution as JPEG 80", async () => {
  const { transcode, seen } = fakeTranscoder(() => 0.3);
  const prepared = await prepareModelImage(png(1920, 1600), "jpeg", transcode, "a.md tile 1/3");
  assert.deepEqual(seen, [{ type: "image/jpeg", quality: 80, width: 1920, height: 1600 }]);
  assert.equal(prepared.image.mediaType, "image/jpeg");
  assert.equal(prepared.image.label, "a.md tile 1/3");
  assert.deepEqual([prepared.width, prepared.height, prepared.downscaled], [1920, 1600, undefined]);
  assert.equal(Buffer.from(prepared.image.data, "base64").length, prepared.bytes);
});

test("an image already encoded as JPEG 80 is sent as is", async () => {
  const { transcode, seen } = fakeTranscoder(() => 0.3);
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  const prepared = await prepareModelImage({ bytes, width: 800, height: 600, encoded: { type: "image/jpeg", quality: 80 } }, "jpeg", transcode, "viewport");
  assert.deepEqual(seen, []);
  assert.equal(prepared.image.data, bytes.toString("base64"));
});

test("a PNG crop under the limit stays PNG without re-encoding", async () => {
  const { transcode, seen } = fakeTranscoder(() => 1);
  const prepared = await prepareModelImage(png(300, 200, 5000), "png", transcode, "R1 design");
  assert.deepEqual(seen, []);
  assert.equal(prepared.image.mediaType, "image/png");
});

test("an oversized image is recompressed under 5 MB of base64 at the same dimensions when that is enough", async () => {
  const { transcode, seen } = fakeTranscoder((target) => (target.quality ?? 100) / 20);
  const prepared = await prepareModelImage(png(1000, 1000, MAX_IMAGE_BYTES + 10), "png", transcode, "big");
  assert.deepEqual(seen.map((target) => `${target.type} ${target.quality} ${target.width}x${target.height}`), [
    "image/jpeg 90 1000x1000",
    "image/jpeg 70 1000x1000",
  ]);
  assert.ok(prepared.image.data.length < 5_000_000, `${prepared.image.data.length} base64 chars`);
  assert.deepEqual([prepared.width, prepared.height, prepared.downscaled], [1000, 1000, undefined]);
});

test("only when recompression is not enough is the image downscaled in 85% steps until it fits", async () => {
  const { transcode, seen } = fakeTranscoder(() => 5);
  const prepared = await prepareModelImage(png(1000, 1000, MAX_IMAGE_BYTES * 2), "jpeg", transcode, "huge");
  assert.deepEqual(seen.slice(0, 4).map((target) => `${target.quality} ${target.width}`), ["80 1000", "70 1000", "60 1000", "50 1000"]);
  assert.deepEqual(seen.slice(4).map((target) => `${target.quality} ${target.width}x${target.height}`), ["50 850x850"]);
  assert.ok(prepared.image.data.length < 5_000_000);
  assert.deepEqual(prepared.downscaled, { from: { width: 1000, height: 1000 }, to: { width: 850, height: 850 } });
  assert.deepEqual([prepared.width, prepared.height], [850, 850]);
});

test("imageSize reads PNG and JPEG headers", async () => {
  const { encodePng } = await import("./png.ts");
  const { createImage } = await import("./pixels.ts");
  assert.deepEqual(imageSize(await encodePng(createImage(17, 9))), { width: 17, height: 9 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20]);
  assert.deepEqual(imageSize(jpeg), { width: 800, height: 600 });
  assert.equal(imageSize(Buffer.from("nope")), undefined);
});
