import { expect, test } from "bun:test";
import {
  clusterRegions,
  createImage,
  crop,
  diffImages,
  fillRect,
  flattenOnWhite,
  renderDiffImage,
  resize,
  scaleForModel,
} from "./pixels.ts";
import { pixel } from "../../tests/pixels.ts";

function canvas(width = 200, height = 120) {
  return createImage(width, height, [255, 255, 255, 255]);
}

test("identical images have no differing pixels and no regions", () => {
  const image = canvas();
  fillRect(image, { x: 20, y: 20, width: 40, height: 20 }, [30, 90, 200, 255]);
  const diff = diffImages(image, structuredClone(image), { tolerance: 0.1 });
  expect(diff.count).toBe(0);
  expect(clusterRegions(diff, { minArea: 16, mergeGap: 8 })).toStrictEqual([]);
});

test("a changed block is found as one region with its bounding box, area and mismatch ratio", () => {
  const reference = canvas();
  const page = canvas();
  fillRect(reference, { x: 50, y: 30, width: 40, height: 20 }, [37, 99, 235, 255]);
  fillRect(page, { x: 50, y: 30, width: 40, height: 20 }, [107, 114, 128, 255]);
  const diff = diffImages(reference, page, { tolerance: 0.1 });
  expect(diff.count).toBe(800);
  const regions = clusterRegions(diff, { minArea: 16, mergeGap: 8 });
  expect(regions.length).toBe(1);
  expect(regions[0]).toStrictEqual({
    id: "R1",
    x: 50,
    y: 30,
    width: 40,
    height: 20,
    area: 800,
    diffPixels: 800,
    mismatch: 1,
  });
});

test("tolerance ignores small color noise and catches clear changes", () => {
  const reference = canvas(20, 20);
  const page = canvas(20, 20);
  fillRect(reference, { x: 0, y: 0, width: 20, height: 20 }, [120, 120, 120, 255]);
  fillRect(page, { x: 0, y: 0, width: 20, height: 20 }, [123, 121, 119, 255]);
  expect(diffImages(reference, page, { tolerance: 0.1 }).count).toBe(0);
  fillRect(page, { x: 0, y: 0, width: 20, height: 20 }, [200, 120, 120, 255]);
  expect(diffImages(reference, page, { tolerance: 0.1 }).count).toBe(400);
  expect(diffImages(reference, page, { tolerance: 0.9 }).count).toBe(0);
});

test("a one-pixel anti-aliasing shift of an edge is not counted, a thin color change is", () => {
  const reference = canvas(40, 40);
  const page = canvas(40, 40);
  fillRect(reference, { x: 10, y: 10, width: 20, height: 20 }, [0, 0, 0, 255]);
  fillRect(page, { x: 11, y: 10, width: 20, height: 20 }, [0, 0, 0, 255]);
  expect(diffImages(reference, page, { tolerance: 0.1 }).count).toBe(0);
  const lined = canvas(40, 40);
  fillRect(lined, { x: 10, y: 10, width: 20, height: 20 }, [0, 0, 0, 255]);
  fillRect(lined, { x: 0, y: 35, width: 40, height: 1 }, [255, 0, 0, 255]);
  expect(diffImages(reference, lined, { tolerance: 0.1 }).count).toBe(40);
});

test("transparent pixels are compared as if on white", () => {
  const transparent = createImage(4, 4, [0, 0, 0, 0]);
  expect(pixel(flattenOnWhite(transparent), 0, 0)).toStrictEqual([255, 255, 255, 255]);
  expect(diffImages(transparent, canvas(4, 4), { tolerance: 0.1 }).count).toBe(0);
  const half = createImage(1, 1, [0, 0, 0, 128]);
  expect(pixel(flattenOnWhite(half), 0, 0)).toStrictEqual([127, 127, 127, 255]);
});

test("nearby boxes merge, distant boxes stay apart, tiny specks are dropped, largest first", () => {
  const reference = canvas(300, 200);
  const page = canvas(300, 200);
  fillRect(page, { x: 10, y: 10, width: 30, height: 10 }, [0, 0, 0, 255]);
  fillRect(page, { x: 44, y: 10, width: 30, height: 10 }, [0, 0, 0, 255]);
  fillRect(page, { x: 200, y: 120, width: 60, height: 50 }, [0, 0, 0, 255]);
  fillRect(page, { x: 150, y: 5, width: 2, height: 2 }, [0, 0, 0, 255]);
  const regions = clusterRegions(diffImages(reference, page, { tolerance: 0.1 }), {
    minArea: 16,
    mergeGap: 8,
  });
  expect(regions.map(({ id, x, y, width, height }) => ({ id, x, y, width, height }))).toStrictEqual(
    [
      { id: "R1", x: 200, y: 120, width: 60, height: 50 },
      { id: "R2", x: 10, y: 10, width: 64, height: 10 },
    ],
  );
  expect(regions[1]?.diffPixels).toBe(600);
  expect(regions[1]?.mismatch).toBe(600 / 640);
});

test("diffImages needs equal sizes", () => {
  expect(() => diffImages(canvas(10, 10), canvas(10, 11), { tolerance: 0.1 })).toThrow(/same size/);
});

test("crop, resize and scaleForModel keep sizes predictable", () => {
  const image = canvas(100, 50);
  fillRect(image, { x: 0, y: 0, width: 50, height: 50 }, [0, 0, 0, 255]);
  const piece = crop(image, { x: 40, y: 10, width: 20, height: 10 });
  expect([piece.width, piece.height]).toStrictEqual([20, 10]);
  expect(pixel(piece, 0, 0)).toStrictEqual([0, 0, 0, 255]);
  expect(pixel(piece, 19, 0)).toStrictEqual([255, 255, 255, 255]);
  const half = resize(image, 50, 25);
  expect([half.width, half.height]).toStrictEqual([50, 25]);
  expect(pixel(half, 5, 5)).toStrictEqual([0, 0, 0, 255]);
  expect(pixel(half, 45, 5)).toStrictEqual([255, 255, 255, 255]);
  const big = scaleForModel(canvas(3000, 1000), 1000, 200);
  expect([big.width, big.height]).toStrictEqual([1000, 333]);
  const tiny = scaleForModel(canvas(40, 20), 1000, 200);
  expect([tiny.width, tiny.height]).toStrictEqual([200, 100]);
  const fine = scaleForModel(canvas(400, 300), 1000, 200);
  expect([fine.width, fine.height]).toStrictEqual([400, 300]);
});

test("renderDiffImage marks differing pixels red and outlines regions", () => {
  const reference = canvas(60, 60);
  const page = canvas(60, 60);
  fillRect(page, { x: 20, y: 20, width: 10, height: 10 }, [0, 0, 0, 255]);
  const diff = diffImages(reference, page, { tolerance: 0.1 });
  const regions = clusterRegions(diff, { minArea: 4, mergeGap: 4 });
  const image = renderDiffImage(page, diff, regions);
  expect([image.width, image.height]).toStrictEqual([60, 60]);
  expect(pixel(image, 25, 25)).toStrictEqual([255, 0, 0, 255]);
  const outline = pixel(image, 20 - 3, 25);
  expect(outline).toStrictEqual([255, 0, 255, 255]);
  expect(pixel(image, 5, 5)).not.toStrictEqual([255, 0, 0, 255]);
});
