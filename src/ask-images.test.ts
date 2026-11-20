import assert from "node:assert/strict";
import { test } from "node:test";
import { looksVisual, planTiles } from "./ask-images.ts";

const viewport = { width: 1280, height: 800 };

test("looksVisual fires for empty text, media-dominated viewports and sparse text, not for text pages", () => {
  assert.equal(looksVisual({ textChars: 0, viewport, pageHeight: 800, mediaArea: 0 }), true);
  assert.equal(looksVisual({ textChars: 4000, viewport, pageHeight: 800, mediaArea: 0.5 * 1280 * 800 }), true);
  assert.equal(looksVisual({ textChars: 120, viewport, pageHeight: 3000, mediaArea: 0 }), true);
  assert.equal(looksVisual({ textChars: 20_000, viewport, pageHeight: 5000, mediaArea: 0.1 * 1280 * 800 }), false);
  assert.equal(looksVisual({ textChars: 2500, viewport, pageHeight: 800, mediaArea: 0 }), false);
});

test("planTiles covers the page top to bottom with overlapping tiles", () => {
  assert.deepEqual(planTiles(5000, 1600, 80), [
    { y: 0, height: 1600 },
    { y: 1520, height: 1600 },
    { y: 3040, height: 1600 },
    { y: 4560, height: 440 },
  ]);
  assert.deepEqual(planTiles(900, 1600, 80), [{ y: 0, height: 900 }]);
  assert.deepEqual(planTiles(1600, 1600, 80), [{ y: 0, height: 1600 }]);
  assert.deepEqual(planTiles(1601, 1600, 80), [{ y: 0, height: 1600 }, { y: 1520, height: 81 }]);
});
