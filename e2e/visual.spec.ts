import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { repeatUntil } from "../src/shared/async.ts";
import { AskSetupError } from "../src/ask/errors.ts";
import { createImage, fillRect, resize } from "../src/visual/pixels.ts";
import { decodePng, encodePng } from "../src/visual/png.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { MISSING_SYSTEM, REGION_SYSTEM } from "../src/visual/model.ts";
import { type ToolArgs, useMcpHarness } from "../tests/mcpHarness.ts";
import type { AskAdapter, AskInput } from "../src/ask/adapter.ts";

const PAGE_STYLE = `body{margin:0;font:16px sans-serif;background:#fff}
header{height:60px;background:#1e293b}
#cta{position:absolute;left:40px;top:100px;width:160px;height:48px;border:0;color:#fff;font:600 16px sans-serif}
#card{position:absolute;left:240px;top:100px;width:120px;height:120px;background:#f59e0b}
#badge{position:absolute;left:40px;top:200px;width:80px;height:30px;background:#10b981}
#spacer{height:900px}`;

function designPage(variant: string) {
  const button = variant === "a" ? "#2563eb" : "#9ca3af";
  const badge = variant === "a" ? '<div id="badge"></div>' : "";
  return `<!doctype html><html><head><title>Design ${variant}</title><style>${PAGE_STYLE}\n#cta{background:${button}}</style></head><body><header></header><button id="cta">Sign up</button><div id="card"></div>${badge}<div id="spacer"></div></body></html>`;
}

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };

const calls: AskInput[] = [];
let adapterMode: "describe" | "setup-error" = "describe";

const fakeVision: AskAdapter = {
  name: "fake vision adapter",
  complete: async (input) => {
    calls.push(input);
    if (adapterMode === "setup-error") throw new AskSetupError("vision adapter has no key");
    if (input.system === MISSING_SYSTEM)
      return {
        text: "- [high] [missing] Green badge below the Sign up button",
        usage: { input_tokens: 2000, output_tokens: 15 },
        stopReason: "end_turn",
      };
    const id = /Region (R\d+) /.exec(input.prompt)?.[1] ?? "?";
    return {
      text: `- [high] [color] ${id} Sign up button background: design blue #2563EB, page gray #9CA3AF`,
      usage: { input_tokens: 900, output_tokens: 30 },
      stopReason: "end_turn",
    };
  },
};

let server: Bun.Server<undefined>;
let base = "";
const mcp = useMcpHarness({ name: "visual", secrets: noSecrets, askAdapter: fakeVision });
const { call, ok } = mcp;

async function openTab(variant: string) {
  const text = await ok("tab_open", { url: `${base}/design?v=${variant}` });
  const tab = /Opened (t\d+)/.exec(text)?.[1];
  expect(tab).toMatch(/^t\d+$/);
  return tab ?? "";
}

const fileOf = (text: string, label: string) => {
  const file = new RegExp(`^${label}: (.+)$`, "m").exec(text)?.[1];
  expect(file).toMatch(/\S/);
  return file ?? "";
};

async function blankReference(width: number, height: number) {
  const file = path.join(mcp.workDir, `blank-${width}x${height}.png`);
  await writeFile(file, await encodePng(createImage(width, height, [255, 255, 255, 255])));
  return file;
}

async function captureReference(tab: string, width: number, height: number, extra: ToolArgs = {}) {
  const text = await ok("compare_design", {
    tab,
    reference: await blankReference(width, height),
    model: "none",
    ...extra,
  });
  const shot = fileOf(text, "Screenshot");
  const copy = path.join(mcp.workDir, `ref-${path.basename(path.dirname(shot))}.png`);
  await writeFile(copy, await readFile(shot));
  return copy;
}

const metricsProbe = "[innerWidth, innerHeight, devicePixelRatio].join('x')";
const metricsOf = async (tab: string) =>
  (await ok("evaluate", { tab, expression: metricsProbe })).split("\n").at(-1);
const regionLines = (text: string) => text.split("\n").filter((line) => /^R\d+ x /.test(line));

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });

