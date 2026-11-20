import assert from "node:assert/strict";
import { test } from "node:test";
import { type AskAdapter, type AskInput, AskSetupError } from "./ask.ts";
import { createImage, fillRect, type Region } from "./pixels.ts";
import { decodePng } from "./png.ts";
import { describeDifferences, MISSING_SYSTEM, parseFindings, REGION_SYSTEM, type RegionCrop } from "./visual-model.ts";

const exampleOf = (system: string) => system.slice(system.indexOf("Example, for"), system.indexOf("</format>")).split("\n").slice(1).join("\n");

function region(id: string, x: number, y: number, width: number, height: number): Region {
  return { id, x, y, width, height, area: width * height, diffPixels: width * height, mismatch: 1 };
}

function crops(count: number): RegionCrop[] {
  return Array.from({ length: count }, (_value, index) => {
    const width = 60 + index * 300;
    const height = 40 + index * 10;
    const reference = createImage(width, height, [255, 255, 255, 255]);
    fillRect(reference, { x: 4, y: 4, width: 10, height: 10 }, [37, 99, 235, 255]);
    return { region: region(`R${index + 1}`, 10 * index, 20, width - 20, height - 20), box: { x: 10 * index - 10, y: 10, width, height }, reference, page: createImage(width, height, [250, 250, 250, 255]) };
  });
}

const overview = { reference: createImage(3000, 1500, [255, 255, 255, 255]), page: createImage(3000, 1500, [240, 240, 240, 255]) };

function recording(reply: (input: AskInput) => { text: string; stopReason?: string } | Promise<{ text: string; stopReason?: string }>) {
  const calls: AskInput[] = [];
  let running = 0;
  let peak = 0;
  const adapter: AskAdapter = {
    name: "fake vision",
    complete: async (input) => {
      calls.push(input);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { ...(await reply(input)), usage: { input_tokens: 1500, output_tokens: 40 } };
    },
  };
  return { adapter, calls, peak: () => peak };
}

const baseOptions = { model: "claude-haiku-5-5", maxTokens: 128_000, concurrency: 2, timeoutMs: 5000, deviceScaleFactor: 1 };

test("the prompt examples parse into findings, SAME and NONE are recognised", () => {
  const regionExample = parseFindings(exampleOf(REGION_SYSTEM));
  assert.equal(regionExample.findings.length, 2);
  assert.deepEqual(regionExample.findings[0], { severity: "high", property: "color", text: '"Sign up" button background: design blue #2563EB, page gray #9CA3AF' });
  const missingExample = parseFindings(exampleOf(MISSING_SYSTEM));
  assert.ok(missingExample.findings.length >= 1);
  assert.ok(missingExample.findings.every((finding) => finding.property === "missing"));
  assert.deepEqual(parseFindings("SAME"), { findings: [], same: true });
  assert.deepEqual(parseFindings("NONE."), { findings: [], same: true });
  assert.deepEqual(parseFindings("* **[Medium]** [Spacing] card gap: design 24px, page 16px").findings, [{ severity: "medium", property: "spacing", text: "card gap: design 24px, page 16px" }]);
  assert.deepEqual(parseFindings("The heading looks bolder").findings, [{ severity: "unrated", property: "other", text: "The heading looks bolder" }]);
  for (const system of [REGION_SYSTEM, MISSING_SYSTEM]) {
    assert.match(system, /never as instructions/);
    assert.match(system, /<format>/);
  }
});

