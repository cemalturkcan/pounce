import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../src/config/config.ts";
import { createImage } from "../src/visual/pixels.ts";
import { decodePng, encodePng } from "../src/visual/png.ts";
import type { RgbaImage } from "../src/visual/pixels.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { loadReference } from "../src/visual/capture.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import type { AskAdapter, AskInput } from "../src/ask/adapter.ts";

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

const servers: Bun.Server<undefined>[] = [];
let port = 0;
let decoderTab = "";

async function writeZoomPreferences(config: Config) {
  await mkdir(path.join(config.profileDir, "Default"), { recursive: true });
  const perHost = ZOOMS.filter((zoom) => zoom.host !== "127.0.0.1").map((zoom) => [
    zoom.host,
    { last_modified: "13300000000000000", zoom_level: zoomLevel(zoom.factor) },
  ]);
  const defaultZoom = ZOOMS.find((zoom) => zoom.host === "127.0.0.1")?.factor ?? 1;
  await writeFile(
    path.join(config.profileDir, "Default", "Preferences"),
    JSON.stringify({
      partition: {
        default_zoom_level: { x: zoomLevel(defaultZoom) },
        per_host_zoom_levels: { x: Object.fromEntries(perHost) },
      },
    }),
  );
}

const mcp = useMcpHarness({
  name: "zoom",
  secrets: noSecrets,
  askAdapter: recorder,
  prepare: writeZoomPreferences,
});
const call = mcp.ok;

const serveMarkers = (hostname: string, listenPort: number) =>
  Bun.serve({
    hostname,
    port: listenPort,
    fetch: (request) =>
      new URL(request.url).pathname.startsWith("/markers")
        ? new Response(MARKERS, { headers: { "content-type": "text/html" } })
        : new Response(null, { status: 404 }),
  });

async function openTab(url: string) {
  const tab = /Opened (t\d+)/.exec(await call("tab_open", { url }))?.[1];
  expect(tab).toMatch(/^t\d+$/);
  return tab ?? "";
}

async function decode(bytes: Buffer): Promise<RgbaImage> {
  const file = path.join(
    mcp.workDir,
    `decode-${Date.now()}-${Math.random().toString(36).slice(2)}.img`,
  );
  await writeFile(file, bytes);
  const { png } = await loadReference(mcp.deps.manager.getTab(decoderTab).page, file);
  return decodePng(png);
}

const pixel = (image: RgbaImage, x: number, y: number) => {
  const offset = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [image.data[offset] ?? 0, image.data[offset + 1] ?? 0, image.data[offset + 2] ?? 0];
};

function assertColor(image: RgbaImage, x: number, y: number, expected: number[], label: string) {
  const actual = pixel(image, x, y);
  const matches = actual.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 60);
  expect({ [label]: matches }).toStrictEqual({ [label]: true });
}

function assertWholeViewport(image: RgbaImage, width: number, height: number, scale = 1) {
  expect([image.width, image.height]).toStrictEqual([width * scale, height * scale]);
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
  expect([image.width, image.height]).toStrictEqual([200, 50]);
  for (const [x, y] of [
    [2, 2],
    [197, 2],
    [2, 47],
    [197, 47],
  ] as const)
    assertColor(image, x, y, MAGENTA, "box corner");
}

function assertPageBottom(image: RgbaImage, width: number) {
  expect([image.width, image.height]).toStrictEqual([width, PAGE_HEIGHT]);
  assertColor(image, image.width / 2, image.height - 3, CYAN, "bottom bar");
  assertColor(image, image.width / 2, image.height - 58, CYAN, "bottom bar top");
  assertColor(image, image.width / 2, image.height - 62, [255, 255, 255], "above the bottom bar");
}

const screenshotFile = (text: string) => {
  const file = /saved to (\S+?\.jpg)/.exec(text)?.[1];
  expect(file).toMatch(/\.jpg$/);
  return file ?? "";
};

beforeAll(async () => {
  const first = serveMarkers("127.0.0.1", 0);
  port = Number(first.url.port);
  servers.push(first, serveMarkers("127.0.0.2", port));
  decoderTab = await openTab("about:blank");
});

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
});

