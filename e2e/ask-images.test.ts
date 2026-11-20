import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AskAdapter, AskInput } from "../src/ask.ts";
import { loadConfig } from "../src/config.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { REVEAL_COLORS, startFixture, type Fixture } from "./fixture.ts";

const PAGES: Record<string, string> = {
  "/text": `<!doctype html><title>Text</title><main>${Array.from({ length: 60 }, (_value, index) => `<p>Paragraph ${index} explains the lamp in plain words, with enough text to read.</p>`).join("")}</main>`,
  "/canvas": `<!doctype html><title>Chart</title><body style="margin:0"><h1 style="margin:0;font-size:14px">Sales</h1><canvas id="chart" width="700" height="400" style="display:block"></canvas>
<script>const c = document.getElementById("chart").getContext("2d"); c.fillStyle = "#2563eb"; c.fillRect(40, 100, 120, 300); c.fillStyle = "#f59e0b"; c.fillRect(200, 40, 120, 360);</script></body>`,
  "/tall": `<!doctype html><title>Tall</title><body style="margin:0"><div style="height:5000px;background:linear-gradient(#fff,#ddd)"><p style="margin:0">Top of a tall page</p></div></body>`,
};

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };
const calls: AskInput[] = [];
const recorder: AskAdapter = {
  name: "image recorder",
  complete: async (input) => {
    calls.push(input);
    return { text: "NOT FOUND", usage: { input_tokens: 10, output_tokens: 2 } };
  },
};

let server: http.Server;
let fixture: Fixture;
let base = "";
let workDir = "";
let deps: ToolDeps;
let client: Client;

async function ok(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  assert.equal(result.isError === true, false, `${name} failed: ${text}`);
  assert.ok((result.content as { type: string }[]).every((part) => part.type === "text"), "no inline images in the result");
  return text;
}

type TileStats = { dark: number; dominant: number; matches: Record<string, number> };

