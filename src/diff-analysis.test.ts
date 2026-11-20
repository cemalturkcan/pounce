import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORTED_REGION_LIMIT, runAnalysis } from "./diff-analysis.ts";
import { clusterRegions, createImage, diffImages, fillRect } from "./pixels.ts";
import { encodePng } from "./png.ts";

function speckled(width: number, height: number, step: number) {
  const reference = createImage(width, height, [255, 255, 255, 255]);
  const page = createImage(width, height, [255, 255, 255, 255]);
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 5; y < height - step; y += step) {
    for (let x = 5; x < width - step; x += step) fillRect(page, { x: x + Math.floor(random() * (step - 14)), y: y + Math.floor(random() * (step - 14)), width: 3, height: 3 }, [0, 0, 0, 255]);
  }
  return { reference, page };
}

test("clustering dense specks over a tall page is fast", () => {
  const { reference, page } = speckled(1440, 8000, 22);
  const diff = diffImages(reference, page, { tolerance: 0.1 });
  const started = performance.now();
  const regions = clusterRegions(diff, { minArea: 64, mergeGap: 12 });
  const elapsed = performance.now() - started;
  assert.ok(regions.length > 0);
  assert.ok(elapsed < 3000, `clustering took ${Math.round(elapsed)} ms`);
});

test("a large comparison runs off the event loop and caps the reported regions", async () => {
  const { reference, page } = speckled(1440, 8000, 22);
  const [referencePng, pagePng] = await Promise.all([encodePng(reference), encodePng(page)]);
  let last = performance.now();
  let longestStall = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    longestStall = Math.max(longestStall, now - last);
    last = now;
  }, 20);
  const started = performance.now();
  try {
    const result = await runAnalysis({ reference: referencePng, page: pagePng, tolerance: 0.1, minArea: 64, mergeGap: 12, regionLimit: REPORTED_REGION_LIMIT, crops: 10, cropPadding: 16 });
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 8000, `analysis took ${Math.round(elapsed)} ms`);
    assert.ok(longestStall < 300, `the event loop stalled for ${Math.round(longestStall)} ms`);
    assert.ok(result.regionsFound > 0);
    assert.ok(result.regions.length <= REPORTED_REGION_LIMIT);
    assert.equal(result.crops.length, Math.min(10, result.regions.length));
    assert.ok(result.diffPng.subarray(1, 4).toString("latin1") === "PNG");
    assert.equal(result.page.data.length, 1440 * 8000 * 4);
  } finally {
    clearInterval(beat);
  }
});
