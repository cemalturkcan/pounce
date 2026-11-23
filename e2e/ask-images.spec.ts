import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SecretStore } from "../src/shared/secrets.ts";
import { startFixture, type Fixture } from "./fixture.ts";
import { REVEAL_COLORS } from "./fixture-content.ts";
import type { AskAdapter, AskInput } from "../src/ask/adapter.ts";
import { type ToolArgs, useMcpHarness } from "../tests/mcpHarness.ts";

const PAGES = new Map([
  [
    "/text",
    `<!doctype html><title>Text</title><main>${Array.from({ length: 60 }, (_value, index) => `<p>Paragraph ${index} explains the lamp in plain words, with enough text to read.</p>`).join("")}</main>`,
  ],
  [
    "/canvas",
    `<!doctype html><title>Chart</title><body style="margin:0"><h1 style="margin:0;font-size:14px">Sales</h1><canvas id="chart" width="700" height="400" style="display:block"></canvas>
<script>const c = document.getElementById("chart").getContext("2d"); c.fillStyle = "#2563eb"; c.fillRect(40, 100, 120, 300); c.fillStyle = "#f59e0b"; c.fillRect(200, 40, 120, 360);</script></body>`,
  ],
  [
    "/tall",
    `<!doctype html><title>Tall</title><body style="margin:0"><div style="height:5000px;background:linear-gradient(#fff,#ddd)"><p style="margin:0">Top of a tall page</p></div></body>`,
  ],
]);

const noSecrets: SecretStore = { backend: "fake", list: async () => [], get: async () => "" };
const calls: AskInput[] = [];
const recorder: AskAdapter = {
  name: "image recorder",
  complete: async (input) => {
    calls.push(input);
    return { text: "NOT FOUND", usage: { input_tokens: 10, output_tokens: 2 } };
  },
};

let server: Bun.Server<undefined>;
let fixture: Fixture;
let base = "";
const mcp = useMcpHarness({ name: "ask-images", secrets: noSecrets, askAdapter: recorder });

async function answersFile(text: string) {
  const file = /^Full answers: (\S+)$/m.exec(text)?.[1] ?? "";
  expect(file, text).toMatch(/\S/);
  return readFile(file, "utf8");
}

async function ok(name: string, args: ToolArgs) {
  const result = await mcp.call(name, args);
  expect(result.isError, `${name} failed: ${result.text}`).toBe(false);
  expect(
    result.content.filter((part) => part.type !== "text"),
    "no inline images in the result",
  ).toStrictEqual([]);
  return result.text;
}

const tileStatsList = z.array(
  z.object({ dark: z.number(), dominant: z.number(), matches: z.record(z.string(), z.number()) }),
);

async function tileStats(images: { data: string }[]) {
  const opened = await ok("navigate", { url: "about:blank" });
  const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
  const page = mcp.deps.manager.getTab(tab).page;
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
          const context = canvas.getContext("2d");
          if (!context) throw new Error("no 2d canvas context");
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const total = pixels.length / 4;
          const buckets = new Map<number, number>();
          const matches: Record<string, number> = Object.fromEntries(
            Object.keys(colors).map((name) => [name, 0]),
          );
          let dark = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const [red = 0, green = 0, blue = 0] = [
              pixels[index],
              pixels[index + 1],
              pixels[index + 2],
            ];
            if (red + green + blue < 60) dark += 1;
            const bucket = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4);
            buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
            for (const [name, [r = 0, g = 0, b = 0]] of Object.entries(colors))
              if (Math.abs(red - r) < 40 && Math.abs(green - g) < 40 && Math.abs(blue - b) < 40)
                matches[name] = (matches[name] ?? 0) + 1;
          }
          return { dark: dark / total, dominant: Math.max(...buckets.values()) / total, matches };
        }),
      ),
    {
      tiles: images.map((image) => image.data),
      colors: REVEAL_COLORS,
    },
  );
  await ok("tabs", { close: [tab] });
  return tileStatsList.parse(stats);
}

const lastCall = () => {
  const call = calls.at(-1);
  expect(call, "the adapter was not called").toBeDefined();
  if (!call) throw new Error("the adapter was not called");
  return call;
};

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const page = PAGES.get(new URL(request.url).pathname);
      return page
        ? new Response(page, { headers: { "content-type": "text/html" } })
        : new Response(null, { status: 404 });
    },
  });
  base = server.url.origin;
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
  await server?.stop(true);
});

