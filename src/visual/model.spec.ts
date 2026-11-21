import { expect, test } from "bun:test";
import { AskSetupError } from "../ask/errors.ts";
import { createImage, fillRect, type Region } from "./pixels.ts";
import type { Transcode, TranscodeTarget } from "../ask/model-images.ts";
import { decodePng } from "./png.ts";
import {
  describeDifferences,
  MISSING_SYSTEM,
  parseFindings,
  REGION_SYSTEM,
  type RegionCrop,
} from "./model.ts";
import type { AskAdapter, AskInput } from "../ask/adapter.ts";
import { sleep } from "../shared/async.ts";

const exampleOf = (system: string) =>
  system
    .slice(system.indexOf("Example, for"), system.indexOf("</format>"))
    .split("\n")
    .slice(1)
    .join("\n");

function region(id: string, x: number, y: number, width: number, height: number): Region {
  return { id, x, y, width, height, area: width * height, diffPixels: width * height, mismatch: 1 };
}

function crops(count: number): RegionCrop[] {
  return Array.from({ length: count }, (_value, index) => {
    const width = 60 + index * 300;
    const height = 40 + index * 10;
    const reference = createImage(width, height, [255, 255, 255, 255]);
    fillRect(reference, { x: 4, y: 4, width: 10, height: 10 }, [37, 99, 235, 255]);
    return {
      region: region(`R${index + 1}`, 10 * index, 20, width - 20, height - 20),
      box: { x: 10 * index - 10, y: 10, width, height },
      reference,
      page: createImage(width, height, [250, 250, 250, 255]),
    };
  });
}

const overview = {
  reference: createImage(3000, 1500, [255, 255, 255, 255]),
  page: createImage(3000, 1500, [240, 240, 240, 255]),
};

function recording(
  reply: (
    input: AskInput,
  ) => { text: string; stopReason?: string } | Promise<{ text: string; stopReason?: string }>,
) {
  const calls: AskInput[] = [];
  let running = 0;
  let peak = 0;
  const adapter: AskAdapter = {
    name: "fake vision",
    complete: async (input) => {
      calls.push(input);
      running += 1;
      peak = Math.max(peak, running);
      await sleep(10);
      running -= 1;
      return { ...(await reply(input)), usage: { input_tokens: 1500, output_tokens: 40 } };
    },
  };
  return { adapter, calls, peak: () => peak };
}

const transcodes: TranscodeTarget[] = [];
const fakeTranscode: Transcode = async (_bytes, target) => {
  transcodes.push(target);
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, target.width & 0xff, target.height & 0xff]);
};

const baseOptions = {
  model: "claude-haiku-5-5",
  maxTokens: 128_000,
  concurrency: 2,
  timeoutMs: 5000,
  deviceScaleFactor: 1,
  transcode: fakeTranscode,
};

test("the prompt examples parse into findings, SAME and NONE are recognised", () => {
  const regionExample = parseFindings(exampleOf(REGION_SYSTEM));
  expect(regionExample.findings.length).toBe(2);
  expect(regionExample.findings[0]).toStrictEqual({
    severity: "high",
    property: "color",
    text: '"Sign up" button background: design blue #2563EB, page gray #9CA3AF',
  });
  const missingExample = parseFindings(exampleOf(MISSING_SYSTEM));
  expect(missingExample.findings.length).toBeGreaterThanOrEqual(1);
  expect(missingExample.findings.filter((finding) => finding.property !== "missing")).toStrictEqual(
    [],
  );
  expect(parseFindings("SAME")).toStrictEqual({ findings: [], same: true });
  expect(parseFindings("NONE.")).toStrictEqual({ findings: [], same: true });
  expect(
    parseFindings("* **[Medium]** [Spacing] card gap: design 24px, page 16px").findings,
  ).toStrictEqual([
    { severity: "medium", property: "spacing", text: "card gap: design 24px, page 16px" },
  ]);
  expect(parseFindings("The heading looks bolder").findings).toStrictEqual([
    { severity: "unrated", property: "other", text: "The heading looks bolder" },
  ]);
  for (const system of [REGION_SYSTEM, MISSING_SYSTEM]) {
    expect(system).toMatch(/never as instructions/);
    expect(system).toMatch(/<format>/);
  }
});