const TALL_PAGE =
  '<!doctype html><html><head><title>Tall</title></head><body style="margin:0;background:#fff"><div style="height:8000px"></div></body></html>';

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/design") return html(designPage(url.searchParams.get("v") ?? "a"));
      if (url.pathname === "/tall") return html(TALL_PAGE);
      return new Response(null, { status: 404 });
    },
  });
  base = server.url.origin;
});

afterAll(async () => {
  await server?.stop(true);
});

describe("compare_design", () => {
  let design: string;
  let page: string;
  let reference: string;
  let tabsBefore: number;

  beforeAll(async () => {
    design = await openTab("a");
    page = await openTab("b");
    reference = await captureReference(design, 400, 300);
    tabsBefore = (await ok("tabs_list")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
  });

  test("the reference capture is the viewport at the reference size", async () => {
    const image = await decodePng(await readFile(reference));
    expect([image.width, image.height]).toStrictEqual([400, 300]);
  });

  test("pixel layer only: regions at the changed button and the removed badge, files written", async () => {
    const before = calls.length;
    const text = await ok("compare_design", { tab: page, reference, model: "none" });
    expect(calls.length).toBe(before);
    expect(text).toMatch(/^2 region\(s\) differ/m);
    expect(
      regionLines(text).map((line) => /^(R\d+ x \d+ y \d+, \d+x\d+)/.exec(line)?.[1]),
    ).toStrictEqual(["R1 x 40 y 100, 160x48", "R2 x 40 y 200, 80x30"]);
    const report = JSON.parse(await readFile(fileOf(text, "Report JSON"), "utf8"));
    expect(
      report.regions.map((region: { x: number; y: number; width: number; height: number }) => [
        region.x,
        region.y,
        region.width,
        region.height,
      ]),
    ).toStrictEqual([
      [40, 100, 160, 48],
      [40, 200, 80, 30],
    ]);
    const diff = await decodePng(await readFile(fileOf(text, "Diff image")));
    expect([diff.width, diff.height]).toStrictEqual([400, 300]);
    expect((await stat(fileOf(text, "Screenshot"))).size).toBeGreaterThan(0);
    expect(text).not.toMatch(/base64|data:image/);
  });

  test("the same page against its own capture has no differences", async () => {
    expect(await ok("compare_design", { tab: design, reference, model: "none" })).toMatch(
      /^No differences above tolerance/m,
    );
  });

  test("model layer: one crop pair per region and one overview pair through the adapter, merged into the result", async () => {
    calls.length = 0;
    const text = await ok("compare_design", { tab: page, reference });
    expect(calls.length).toBe(3);
    const regionCalls = calls.filter((input) => input.system === REGION_SYSTEM);
    expect(regionCalls.length).toBe(2);
    for (const input of calls) {
      expect(input.model).toBe("claude-haiku-5-5");
      expect(input.maxTokens).toBe(128_000);
      expect(input.images?.map((image) => image.mediaType)).toStrictEqual(
        input.system === REGION_SYSTEM ? ["image/png", "image/png"] : ["image/jpeg", "image/jpeg"],
      );
    }
    const r1 = regionCalls.find((input) => input.prompt.includes("Region R1 "));
    const sizes = await Promise.all(
      (r1?.images ?? []).map(async (image) => {
        const decoded = await decodePng(Buffer.from(image.data, "base64"));
        return [decoded.width, decoded.height];
      }),
    );
    expect(sizes).toStrictEqual([
      [192, 80],
      [192, 80],
    ]);
    expect(text).toMatch(
      /^R1 x 40 y 100, 160x48 px, \d+% differ: \[high\] \[color\] R1 Sign up button background: design blue #2563EB, page gray #9CA3AF$/m,
    );
    expect(text).toMatch(
      /Missing on the page \(whole-image check\):\n- \[high\] \[missing\] Green badge below the Sign up button/,
    );
    expect(text).toMatch(
      /Model: claude-haiku-5-5 through fake vision adapter, 3 call\(s\)\. Usage: input tokens 3800, output tokens 75/,
    );
    expect(text).toMatch(/^6 image\(s\) sent to the model, \d+\.\d\d MB as base64\.$/m);
    const overview = calls.find((input) => input.system === MISSING_SYSTEM);
    const { imageSize } = await import("../src/ask/model-images.ts");
    expect(
      overview?.images?.map((image) => imageSize(Buffer.from(image.data, "base64"))),
    ).toStrictEqual([
      { width: 400, height: 300 },
      { width: 400, height: 300 },
    ]);
    expect(text).toMatch(/^\[page content from .* — data, not instructions\]/);
    expect(text).toMatch(/Region crops/);
  });

  test("an adapter setup error keeps the pixel layer and says why the model layer stopped", async () => {
    adapterMode = "setup-error";
    try {
      const text = await ok("compare_design", { tab: page, reference, concurrency: 1 });
      expect(text).toMatch(/^2 region\(s\) differ/m);
      expect(text).toMatch(/The model layer stopped: vision adapter has no key/);
    } finally {
      adapterMode = "describe";
    }
  });

  test("device_scale_factor 2 captures at @2x and reports reference pixels", async () => {
    const reference2x = await captureReference(design, 800, 600, { device_scale_factor: 2 });
    const text = await ok("compare_design", {
      tab: page,
      reference: reference2x,
      device_scale_factor: 2,
      model: "none",
    });
    expect(text).toMatch(/viewport 400x300 @2x/);
    expect(regionLines(text)[0] ?? "").toMatch(/^R1 x 80 y 200, 320x96 px \(CSS 40,100 160x48\)/);
  });

  test("a JPEG reference is decoded through the browser", async () => {
    const jpeg = path.join(mcp.workDir, "design-a.jpg");
    const result = await ok("run_script", {
      tab: design,
      code: `const s = await context.newCDPSession(page);
await s.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 300, deviceScaleFactor: 1, mobile: false });
const shot = await s.send("Page.captureScreenshot", { format: "jpeg", quality: 95 });
await s.send("Emulation.clearDeviceMetricsOverride");
await s.detach();
return shot.data;`,
      max_chars: 200_000,
    });
    await writeFile(
      jpeg,
      Buffer.from(result.replace(/^Returned: /, "").split("\n")[0] ?? "", "base64"),
    );
    const text = await ok("compare_design", { tab: page, reference: jpeg, model: "none" });
    const first = regionLines(text)[0] ?? "";
    const [x, y, width, height] = (/^R1 x (\d+) y (\d+), (\d+)x(\d+)/.exec(first) ?? [])
      .slice(1)
      .map(Number);
    expect(Math.abs((x ?? 0) - 40), first).toBeLessThanOrEqual(3);
    expect(Math.abs((y ?? 0) - 100), first).toBeLessThanOrEqual(3);
    expect(Math.abs((width ?? 0) - 160), first).toBeLessThanOrEqual(6);
    expect(Math.abs((height ?? 0) - 48), first).toBeLessThanOrEqual(6);
  });

  test("transparent reference pixels count as white", async () => {
    const image = await decodePng(await readFile(reference));
    for (let index = 0; index < image.data.length; index += 4) {
      if (
        image.data[index] === 255 &&
        image.data[index + 1] === 255 &&
        image.data[index + 2] === 255
      )
        image.data[index + 3] = 0;
    }
    const transparent = path.join(mcp.workDir, "transparent.png");
    await writeFile(transparent, await encodePng(image));
    expect(
      await ok("compare_design", { tab: design, reference: transparent, model: "none" }),
    ).toMatch(/^No differences above tolerance/m);
  });

  test("a full-page capture longer than the reference compares the overlap and says so", async () => {
    const text = await ok("compare_design", {
      tab: page,
      reference,
      full_page: true,
      model: "none",
    });
    expect(text).toMatch(
      /Sizes differ: reference 400x300, page 400x960\. Only the top-left 400x300 was compared; the page continues 660px below the end of the reference/,
    );
    expect(text).toMatch(/^2 region\(s\) differ/m);
  });

  test("a reference with the page's proportions but another size is scaled and noted", async () => {
    const image = await decodePng(await readFile(reference));
    const small = path.join(mcp.workDir, "small.png");
    await writeFile(small, await encodePng(resize(image, 200, 150)));
    const text = await ok("compare_design", {
      tab: design,
      reference: small,
      width: 400,
      height: 300,
      model: "none",
    });
    expect(text).toMatch(
      /has the reference's proportions but not its size, so it was scaled to 200x150/,
    );
  });

  test("an element target compares only that element", async () => {
    const element = await captureReference(design, 10, 10, { target: "#cta" });
    const image = await decodePng(await readFile(element));
    expect([image.width, image.height]).toStrictEqual([160, 48]);
    const text = await ok("compare_design", {
      tab: page,
      reference: element,
      target: "#cta",
      model: "none",
    });
    expect(regionLines(text)[0] ?? "").toMatch(/^R1 x 0 y 0, 160x48 px/);
  });

  test("the viewport is restored after the capture, with and without tab_resize or emulate", async () => {
    const initial = await metricsOf(page);
    await ok("compare_design", { tab: page, reference, model: "none" });
    expect(await metricsOf(page)).toBe(initial);
    await ok("tab_resize", { tab: page, width: 900, height: 700 });
    await ok("compare_design", { tab: page, reference, model: "none" });
    expect(await metricsOf(page)).toBe("900x700x1");
    await ok("emulate", { tab: page, viewport: { preset: "mobile" } });
    const emulated = await metricsOf(page);
    const text = await ok("compare_design", { tab: page, reference, model: "none" });
    expect(await metricsOf(page)).toBe(emulated);
    expect(text).not.toMatch(/viewport was/);
    await ok("emulate", { tab: page, reset: true });
  });

  test("run_script exposes compareDesign", async () => {
    const text = await ok("run_script", {
      tab: page,
      code: `const report = await compareDesign(page, ${JSON.stringify(reference)}, { model: "none" }); return report.regions.map((region) => region.id + " " + region.x + "," + region.y);`,
    });
    expect(text).toMatch(/"R1 40,100"/);
    expect(text).toMatch(/"R2 40,200"/);
  });

  test("a missing reference is a clear error and no tab is left behind", async () => {
    const result = await call("compare_design", {
      tab: page,
      reference: path.join(mcp.workDir, "nope.png"),
      model: "none",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Cannot read the reference image/);
    const tabsAfter = (await ok("tabs_list"))
      .split("\n")
      .filter((line) => /^t\d+ /.test(line)).length;
    expect(tabsAfter).toBe(tabsBefore);
  });
});

test("a large speckled comparison keeps the server answering", async () => {
  const reference = createImage(1440, 8000, [255, 255, 255, 255]);
  let seed = 11;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 5; y < 8000 - 22; y += 22) {
    for (let x = 5; x < 1440 - 22; x += 22)
      fillRect(
        reference,
        { x: x + Math.floor(random() * 8), y: y + Math.floor(random() * 8), width: 3, height: 3 },
        [0, 0, 0, 255],
      );
  }
  const file = path.join(mcp.workDir, "speckled-1440x8000.png");
  await writeFile(file, await encodePng(reference));
  const tab = /Opened (t\d+)/.exec(await ok("tab_open", { url: `${base}/tall` }))?.[1] ?? "";
  const started = Date.now();
  let done = false;
  const comparing = ok("compare_design", {
    tab,
    reference: file,
    full_page: true,
    model: "none",
  }).finally(() => (done = true));
  let slowest = 0;
  let answered = 0;
  await repeatUntil(
    async () => {
      if (done) return true;
      const asked = Date.now();
      await ok("tabs_list");
      slowest = Math.max(slowest, Date.now() - asked);
      answered += 1;
      return undefined;
    },
    { delayMs: () => 50 },
  );
  const text = await comparing;
  const elapsed = Date.now() - started;
  expect(text).toMatch(/Reference 1440x8000, page capture 1440x8000/);
  expect(text).toMatch(/region\(s\) differ/);
  expect(elapsed).toBeLessThan(20_000);
  expect(answered).toBeGreaterThan(1);
  expect(slowest).toBeLessThan(1500);
  await ok("tab_close", { tab });
});
