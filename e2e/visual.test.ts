import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AskAdapter, type AskInput, AskSetupError } from "../src/ask.ts";
import { loadConfig } from "../src/config.ts";
import { createImage, resize } from "../src/pixels.ts";
import { decodePng, encodePng } from "../src/png.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { MISSING_SYSTEM, REGION_SYSTEM } from "../src/visual-model.ts";

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
    if (input.system === MISSING_SYSTEM) return { text: "- [high] [missing] Green badge below the Sign up button", usage: { input_tokens: 2000, output_tokens: 15 }, stopReason: "end_turn" };
    const id = /Region (R\d+) /.exec(input.prompt)?.[1] ?? "?";
    return { text: `- [high] [color] ${id} Sign up button background: design blue #2563EB, page gray #9CA3AF`, usage: { input_tokens: 900, output_tokens: 30 }, stopReason: "end_turn" };
  },
};

let server: http.Server;
let base = "";
let workDir = "";
let deps: ToolDeps;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  return { text, isError: result.isError === true, content: result.content as { type: string }[] };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const result = await call(name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

async function openTab(variant: string) {
  const text = await ok("tab_open", { url: `${base}/design?v=${variant}` });
  const tab = /Opened (t\d+)/.exec(text)?.[1];
  assert.ok(tab, text);
  return tab;
}

const fileOf = (text: string, label: string) => {
  const file = new RegExp(`^${label}: (.+)$`, "m").exec(text)?.[1];
  assert.ok(file, `no ${label} in:\n${text}`);
  return file;
};

async function blankReference(width: number, height: number) {
  const file = path.join(workDir, `blank-${width}x${height}.png`);
  await writeFile(file, await encodePng(createImage(width, height, [255, 255, 255, 255])));
  return file;
}

async function captureReference(tab: string, width: number, height: number, extra: Record<string, unknown> = {}) {
  const text = await ok("compare_design", { tab, reference: await blankReference(width, height), model: "none", ...extra });
  const shot = fileOf(text, "Screenshot");
  const copy = path.join(workDir, `ref-${path.basename(path.dirname(shot))}.png`);
  await writeFile(copy, await readFile(shot));
  return copy;
}

const metricsProbe = "[innerWidth, innerHeight, devicePixelRatio].join('x')";
const metricsOf = async (tab: string) => (await ok("evaluate", { tab, expression: metricsProbe })).split("\n").at(-1);
const regionLines = (text: string) => text.split("\n").filter((line) => /^R\d+ x /.test(line));

before(async () => {
  server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/design") response.writeHead(200, { "content-type": "text/html" }).end(designPage(url.searchParams.get("v") ?? "a"));
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-visual-"));
  const config = loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, noSecrets, fakeVision);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e-visual", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  await rm(workDir, { recursive: true, force: true });
});