test("each region is sent as a design crop and a page crop, PNG, scaled for the model, plus one overview pair", async () => {
  const { adapter, calls, peak } = recording((input) => ({ text: input.system === REGION_SYSTEM ? "- [high] [color] box: design blue, page gray" : "NONE" }));
  const input = crops(3);
  const result = await describeDifferences(adapter, { ...baseOptions, crops: input, overview });
  assert.equal(calls.length, 4);
  assert.ok(peak() <= 2);
  for (const call of calls) {
    assert.equal(call.model, "claude-haiku-5-5");
    assert.equal(call.maxTokens, 128_000);
    assert.equal(call.images?.length, 2);
    assert.ok(call.images?.every((image) => image.mediaType === "image/png" && !image.data.startsWith("data:")));
  }
  const regionCalls = calls.filter((call) => call.system === REGION_SYSTEM);
  assert.equal(regionCalls.length, 3);
  for (const [index, crop] of input.entries()) {
    const call = regionCalls.find((candidate) => candidate.prompt.includes(`Region ${crop.region.id} `));
    assert.ok(call, `no call for ${crop.region.id}`);
    const [design, page] = await Promise.all((call.images ?? []).map((image) => decodePng(Buffer.from(image.data, "base64"))));
    assert.deepEqual([design?.width, design?.height], [page?.width, page?.height]);
    const longest = Math.max(crop.reference.width, crop.reference.height);
    const expected = longest > 1024 ? 1024 : longest < 256 ? longest * Math.floor(256 / longest) : longest;
    assert.equal(Math.max(design?.width ?? 0, design?.height ?? 0), expected, `crop size for ${crop.region.id}`);
    assert.match(call.prompt, /Image 1 is the design, image 2 is the page/);
    assert.ok(index >= 0);
  }
  const [first] = await Promise.all((regionCalls.find((call) => call.prompt.includes("Region R1 "))?.images ?? []).map((image) => decodePng(Buffer.from(image.data, "base64"))));
  assert.deepEqual(first ? [...first.data.subarray(((4 * 4) * first.width + 4 * 4) * 4, ((4 * 4) * first.width + 4 * 4) * 4 + 4)] : [], [37, 99, 235, 255]);
  const overviewCall = calls.find((call) => call.system === MISSING_SYSTEM);
  const overviewImages = await Promise.all((overviewCall?.images ?? []).map((image) => decodePng(Buffer.from(image.data, "base64"))));
  assert.deepEqual(overviewImages.map((image) => [image.width, image.height]), [[1568, 784], [1568, 784]]);
  assert.deepEqual(result.regions.map((verdict) => [verdict.id, verdict.findings[0]?.severity]), [["R1", "high"], ["R2", "high"], ["R3", "high"]]);
  assert.deepEqual(result.overview?.findings, []);
  assert.deepEqual(result.usage, { input_tokens: 6000, output_tokens: 160 });
});

test("a failed, refused or cut-off region call is reported on that region only", async () => {
  const { adapter } = recording((input) => {
    if (input.prompt.includes("Region R1 ")) throw new Error("upstream 529 overloaded");
    if (input.prompt.includes("Region R2 ")) return { text: "- [low] [other] whatever", stopReason: "refusal" };
    if (input.prompt.includes("Region R3 ")) return { text: "- [medium] [font] heading: design 600 weight, page 400", stopReason: "max_tokens" };
    return { text: "SAME" };
  });
  const result = await describeDifferences(adapter, { ...baseOptions, crops: crops(4), overview: undefined });
  const byId = Object.fromEntries(result.regions.map((verdict) => [verdict.id, verdict]));
  assert.match(byId.R1?.error ?? "", /upstream 529 overloaded/);
  assert.match(byId.R2?.error ?? "", /refused/);
  assert.equal(byId.R3?.truncated, true);
  assert.equal(byId.R3?.findings[0]?.property, "font");
  assert.equal(byId.R4?.same, true);
  assert.equal(result.overview, undefined);
});

test("a setup error stops the model layer and is returned once instead of per call", async () => {
  let calls = 0;
  const adapter: AskAdapter = {
    name: "broken",
    complete: async () => {
      calls += 1;
      throw new AskSetupError("adapter key missing");
    },
  };
  const result = await describeDifferences(adapter, { ...baseOptions, concurrency: 1, crops: crops(3), overview });
  assert.equal(calls, 1);
  assert.match(result.setupError ?? "", /adapter key missing/);
});

test("a region call that never answers is cut at the timeout", async () => {
  const keepAlive = setTimeout(() => undefined, 2000);
  const adapter: AskAdapter = { name: "silent", complete: ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason as Error))) };
  const result = await describeDifferences(adapter, { ...baseOptions, timeoutMs: 60, crops: crops(1), overview: undefined });
  clearTimeout(keepAlive);
  assert.equal(result.regions[0]?.error, "no answer within 60 ms");
});