async function tileStats(images: { data: string }[]) {
  const opened = await ok("tab_open", {});
  const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
  const page = deps.manager.getTab(tab).page;
  const stats = await page.evaluate(
    async ({ tiles, colors }) =>
      Promise.all(
        tiles.map(async (data) => {
          const image = new Image();
          image.src = `data:image/jpeg;base64,${data}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext("2d") as CanvasRenderingContext2D;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const total = pixels.length / 4;
          const buckets = new Map<number, number>();
          const matches: Record<string, number> = Object.fromEntries(Object.keys(colors).map((name) => [name, 0]));
          let dark = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const [red = 0, green = 0, blue = 0] = [pixels[index], pixels[index + 1], pixels[index + 2]];
            if (red + green + blue < 60) dark += 1;
            const bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
            buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
            for (const [name, [r = 0, g = 0, b = 0]] of Object.entries(colors)) if (Math.abs(red - r) < 40 && Math.abs(green - g) < 40 && Math.abs(blue - b) < 40) matches[name] = (matches[name] ?? 0) + 1;
          }
          return { dark: dark / total, dominant: Math.max(...buckets.values()) / total, matches };
        }),
      ),
    { tiles: images.map((image) => image.data), colors: REVEAL_COLORS as unknown as Record<string, number[]> },
  );
  await ok("tab_close", { tab });
  return stats as TileStats[];
}

const lastCall = () => {
  const call = calls.at(-1);
  assert.ok(call, "the adapter was not called");
  return call;
};

before(async () => {
  server = http.createServer((request, response) => {
    const page = PAGES[(request.url ?? "/").split("?")[0] ?? "/"];
    if (page) response.writeHead(200, { "content-type": "text/html" }).end(page);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-ask-images-"));
  const config = loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir, WEB_AGENT_HEADLESS: "true", WEB_AGENT_PASSWORD_STORE: "basic", WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE });
  deps = createDeps(config, noSecrets, recorder);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e-ask-images", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await fixture?.close();
  await new Promise<void>((resolve) => {
    server?.closeAllConnections();
    server?.close(() => resolve());
  });
  await rm(workDir, { recursive: true, force: true });
});

test("ask_pages images", async (t) => {
  await t.test("auto sends a screenshot only for the visual page, after that page's text", async () => {
    const text = await ok("ask_pages", { question: "What does the chart show?", urls: [`${base}/text`, `${base}/canvas`] });
    const call = lastCall();
    assert.equal(call.images?.length, 1);
    assert.match(call.images?.[0]?.label ?? "", /^02-127-0-0-1-\d+-canvas\.md viewport$/);
    assert.equal(call.images?.[0]?.mediaType, "image/jpeg");
    const textDoc = call.prompt.indexOf('<document source="01-');
    const chartDoc = call.prompt.indexOf('<document source="02-');
    const screenshots = call.prompt.indexOf('<screenshots source="02-');
    assert.ok(textDoc !== -1 && textDoc < chartDoc && chartDoc < screenshots, call.prompt.slice(0, 300));
    assert.match(call.prompt, /<screenshots source="02-[^"]+">Image 1 of this message: 02-[^ ]+ viewport<\/screenshots>/);
    assert.ok(!call.prompt.includes('<screenshots source="01-'));
    assert.match(text, /Screenshots \(1 sent, files in .+\):\n02-127-0-0-1-\d+-canvas\.md: viewport/);
    assert.ok(!/\/9j\/|iVBORw0KGgo|[A-Za-z0-9+/]{200,}/.test(text), "image data leaked into the result");
  });

  await t.test("none sends text only", async () => {
    await ok("ask_pages", { question: "What does the chart show?", urls: [`${base}/canvas`], images: "none" });
    assert.equal(lastCall().images, undefined);
  });

  await t.test("full sends a tall page as overlapping screen-sized tiles and reports the count", async () => {
    const text = await ok("ask_pages", { question: "What is at the top?", urls: [`${base}/tall`], images: "full" });
    const call = lastCall();
    const { imageSize } = await import("../src/model-images.ts");
    const heights = (call.images ?? []).map((image) => imageSize(Buffer.from(image.data, "base64"))?.height ?? 0);
    const screen = heights[0] ?? 0;
    const count = 1 + Math.ceil((5000 - screen) / (screen - 80));
    assert.ok(screen > 100 && heights.every((height) => height === screen), JSON.stringify(heights));
    assert.deepEqual(call.images?.map((image) => image.label?.replace(/^.*\.md /, "")), Array.from({ length: count }, (_value, index) => `tile ${index + 1}/${count}`));
    assert.match(text, new RegExp(`tall\\.md: ${count} tile\\(s\\)`));
  });

  await t.test("tabs send viewport and region screenshots labelled with the tab source; files are saved", async () => {
    const opened = await ok("tab_open", { url: `${base}/canvas` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    const text = await ok("ask_pages", { question: "What does the chart show?", tabs: [tab], images: "viewport", regions: [{ target: "#chart" }, { target: "#missing-element" }] });
    const call = lastCall();
    assert.deepEqual(call.images?.map((image) => image.label), [`${tab} ${base}/canvas viewport`, `${tab} ${base}/canvas region #chart`]);
    assert.match(call.prompt, /<screenshots source="t\d+ [^"]+">Images 1-2 of this message: /);
    assert.match(text, new RegExp(`${tab} ${base}/canvas: viewport, 1 region\\(s\\)`));
    assert.match(text, /region #missing-element was not captured/);
    const dir = /files in (.+)\):/.exec(text)?.[1] ?? "";
    assert.ok((await stat(path.join(dir, `${tab}.region-1.jpg`))).size > 0);
  });

  await t.test("a wide page goes as full-width JPEG tiles, not downscaled, with the sent size in the footer", async () => {
    const opened = await ok("tab_open", { url: `${base}/tall` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    await ok("tab_resize", { tab, width: 2000, height: 900 });
    const text = await ok("ask_pages", { question: "What is at the top?", tabs: [tab], images: "full" });
    const { imageSize } = await import("../src/model-images.ts");
    const sizes = lastCall().images?.map((image) => [image.mediaType, imageSize(Buffer.from(image.data, "base64"))?.width]);
    assert.ok((sizes?.length ?? 0) > 1 && sizes?.every(([type, width]) => type === "image/jpeg" && width === 2000), JSON.stringify(sizes));
    assert.match(text, new RegExp(`^${sizes?.length} image\\(s\\) sent to the model, \\d+\\.\\d\\d MB as base64\\.$`, "m"));
    assert.ok(!/downscaled/.test(text));
  });

  await t.test("review mode sends whole-page tiles by default with the review prompt", async () => {
    const { REVIEW_SYSTEM } = await import("../src/ask.ts");
    const text = await ok("ask_pages", { question: "Check for broken layouts", urls: [`${base}/tall`, `${base}/text`], mode: "review" });
    const call = lastCall();
    assert.equal(call.system, REVIEW_SYSTEM);
    const tall = (call.images ?? []).map((image) => /tall\.md tile \d+\/(\d+)$/.exec(image.label ?? "")?.[1]).filter((total) => total !== undefined);
    assert.ok(tall.length > 1 && tall.every((total) => Number(total) === tall.length), JSON.stringify(call.images?.map((image) => image.label)));
    assert.ok((call.images ?? []).some((image) => /text\.md tile 1\/\d$/.test(image.label ?? "")));
    assert.match(call.prompt, /<request>\nCheck for broken layouts\n<\/request>/);
    assert.match(text, /^Review: Check for broken layouts$/m);
  });

  await t.test("full tiles show lazy images, scroll reveals and finished counters, and no tile is blank", async () => {
    const opened = await ok("tab_open", { url: `${fixture.url}/reveal` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    const page = deps.manager.getTab(tab).page;
    await page.evaluate(() => window.scrollTo(0, 400));
    await ok("ask_pages", { question: "Check the page", tabs: [tab], mode: "review" });
    const images = lastCall().images ?? [];
    assert.ok(images.length >= 3, `only ${images.length} tile(s)`);
    const stats = await tileStats(images);
    for (const [index, tile] of stats.entries()) {
      assert.ok(tile.dark < 0.5, `tile ${index + 1} is mostly black: ${JSON.stringify(tile)}`);
      assert.ok(tile.dominant < 0.97, `tile ${index + 1} is blank: ${JSON.stringify(tile)}`);
    }
    const best = (name: string) => Math.max(...stats.map((tile) => tile.matches[name] ?? 0));
    assert.ok(best("reveal") > 600 * 250, `the reveal block was not shown: ${best("reveal")}`);
    assert.ok(best("image") > 500 * 250, `the lazy image was not painted: ${best("image")}`);
    assert.ok(best("bar") > 560 * 35, `the counter bar did not finish: ${best("bar")}`);
    assert.ok(best("footer") > 0, "the footer is missing");
    assert.equal(await page.evaluate(() => window.scrollY), 400);
  });

  await t.test("review mode keeps an explicit images choice", async () => {
    await ok("ask_pages", { question: "Check for broken layouts", urls: [`${base}/canvas`], mode: "review", images: "none" });
    assert.equal(lastCall().images, undefined);
  });

  await t.test("files ignore image options and say so", async () => {
    const file = path.join(workDir, "plain.md");
    await writeFile(file, "Plain text page");
    const text = await ok("ask_pages", { question: "What is here?", files: [file], images: "full" });
    assert.equal(lastCall().images, undefined);
    assert.match(text, /images and regions apply to tabs and urls only/);
  });
});