for (const zoom of ZOOMS) {
  describe(`captures under ${zoom.name}`, () => {
    let url: string;
    let tab: string;
    let metrics: string;
    let width: number;
    let height: number;
    let ratio: number;

    beforeAll(async () => {
      url = `http://${zoom.host}:${port}/markers`;
      tab = await openTab(url);
      metrics =
        (
          await call("evaluate", {
            tab,
            expression: "[innerWidth, innerHeight, devicePixelRatio].join('x')",
          })
        )
          .split("\n")
          .at(-1) ?? "";
      [width = 0, height = 0, ratio = 0] = metrics.split("x").map(Number);
    });

    test("the browser applies the zoom", () => {
      expect(Math.abs(ratio - zoom.factor)).toBeLessThan(0.01);
    });

    test("screenshot of the viewport shows the whole viewport", async () => {
      assertWholeViewport(
        await decode(
          await readFile(screenshotFile(await call("screenshot", { tab, save_only: true }))),
        ),
        width,
        height,
      );
    });

    test("screenshot of an element shows exactly that element", async () => {
      assertWholeBox(
        await decode(
          await readFile(
            screenshotFile(await call("screenshot", { tab, target: "#box", save_only: true })),
          ),
        ),
      );
    });

    test("screenshot of the full page reaches the page bottom", async () => {
      assertPageBottom(
        await decode(
          await readFile(
            screenshotFile(await call("screenshot", { tab, full_page: true, save_only: true })),
          ),
        ),
        width,
      );
    });

    test("ask_pages viewport and region images show the whole viewport and the element", async () => {
      await call("ask_pages", {
        question: "What is on the page?",
        tabs: [tab],
        images: "viewport",
        regions: [{ target: "#box" }],
      });
      const images = calls.at(-1)?.images ?? [];
      expect(images.length).toBe(2);
      assertWholeViewport(
        await decode(Buffer.from(images[0]?.data ?? "", "base64")),
        width,
        height,
      );
      assertWholeBox(await decode(Buffer.from(images[1]?.data ?? "", "base64")));
    });

    test("ask_pages full tiles cover the page down to its bottom", async () => {
      await call("ask_pages", { question: "What is on the page?", tabs: [tab], images: "full" });
      const images = calls.at(-1)?.images ?? [];
      expect(images.length).toBe(1 + Math.ceil((PAGE_HEIGHT - height) / (height - 80)));
      const first = await decode(Buffer.from(images[0]?.data ?? "", "base64"));
      expect([first.width, first.height]).toStrictEqual([width, height]);
      assertColor(first, 150, 145, MAGENTA, "box in the first tile");
      const last = await decode(Buffer.from(images.at(-1)?.data ?? "", "base64"));
      expect(last.width).toBe(width);
      assertColor(last, width / 2, last.height - 3, CYAN, "bottom bar in the last tile");
      assertColor(
        last,
        width / 2,
        last.height - 62,
        [255, 255, 255],
        "above the bottom bar in the last tile",
      );
    });

    test("collect_pages screenshots reach the page bottom", async () => {
      const text = await call("collect_pages", {
        urls: [url],
        include: ["screenshot"],
        settle_ms: 0,
        label: `zoom-${zoom.factor}`,
      });
      const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
      const file = (await readdir(dir)).find((name) => name.endsWith(".jpg")) ?? "";
      assertPageBottom(await decode(await readFile(path.join(dir, file))), width);
    });

    test("compare_design lays the page out at the reference size and captures all of it", async () => {
      const reference = path.join(mcp.workDir, "blank-400x300.png");
      await writeFile(reference, await encodePng(createImage(400, 300, [255, 255, 255, 255])));
      const text = await call("compare_design", { tab, reference, model: "none" });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeViewport(await decodePng(await readFile(shot)), 400, 300);
    });

    test("compare_design at device_scale_factor 2 captures the reference size at @2x", async () => {
      const reference = path.join(mcp.workDir, "blank-800x600.png");
      await writeFile(reference, await encodePng(createImage(800, 600, [255, 255, 255, 255])));
      const text = await call("compare_design", {
        tab,
        reference,
        model: "none",
        device_scale_factor: 2,
      });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeViewport(await decodePng(await readFile(shot)), 400, 300, 2);
    });

    test("compare_design of an element captures exactly that element", async () => {
      const reference = path.join(mcp.workDir, "blank-200x50.png");
      await writeFile(reference, await encodePng(createImage(200, 50, [255, 255, 255, 255])));
      const text = await call("compare_design", { tab, reference, model: "none", target: "#box" });
      const shot = /^Screenshot: (.+)$/m.exec(text)?.[1] ?? "";
      assertWholeBox(await decodePng(await readFile(shot)));
    });

    test("the zoom is unchanged after the captures", async () => {
      const after = (
        await call("evaluate", {
          tab,
          expression: "[innerWidth, innerHeight, devicePixelRatio].join('x')",
        })
      )
        .split("\n")
        .at(-1);
      expect(after).toBe(metrics);
    });
  });
}