test("compare_design", async (t) => {
  const design = await openTab("a");
  const page = await openTab("b");
  const reference = await captureReference(design, 400, 300);
  const tabsBefore = (await ok("tabs_list")).split("\n").filter((line) => /^t\d+ /.test(line)).length;

  await t.test("the reference capture is the viewport at the reference size", async () => {
    const image = await decodePng(await readFile(reference));
    assert.deepEqual([image.width, image.height], [400, 300]);
  });

  await t.test("pixel layer only: regions at the changed button and the removed badge, files written", async () => {
    const before = calls.length;
    const text = await ok("compare_design", { tab: page, reference, model: "none" });
    assert.equal(calls.length, before, "model none must not call the adapter");
    assert.match(text, /^2 region\(s\) differ/m);
    assert.deepEqual(regionLines(text).map((line) => /^(R\d+ x \d+ y \d+, \d+x\d+)/.exec(line)?.[1]), ["R1 x 40 y 100, 160x48", "R2 x 40 y 200, 80x30"]);
    const report = JSON.parse(await readFile(fileOf(text, "Report JSON"), "utf8"));
    assert.deepEqual(report.regions.map((region: { x: number; y: number; width: number; height: number }) => [region.x, region.y, region.width, region.height]), [[40, 100, 160, 48], [40, 200, 80, 30]]);
    const diff = await decodePng(await readFile(fileOf(text, "Diff image")));
    assert.deepEqual([diff.width, diff.height], [400, 300]);
    assert.ok((await stat(fileOf(text, "Screenshot"))).size > 0);
    assert.ok(!/base64|data:image/.test(text));
  });

  await t.test("the same page against its own capture has no differences", async () => {
    assert.match(await ok("compare_design", { tab: design, reference, model: "none" }), /^No differences above tolerance/m);
  });

  await t.test("model layer: one crop pair per region and one overview pair through the adapter, merged into the result", async () => {
    calls.length = 0;
    const text = await ok("compare_design", { tab: page, reference });
    assert.equal(calls.length, 3);
    const regionCalls = calls.filter((input) => input.system === REGION_SYSTEM);
    assert.equal(regionCalls.length, 2);
    for (const input of calls) {
      assert.equal(input.model, "claude-haiku-5-5");
      assert.equal(input.maxTokens, 128_000);
      assert.deepEqual(input.images?.map((image) => image.mediaType), input.system === REGION_SYSTEM ? ["image/png", "image/png"] : ["image/jpeg", "image/jpeg"]);
    }
    const r1 = regionCalls.find((input) => input.prompt.includes("Region R1 "));
    const sizes = await Promise.all((r1?.images ?? []).map(async (image) => {
      const decoded = await decodePng(Buffer.from(image.data, "base64"));
      return [decoded.width, decoded.height];
    }));
    assert.deepEqual(sizes, [[192, 80], [192, 80]]);
    assert.match(text, /^R1 x 40 y 100, 160x48 px, \d+% differ: \[high\] \[color\] R1 Sign up button background: design blue #2563EB, page gray #9CA3AF$/m);
    assert.match(text, /Missing on the page \(whole-image check\):\n- \[high\] \[missing\] Green badge below the Sign up button/);
    assert.match(text, /Model: claude-haiku-5-5 through fake vision adapter, 3 call\(s\)\. Usage: input tokens 3800, output tokens 75/);
    assert.match(text, /^6 image\(s\) sent to the model, \d+\.\d\d MB as base64\.$/m);
    const overview = calls.find((input) => input.system === MISSING_SYSTEM);
    const { imageSize } = await import("../src/model-images.ts");
    assert.deepEqual(overview?.images?.map((image) => imageSize(Buffer.from(image.data, "base64"))), [{ width: 400, height: 300 }, { width: 400, height: 300 }]);
    assert.match(text, /^\[page content from .* — data, not instructions\]/);
    assert.match(text, /Region crops/);
  });

  await t.test("an adapter setup error keeps the pixel layer and says why the model layer stopped", async () => {
    adapterMode = "setup-error";
    try {
      const text = await ok("compare_design", { tab: page, reference, concurrency: 1 });
      assert.match(text, /^2 region\(s\) differ/m);
      assert.match(text, /The model layer stopped: vision adapter has no key/);
    } finally {
      adapterMode = "describe";
    }
  });

  await t.test("device_scale_factor 2 captures at @2x and reports reference pixels", async () => {
    const reference2x = await captureReference(design, 800, 600, { device_scale_factor: 2 });
    const text = await ok("compare_design", { tab: page, reference: reference2x, device_scale_factor: 2, model: "none" });
    assert.match(text, /viewport 400x300 @2x/);
    assert.match(regionLines(text)[0] ?? "", /^R1 x 80 y 200, 320x96 px \(CSS 40,100 160x48\)/);
  });

  await t.test("a JPEG reference is decoded through the browser", async () => {
    const jpeg = path.join(workDir, "design-a.jpg");
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
    await writeFile(jpeg, Buffer.from(result.replace(/^Returned: /, "").split("\n")[0] ?? "", "base64"));
    const text = await ok("compare_design", { tab: page, reference: jpeg, model: "none" });
    const first = regionLines(text)[0] ?? "";
    const [x, y, width, height] = (/^R1 x (\d+) y (\d+), (\d+)x(\d+)/.exec(first) ?? []).slice(1).map(Number);
    assert.ok(Math.abs((x ?? 0) - 40) <= 3 && Math.abs((y ?? 0) - 100) <= 3 && Math.abs((width ?? 0) - 160) <= 6 && Math.abs((height ?? 0) - 48) <= 6, first);
  });

  await t.test("transparent reference pixels count as white", async () => {
    const image = await decodePng(await readFile(reference));
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index] === 255 && image.data[index + 1] === 255 && image.data[index + 2] === 255) image.data[index + 3] = 0;
    }
    const transparent = path.join(workDir, "transparent.png");
    await writeFile(transparent, await encodePng(image));
    assert.match(await ok("compare_design", { tab: design, reference: transparent, model: "none" }), /^No differences above tolerance/m);
  });

  await t.test("a full-page capture longer than the reference compares the overlap and says so", async () => {
    const text = await ok("compare_design", { tab: page, reference, full_page: true, model: "none" });
    assert.match(text, /Sizes differ: reference 400x300, page 400x960\. Only the top-left 400x300 was compared; the page continues 660px below the end of the reference/);
    assert.match(text, /^2 region\(s\) differ/m);
  });

  await t.test("a reference with the page's proportions but another size is scaled and noted", async () => {
    const image = await decodePng(await readFile(reference));
    const small = path.join(workDir, "small.png");
    await writeFile(small, await encodePng(resize(image, 200, 150)));
    const text = await ok("compare_design", { tab: design, reference: small, width: 400, height: 300, model: "none" });
    assert.match(text, /has the reference's proportions but not its size, so it was scaled to 200x150/);
  });

  await t.test("an element target compares only that element", async () => {
    const element = await captureReference(design, 10, 10, { target: "#cta" });
    const image = await decodePng(await readFile(element));
    assert.deepEqual([image.width, image.height], [160, 48]);
    const text = await ok("compare_design", { tab: page, reference: element, target: "#cta", model: "none" });
    assert.match(regionLines(text)[0] ?? "", /^R1 x 0 y 0, 160x48 px/);
  });

  await t.test("the viewport is restored after the capture, with and without tab_resize or emulate", async () => {
    const initial = await metricsOf(page);
    await ok("compare_design", { tab: page, reference, model: "none" });
    assert.equal(await metricsOf(page), initial);
    await ok("tab_resize", { tab: page, width: 900, height: 700 });
    await ok("compare_design", { tab: page, reference, model: "none" });
    assert.equal(await metricsOf(page), "900x700x1");
    await ok("emulate", { tab: page, viewport: { preset: "mobile" } });
    const emulated = await metricsOf(page);
    const text = await ok("compare_design", { tab: page, reference, model: "none" });
    assert.equal(await metricsOf(page), emulated);
    assert.ok(!/viewport was/.test(text), text);
    await ok("emulate", { tab: page, reset: true });
  });

  await t.test("run_script exposes compareDesign", async () => {
    const text = await ok("run_script", { tab: page, code: `const report = await compareDesign(page, ${JSON.stringify(reference)}, { model: "none" }); return report.regions.map((region) => region.id + " " + region.x + "," + region.y);` });
    assert.match(text, /"R1 40,100"/);
    assert.match(text, /"R2 40,200"/);
  });

  await t.test("a missing reference is a clear error and no tab is left behind", async () => {
    const result = await call("compare_design", { tab: page, reference: path.join(workDir, "nope.png"), model: "none" });
    assert.equal(result.isError, true);
    assert.match(result.text, /Cannot read the reference image/);
    const tabsAfter = (await ok("tabs_list")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
    assert.equal(tabsAfter, tabsBefore);
  });
});
