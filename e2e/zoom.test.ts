import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AskAdapter, AskInput } from "../src/ask.ts";
import { loadConfig } from "../src/config.ts";
import { createImage } from "../src/pixels.ts";
import { decodePng, encodePng } from "../src/png.ts";
import type { RgbaImage } from "../src/pixels.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { loadReference } from "../src/visual.ts";

const PAGE_HEIGHT = 2400;
const MARKERS = `<!doctype html><html><head><title>Zoom markers</title><style>
body{margin:0;background:#fff;height:${PAGE_HEIGHT}px;position:relative}
.corner{position:fixed;width:40px;height:40px}
#box{position:absolute;left:100px;top:120px;width:200px;height:50px;background:#f0f}
#bottom{position:absolute;left:0;right:0;bottom:0;height:60px;background:#0ff}
</style></head><body>
<div class="corner" style="left:0;top:0;background:#f00"></div>
<div class="corner" style="right:0;top:0;background:#0f0"></div>
<div class="corner" style="left:0;bottom:0;background:#00f"></div>
<div class="corner" style="right:0;bottom:0;background:#ff0"></div>
<div id="box"></div><div id="bottom"></div>
</body></html>`;

const RED = [255, 0, 0];
const LIME = [0, 255, 0];
const BLUE = [0, 0, 255];
const YELLOW = [255, 255, 0];
const MAGENTA = [255, 0, 255];
const CYAN = [0, 255, 255];

const zoomLevel = (factor: number) => Math.log(factor) / Math.log(1.2);
const ZOOMS = [
  { name: "a per-site zoom of 110%", host: "127.0.0.2", factor: 1.1 },
  { name: "a default zoom of 90%", host: "127.0.0.1", factor: 0.9 },
];

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };
const calls: AskInput[] = [];
const recorder: AskAdapter = {
  name: "image recorder",
  complete: async (input) => {
    calls.push(input);
    return { text: "NOT FOUND", usage: { input_tokens: 10, output_tokens: 2 } };
  },
};

const servers: http.Server[] = [];
let port = 0;
let workDir = "";
let deps: ToolDeps;
let client: Client;
let decoderTab = "";

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  assert.equal(result.isError === true, false, `${name} failed: ${text}`);
  return text;
}

async function openTab(url: string) {
  const tab = /Opened (t\d+)/.exec(await call("tab_open", { url }))?.[1];
  assert.ok(tab);
  return tab;
}

async function decode(bytes: Buffer): Promise<RgbaImage> {
  const file = path.join(workDir, `decode-${Date.now()}-${Math.random().toString(36).slice(2)}.img`);
  await writeFile(file, bytes);
  const { png } = await loadReference(deps.manager.getTab(decoderTab).page, file);
  return decodePng(png);
}

const pixel = (image: RgbaImage, x: number, y: number) => {
  const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
};

function assertColor(image: RgbaImage, x: number, y: number, expected: number[], label: string) {
  const actual = pixel(image, x, y);
  assert.ok(actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 60), `${label}: pixel ${x},${y} of the ${image.width}x${image.height} image is ${actual.join(",")}, expected ${expected.join(",")}`);
}

function assertWholeViewport(image: RgbaImage, width: number, height: number, scale = 1) {
  assert.deepEqual([image.width, image.height], [width * scale, height * scale], "image size is the CSS viewport");
  const right = image.width - 4;
  const bottom = image.height - 4;
  assertColor(image, 3, 3, RED, "top left marker");
  assertColor(image, right, 3, LIME, "top right marker");
  assertColor(image, 3, bottom, BLUE, "bottom left marker");
  assertColor(image, right, bottom, YELLOW, "bottom right marker");
  assertColor(image, 99 * scale, 145 * scale, [255, 255, 255], "left of the box");
  assertColor(image, 101 * scale, 145 * scale, MAGENTA, "box left edge");
  assertColor(image, 298 * scale, 145 * scale, MAGENTA, "box right edge");
  assertColor(image, 301 * scale, 145 * scale, [255, 255, 255], "right of the box");
}

function assertWholeBox(image: RgbaImage) {
  assert.deepEqual([image.width, image.height], [200, 50], "element image size is the element's CSS box");
  for (const [x, y] of [[2, 2], [197, 2], [2, 47], [197, 47]] as const) assertColor(image, x, y, MAGENTA, "box corner");
}

function assertPageBottom(image: RgbaImage, width: number) {
  assert.deepEqual([image.width, image.height], [width, PAGE_HEIGHT], "full-page image size is the CSS page");
  assertColor(image, image.width / 2, image.height - 3, CYAN, "bottom bar");
  assertColor(image, image.width / 2, image.height - 58, CYAN, "bottom bar top");
  assertColor(image, image.width / 2, image.height - 62, [255, 255, 255], "above the bottom bar");
}

const screenshotFile = (text: string) => {
  const file = /saved to (\S+?\.jpg)/.exec(text)?.[1];
  assert.ok(file, text);
  return file;
};

