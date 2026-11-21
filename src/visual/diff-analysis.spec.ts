import { expect, test } from "bun:test";
import { REPORTED_REGION_LIMIT, runAnalysis } from "./diff-analysis.ts";
import { clusterRegions, createImage, diffImages, fillRect } from "./pixels.ts";
import { encodePng } from "./png.ts";

function speckled(width: number, height: number, step: number) {
  const reference = createImage(width, height, [255, 255, 255, 255]);
  const page = createImage(width, height, [255, 255, 255, 255]);
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 5; y < height - step; y += step) {
    for (let x = 5; x < width - step; x += step)
      fillRect(
        page,
        {
          x: x + Math.floor(random() * (step - 14)),
          y: y + Math.floor(random() * (step - 14)),
          width: 3,
          height: 3,
        },
        [0, 0, 0, 255],
      );
  }
  return { reference, page };
}

test("clustering dense specks over a tall page is fast", () => {
  const { reference, page } = speckled(1440, 8000, 22);
  const diff = diffImages(reference, page, { tolerance: 0.1 });
  const started = performance.now();
  const regions = clusterRegions(diff, { minArea: 64, mergeGap: 12 });
  const elapsed = performance.now() - started;
  expect(regions.length).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(3000);
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
    const result = await runAnalysis({
      reference: referencePng,
      page: pagePng,
      tolerance: 0.1,
      minArea: 64,
      mergeGap: 12,
      regionLimit: REPORTED_REGION_LIMIT,
      crops: 10,
      cropPadding: 16,
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(8000);
    expect(longestStall).toBeLessThan(300);
    expect(result.regionsFound).toBeGreaterThan(0);
    expect(result.regions.length).toBeLessThanOrEqual(REPORTED_REGION_LIMIT);
    expect(result.crops.length).toBe(Math.min(10, result.regions.length));
    expect(result.diffPng.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(result.page.data.length).toBe(1440 * 8000 * 4);
  } finally {
    clearInterval(beat);
  }
});