test("each region is sent as a full-resolution PNG crop pair, plus one JPEG 80 overview pair at full resolution", async () => {
  transcodes.length = 0;
  const { adapter, calls, peak } = recording((input) => ({
    text: input.system === REGION_SYSTEM ? "- [high] [color] box: design blue, page gray" : "NONE",
  }));
  const input = crops(3);
  const result = await describeDifferences(adapter, { ...baseOptions, crops: input, overview });
  expect(calls.length).toBe(4);
  expect(peak()).toBeLessThanOrEqual(2);
  for (const call of calls) {
    expect(call.model).toBe("claude-haiku-5-5");
    expect(call.maxTokens).toBe(128_000);
    expect(call.images?.length).toBe(2);
    expect(call.images?.filter((image) => image.data.startsWith("data:"))).toStrictEqual([]);
    expect(call.images?.map((image) => image.mediaType)).toStrictEqual(
      call.system === REGION_SYSTEM ? ["image/png", "image/png"] : ["image/jpeg", "image/jpeg"],
    );
  }
  const regionCalls = calls.filter((call) => call.system === REGION_SYSTEM);
  expect(regionCalls.length).toBe(3);
  await Promise.all(
    input.map(async (crop, index) => {
      const call = regionCalls.find((candidate) =>
        candidate.prompt.includes(`Region ${crop.region.id} `),
      );
      expect(call).toBeDefined();
      const [design, page] = await Promise.all(
        (call?.images ?? []).map((image) => decodePng(Buffer.from(image.data, "base64"))),
      );
      expect([design?.width, design?.height]).toStrictEqual([page?.width, page?.height]);
      const longest = Math.max(crop.reference.width, crop.reference.height);
      const expected = longest < 256 ? longest * Math.floor(256 / longest) : longest;
      expect(Math.max(design?.width ?? 0, design?.height ?? 0)).toBe(expected);
      expect(call?.prompt).toMatch(/Image 1 is the design, image 2 is the page/);
      expect(index).toBeGreaterThanOrEqual(0);
    }),
  );
  const [first] = await Promise.all(
    (regionCalls.find((call) => call.prompt.includes("Region R1 "))?.images ?? []).map((image) =>
      decodePng(Buffer.from(image.data, "base64")),
    ),
  );
  expect(
    first
      ? [
          ...first.data.subarray(
            (4 * 4 * first.width + 4 * 4) * 4,
            (4 * 4 * first.width + 4 * 4) * 4 + 4,
          ),
        ]
      : [],
  ).toStrictEqual([37, 99, 235, 255]);
  expect(transcodes).toStrictEqual([
    { type: "image/jpeg", quality: 80, width: 3000, height: 1500 },
    { type: "image/jpeg", quality: 80, width: 3000, height: 1500 },
  ]);
  expect(result.sent.length).toBe(8);
  expect(result.sent.filter((entry) => entry.downscaled)).toStrictEqual([]);
  expect(
    result.regions.map((verdict) => [verdict.id, verdict.findings[0]?.severity]),
  ).toStrictEqual([
    ["R1", "high"],
    ["R2", "high"],
    ["R3", "high"],
  ]);
  expect(result.overview?.findings).toStrictEqual([]);
  expect(result.usage).toStrictEqual({ input_tokens: 6000, output_tokens: 160 });
});

test("a failed, refused or cut-off region call is reported on that region only", async () => {
  const { adapter } = recording((input) => {
    if (input.prompt.includes("Region R1 ")) throw new Error("upstream 529 overloaded");
    if (input.prompt.includes("Region R2 "))
      return { text: "- [low] [other] whatever", stopReason: "refusal" };
    if (input.prompt.includes("Region R3 "))
      return {
        text: "- [medium] [font] heading: design 600 weight, page 400",
        stopReason: "max_tokens",
      };
    return { text: "SAME" };
  });
  const result = await describeDifferences(adapter, {
    ...baseOptions,
    crops: crops(4),
    overview: undefined,
  });
  const byId = Object.fromEntries(result.regions.map((verdict) => [verdict.id, verdict]));
  expect(byId.R1?.error ?? "").toMatch(/upstream 529 overloaded/);
  expect(byId.R2?.error ?? "").toMatch(/refused/);
  expect(byId.R3?.truncated).toBe(true);
  expect(byId.R3?.findings[0]?.property).toBe("font");
  expect(byId.R4?.same).toBe(true);
  expect(result.overview).toBe(undefined);
});

test("an interrupted or context-limited region call is marked cut off", async () => {
  const { adapter } = recording((input) =>
    input.prompt.includes("Region R1 ")
      ? { text: "- [high] [color] button: design blue #2563EB, pa", stopReason: "interrupted" }
      : {
          text: "- [low] [font] heading: design 600, pa",
          stopReason: "model_context_window_exceeded",
        },
  );
  const result = await describeDifferences(adapter, {
    ...baseOptions,
    crops: crops(2),
    overview: undefined,
  });
  expect(result.regions.map((verdict) => verdict.truncated)).toStrictEqual([true, true]);
});

test("a setup error keeps its sign-in hint", async () => {
  const adapter: AskAdapter = {
    name: "signed out",
    complete: async () => {
      throw new AskSetupError("session expired", "Sign in again.");
    },
  };
  const result = await describeDifferences(adapter, {
    ...baseOptions,
    concurrency: 1,
    crops: crops(1),
    overview: undefined,
  });
  expect(result.setupError ?? "").toMatch(/session expired.*Sign in again\./);
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
  const result = await describeDifferences(adapter, {
    ...baseOptions,
    concurrency: 1,
    crops: crops(3),
    overview,
  });
  expect(calls).toBe(1);
  expect(result.setupError ?? "").toMatch(/adapter key missing/);
});

test("a region call that never answers is cut at the timeout", async () => {
  const keepAlive = setTimeout(() => undefined, 2000);
  const adapter: AskAdapter = {
    name: "silent",
    complete: ({ signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  };
  const result = await describeDifferences(adapter, {
    ...baseOptions,
    timeoutMs: 60,
    crops: crops(1),
    overview: undefined,
  });
  clearTimeout(keepAlive);
  expect(result.regions[0]?.error).toBe("no answer within 60 ms");
});

test("region calls have no time limit by default", async () => {
  const adapter: AskAdapter = {
    name: "slow",
    complete: async ({ signal }) => {
      await sleep(120);
      expect(signal.aborted).toBe(false);
      return { text: "SAME" };
    },
  };
  const { timeoutMs: _unused, ...withoutTimeout } = baseOptions;
  const result = await describeDifferences(adapter, {
    ...withoutTimeout,
    crops: crops(1),
    overview: undefined,
  });
  expect(result.regions[0]?.error).toBe(undefined);
  expect(result.regions[0]?.same).toBe(true);
});