before(async () => {
  const handler: http.RequestListener = (request, response) => {
    if ((request.url ?? "/").startsWith("/markers")) response.writeHead(200, { "content-type": "text/html" }).end(MARKERS);
    else response.writeHead(404).end();
  };
  const first = http.createServer(handler);
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  port = (first.address() as AddressInfo).port;
  const second = http.createServer(handler);
  await new Promise<void>((resolve) => second.listen(port, "127.0.0.2", resolve));
  servers.push(first, second);
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-zoom-"));
  const config = loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
  const perHost = ZOOMS.filter((zoom) => zoom.host !== "127.0.0.1").map((zoom) => [zoom.host, { last_modified: "13300000000000000", zoom_level: zoomLevel(zoom.factor) }]);
  const defaultZoom = ZOOMS.find((zoom) => zoom.host === "127.0.0.1")?.factor ?? 1;
  await writeFile(
    path.join(config.profileDir, "Default", "Preferences"),
    JSON.stringify({ partition: { default_zoom_level: { x: zoomLevel(defaultZoom) }, per_host_zoom_levels: { x: Object.fromEntries(perHost) } } }),
  );
  deps = createDeps(config, noSecrets, recorder);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e-zoom", version: "0" });
  await client.connect(clientTransport);
  decoderTab = await openTab("about:blank");
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  for (const server of servers) {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
  await rm(workDir, { recursive: true, force: true });
});

for (const zoom of ZOOMS) {
  test(`captures under ${zoom.name}`, async (t) => {
    const url = `http://${zoom.host}:${port}/markers`;
    const tab = await openTab(url);
    const metrics = (await call("evaluate", { tab, expression: "[innerWidth, innerHeight, devicePixelRatio].join('x')" })).split("\n").at(-1) ?? "";
    const [width = 0, height = 0, ratio = 0] = metrics.split("x").map(Number);

    await t.test("the browser applies the zoom", () => {
      assert.ok(Math.abs(ratio - zoom.factor) < 0.01, `devicePixelRatio is ${ratio}`);
    });

    await t.test("screenshot of the viewport shows the whole viewport", async () => {
      assertWholeViewport(await decode(await readFile(screenshotFile(await call("screenshot", { tab, save_only: true })))), width, height);
    });

    await t.test("screenshot of an element shows exactly that element", async () => {
      assertWholeBox(await decode(await readFile(screenshotFile(await call("screenshot", { tab, target: "#box", save_only: true })))));
    });

    await t.test("screenshot of the full page reaches the page bottom", async () => {
      assertPageBottom(await decode(await readFile(screenshotFile(await call("screenshot", { tab, full_page: true, save_only: true })))), width);
    });

    await t.test("ask_pages viewport and region images show the whole viewport and the element", async () => {
      await call("ask_pages", { question: "What is on the page?", tabs: [tab], images: "viewport", regions: [{ target: "#box" }] });
      const images = calls.at(-1)?.images ?? [];
      assert.equal(images.length, 2);
      assertWholeViewport(await decode(Buffer.from(images[0]?.data ?? "", "base64")), width, height);
      assertWholeBox(await decode(Buffer.from(images[1]?.data ?? "", "base64")));
    });

    await t.test("ask_pages full tiles cover the page down to its bottom", async () => {
      await call("ask_pages", { question: "What is on the page?", tabs: [tab], images: "full" });
      const images = calls.at(-1)?.images ?? [];
      assert.equal(images.length, 2);
      const first = await decode(Buffer.from(images[0]?.data ?? "", "base64"));
      assert.deepEqual([first.width, first.height], [width, 1600]);
      assertColor(first, 150, 145, MAGENTA, "box in the first tile");
      const last = await decode(Buffer.from(images.at(-1)?.data ?? "", "base64"));
      assert.equal(last.width, width);
      assertColor(last, width / 2, last.height - 3, CYAN, "bottom bar in the last tile");
      assertColor(last, width / 2, last.height - 62, [255, 255, 255], "above the bottom bar in the last tile");
    });

    await t.test("collect_pages screenshots reach the page bottom", async () => {
      const text = await call("collect_pages", { urls: [url], include: ["screenshot"], settle_ms: 0, label: `zoom-${zoom.factor}` });
      const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
      const file = (await readdir(dir)).find((name) => name.endsWith(".jpg")) ?? "";
      assertPageBottom(await decode(await readFile(path.join(dir, file))), width);
    });

    await t.test("compare_design lays the page out at the reference size and captures all of it", async () => {
      const reference = path.join(workDir, "blank-400x300.png");
      await writeFile(reference, await encodePng(createImage(400, 300, [255, 255, 255, 255])));
      const text = await call("compare_design", { tab, reference, model: "none" });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeViewport(await decodePng(await readFile(shot)), 400, 300);
    });

    await t.test("compare_design at device_scale_factor 2 captures the reference size at @2x", async () => {
      const reference = path.join(workDir, "blank-800x600.png");
      await writeFile(reference, await encodePng(createImage(800, 600, [255, 255, 255, 255])));
      const text = await call("compare_design", { tab, reference, model: "none", device_scale_factor: 2 });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeViewport(await decodePng(await readFile(shot)), 400, 300, 2);
    });

    await t.test("compare_design of an element captures exactly that element", async () => {
      const reference = path.join(workDir, "blank-200x50.png");
      await writeFile(reference, await encodePng(createImage(200, 50, [255, 255, 255, 255])));
      const text = await call("compare_design", { tab, reference, model: "none", target: "#box" });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeBox(await decodePng(await readFile(shot)));
    });

    await t.test("the zoom is unchanged after the captures", async () => {
      const after = (await call("evaluate", { tab, expression: "[innerWidth, innerHeight, devicePixelRatio].join('x')" })).split("\n").at(-1);
      assert.equal(after, metrics);
    });
  });
}