describe("ask_pages images", () => {
  test("auto sends a screenshot only for the visual page, after that page's text", async () => {
    const text = await ok("ask_pages", {
      question: "What does the chart show?",
      urls: [`${base}/text`, `${base}/canvas`],
    });
    const call = lastCall();
    expect(call.images?.length).toBe(1);
    expect(call.images?.[0]?.label ?? "").toMatch(/^02-127-0-0-1-\d+-canvas\.md viewport$/);
    expect(call.images?.[0]?.mediaType).toBe("image/jpeg");
    const textDoc = call.prompt.indexOf('<document source="01-');
    const chartDoc = call.prompt.indexOf('<document source="02-');
    const screenshots = call.prompt.indexOf('<screenshots source="02-');
    expect(textDoc).not.toBe(-1);
    expect(textDoc).toBeLessThan(chartDoc);
    expect(chartDoc).toBeLessThan(screenshots);
    expect(call.prompt).toMatch(
      /<screenshots source="02-[^"]+">Image 1 of this message: 02-[^ ]+ viewport<\/screenshots>/,
    );
    expect(call.prompt).not.toContain('<screenshots source="01-');
    const answers = await answersFile(text);
    expect(answers).toMatch(
      /Screenshots \(1 sent, files in .+\):\n02-127-0-0-1-\d+-canvas\.md: viewport/,
    );
    expect(text).not.toMatch(/\/9j\/|iVBORw0KGgo|[A-Za-z0-9+/]{200,}/);
  });

  test("none sends text only", async () => {
    await ok("ask_pages", {
      question: "What does the chart show?",
      urls: [`${base}/canvas`],
      images: "none",
    });
    expect(lastCall().images).toBe(undefined);
  });

  test("full sends a tall page as overlapping screen-sized tiles and reports the count", async () => {
    const text = await ok("ask_pages", {
      question: "What is at the top?",
      urls: [`${base}/tall`],
      images: "full",
    });
    const call = lastCall();
    const { imageSize } = await import("../src/ask/model-images.ts");
    const heights = (call.images ?? []).map(
      (image) => imageSize(Buffer.from(image.data, "base64"))?.height ?? 0,
    );
    const screen = heights[0] ?? 0;
    const count = 1 + Math.ceil((5000 - screen) / (screen - 80));
    expect(screen).toBeGreaterThan(100);
    expect(heights.filter((height) => height !== screen)).toStrictEqual([]);
    expect(call.images?.map((image) => image.label?.replace(/^.*\.md /, ""))).toStrictEqual(
      Array.from({ length: count }, (_value, index) => `tile ${index + 1}/${count}`),
    );
    expect(await answersFile(text)).toMatch(new RegExp(`tall\\.md: ${count} tile\\(s\\)`));
  });

  test("tabs send viewport and region screenshots labelled with the tab source; files are saved", async () => {
    const opened = await ok("navigate", { url: `${base}/canvas` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    const text = await ok("ask_pages", {
      question: "What does the chart show?",
      tabs: [tab],
      images: "viewport",
      regions: [{ target: "#chart" }, { target: "#missing-element" }],
    });
    const call = lastCall();
    expect(call.images?.map((image) => image.label)).toStrictEqual([
      `${tab} ${base}/canvas viewport`,
      `${tab} ${base}/canvas region #chart`,
    ]);
    expect(call.prompt).toMatch(/<screenshots source="t\d+ [^"]+">Images 1-2 of this message: /);
    const answers = await answersFile(text);
    expect(answers).toMatch(new RegExp(`${tab} ${base}/canvas: viewport, 1 region\\(s\\)`));
    expect(text).toMatch(/^[^\n]*region #missing-element was not captured/m);
    expect(answers).toMatch(/region #missing-element was not captured/);
    const dir = /files in (.+)\):/.exec(answers)?.[1] ?? "";
    expect((await stat(path.join(dir, `${tab}.region-1.jpg`))).size).toBeGreaterThan(0);
  });

  test("a wide page goes as full-width JPEG tiles, not downscaled, with the sent size in the footer", async () => {
    const opened = await ok("navigate", { url: `${base}/tall` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    await ok("emulate", { tab, viewport: { width: 2000, height: 900 } });
    const text = await ok("ask_pages", {
      question: "What is at the top?",
      tabs: [tab],
      images: "full",
    });
    const { imageSize } = await import("../src/ask/model-images.ts");
    const sizes = lastCall().images?.map((image) => [
      image.mediaType,
      imageSize(Buffer.from(image.data, "base64"))?.width,
    ]);
    expect(sizes?.length ?? 0).toBeGreaterThan(1);
    expect(sizes?.filter(([type, width]) => type !== "image/jpeg" || width !== 2000)).toStrictEqual(
      [],
    );
    expect(await answersFile(text)).toMatch(
      new RegExp(
        `^${sizes?.length} image\\(s\\) sent to the model, \\d+\\.\\d\\d MB as base64\\.$`,
        "m",
      ),
    );
    expect(await answersFile(text)).not.toMatch(/downscaled/);
  });

  test("review mode sends whole-page tiles by default with the review prompt", async () => {
    const { REVIEW_SYSTEM } = await import("../src/ask/prompt.ts");
    const text = await ok("ask_pages", {
      question: "Check for broken layouts",
      urls: [`${base}/tall`, `${base}/text`],
      mode: "review",
    });
    const call = lastCall();
    expect(call.system).toBe(REVIEW_SYSTEM);
    const tall = (call.images ?? [])
      .map((image) => /tall\.md tile \d+\/(\d+)$/.exec(image.label ?? "")?.[1])
      .filter((total) => total !== undefined);
    expect(tall.length).toBeGreaterThan(1);
    expect(tall.filter((total) => Number(total) !== tall.length)).toStrictEqual([]);
    expect((call.images ?? []).map((image) => image.label)).toContainEqual(
      expect.stringMatching(/text\.md tile 1\/\d$/),
    );
    expect(call.prompt).toMatch(/<request>\nCheck for broken layouts\n<\/request>/);
    expect(text).toMatch(/^Review: Check for broken layouts$/m);
  });

  test("full tiles show lazy images, scroll reveals and finished counters, and no tile is blank", async () => {
    const opened = await ok("navigate", { url: `${fixture.url}/reveal` });
    const tab = /Opened (t\d+)/.exec(opened)?.[1] ?? "";
    const page = mcp.deps.manager.getTab(tab).page;
    await page.evaluate(() => window.scrollTo(0, 400));
    await ok("ask_pages", { question: "Check the page", tabs: [tab], mode: "review" });
    const images = lastCall().images ?? [];
    expect(images.length, `only ${images.length} tile(s)`).toBeGreaterThanOrEqual(3);
    const stats = await tileStats(images);
    for (const [index, tile] of stats.entries()) {
      expect(tile.dark, `tile ${index + 1} is mostly black: ${JSON.stringify(tile)}`).toBeLessThan(
        0.5,
      );
      expect(tile.dominant, `tile ${index + 1} is blank: ${JSON.stringify(tile)}`).toBeLessThan(
        0.97,
      );
    }
    const best = (name: string) => Math.max(...stats.map((tile) => tile.matches[name] ?? 0));
    expect(best("reveal") > 600 * 250, `the reveal block was not shown: ${best("reveal")}`).toBe(
      true,
    );
    expect(best("image") > 500 * 250, `the lazy image was not painted: ${best("image")}`).toBe(
      true,
    );
    expect(best("bar") > 560 * 35, `the counter bar did not finish: ${best("bar")}`).toBe(true);
    expect(best("footer")).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(400);
  });

  test("review mode keeps an explicit images choice", async () => {
    await ok("ask_pages", {
      question: "Check for broken layouts",
      urls: [`${base}/canvas`],
      mode: "review",
      images: "none",
    });
    expect(lastCall().images).toBe(undefined);
  });

  test("files ignore image options and say so", async () => {
    const file = path.join(mcp.workDir, "plain.md");
    await writeFile(file, "Plain text page");
    const text = await ok("ask_pages", {
      question: "What is here?",
      files: [file],
      images: "full",
    });
    expect(lastCall().images).toBe(undefined);
    expect(text).toMatch(/^images and regions apply to tabs and urls only/m);
    expect(await answersFile(text)).toMatch(/^images and regions apply to tabs and urls only/m);
  });
});
