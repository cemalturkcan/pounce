import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright-core";
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab } = useToolsHarness("emulate-capture");

type Rgb = [number, number, number];
type Spot = [number, number];

const GREEN: Rgb = [0, 200, 0];
const BLACK: Rgb = [0, 0, 0];
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const CORNERS_AND_MIDDLE: Spot[] = [
  [0.02, 0.02],
  [0.5, 0.5],
  [0.98, 0.5],
  [0.5, 0.98],
  [0.98, 0.98],
];

let decoder: Page | undefined;

beforeAll(async () => {
  decoder = (await mcp.deps.manager.openTab("decoder")).page;
});

async function shot(tab: string) {
  const result = await call("screenshot", { tab, quality: 100 });
  expect(result.isError, result.text).toBe(false);
  return result.content.find((part) => part.type === "image")?.data ?? "";
}

async function pixels(jpeg: string, spots: Spot[]) {
  if (!decoder) throw new Error("no decoder page");
  return decoder.evaluate(
    async ({ data, at }) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      return {
        width: bitmap.width,
        height: bitmap.height,
        colors: at.map(([x = 0, y = 0]) =>
          Array.from(
            context
              .getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1)
              .data.slice(0, 3),
          ),
        ),
      };
    },
    { data: jpeg, at: spots },
  );
}

const near = (color: number[], wanted: Rgb) =>
  color.every((channel, index) => Math.abs(channel - (wanted[index] ?? 0)) <= 24);

async function seen(tab: string, expected: [Spot, Rgb][]) {
  const image = await pixels(
    await shot(tab),
    expected.map(([spot]) => spot),
  );
  return {
    size: [image.width, image.height],
    matches: image.colors.every((color, index) => near(color, expected[index]?.[1] ?? BLACK)),
  };
}

const filledWith = (tab: string, color: Rgb) =>
  seen(
    tab,
    CORNERS_AND_MIDDLE.map((spot) => [spot, color]),
  );

describe("a screenshot right after emulate", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/responsive` }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("shows the page laid out for the emulated phone", async () => {
    await ok("emulate", { tab, device: "iPhone 15" });
    expect(await filledWith(tab, GREEN)).toEqual({ size: [393, 659], matches: true });
  });

  test("keeps the phone's pixel ratio on the page", async () => {
    const page = mcp.deps.manager.getTab(tab).page;
    expect(await page.evaluate(() => devicePixelRatio)).toBe(3);
  });
});

describe("a page without a mobile viewport on an emulated phone", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/desktop-only` }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("fills the phone screen with the zoomed-out page", async () => {
    await ok("emulate", { tab, device: "iPhone 15" });
    expect(
      await seen(tab, [
        [[0.1, 0.5], RED],
        [[0.7, 0.5], BLUE],
      ]),
    ).toEqual({ size: [393, 659], matches: true });
  });
});

describe("a screenshot right after a color scheme change", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/dark-scheme` }));
    await ok("emulate", { tab, color_scheme: "light" });
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("shows the phone-sized page in the emulated scheme", async () => {
    await ok("emulate", { tab, device: "iPhone 15", color_scheme: "dark" });
    expect(await filledWith(tab, BLACK)).toEqual({ size: [393, 659], matches: true });
  });
});

describe("a background tab", () => {
  let tab = "";
  let front = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/responsive` }));
    front = openedTab(await ok("navigate", { url: fixture().url }));
    await mcp.deps.manager.getTab(front).page.bringToFront();
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab, front] });
  });

  test("has painted a frame at the new size when emulate returns", async () => {
    await ok("emulate", { tab, device: "iPhone 15" });
    const page = mcp.deps.manager.getTab(tab).page;
    expect(await page.evaluate(() => document.body.dataset.paintedWidth)).toBe("393");
  });

  test("is captured laid out for the emulated phone", async () => {
    expect(await filledWith(tab, GREEN)).toEqual({ size: [393, 659], matches: true });
  });
});

describe("emulate after the page changed its address in place", () => {
  const RELOAD_FOR_PIXEL =
    'The page was loaded as this browser and keeps what it detected then; reload it (navigate with url "reload") so it loads as Pixel 8.';
  let tab = "";

  beforeEach(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/responsive` }));
    await ok("emulate", { tab, device: "Pixel 8" });
  });

  afterEach(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("still asks for a reload after a pushState", async () => {
    await ok("evaluate", { tab, expression: "history.pushState(null, '', '?step=2'); 1" });
    expect(await ok("emulate", { tab, color_scheme: "dark" })).toMatch(RELOAD_FOR_PIXEL);
  });

  test("still asks for a reload after a hash change", async () => {
    await ok("evaluate", { tab, expression: "location.hash = '#/b'; 1" });
    expect(await ok("emulate", { tab, color_scheme: "dark" })).toMatch(RELOAD_FOR_PIXEL);
  });
});

describe("emulate on a page loaded after a reset", () => {
  let tab = "";

  beforeEach(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/responsive` }));
    await ok("emulate", { tab, device: "Pixel 8" });
    await ok("navigate", { tab, url: "reload" });
    await ok("emulate", { tab, reset: true });
  });

  afterEach(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("does not ask for a reload after the tab went to another page", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/responsive?page=2` });
    expect(await ok("emulate", { tab, color_scheme: "dark" })).not.toMatch(/reload/);
  });

  test("does not ask for a reload after the page reloaded", async () => {
    await ok("navigate", { tab, url: "reload" });
    expect(await ok("emulate", { tab, color_scheme: "dark" })).not.toMatch(/reload/);
  });

  test("does not ask for a reload after a viewport change", async () => {
    await ok("navigate", { tab, url: "reload" });
    expect(await ok("emulate", { tab, viewport: { width: 600, height: 700 } })).not.toMatch(
      /reload/,
    );
  });

  test("says a new device needs a reload of the page loaded as this browser", async () => {
    await ok("navigate", { tab, url: "reload" });
    expect(await ok("emulate", { tab, device: "iPhone 15" })).toMatch(
      'The page was loaded as this browser and keeps what it detected then; reload it (navigate with url "reload") so it loads as iPhone 15.',
    );
  });
});

describe("emulate on a page that is already loaded", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/responsive` }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("says a new device takes effect for the page only after a reload", async () => {
    expect(await ok("emulate", { tab, device: "Pixel 8" })).toMatch(
      'The page was loaded as this browser and keeps what it detected then; reload it (navigate with url "reload") so it loads as Pixel 8.',
    );
  });

  test("says a new user agent takes effect for the page only after a reload", async () => {
    expect(await ok("emulate", { tab, user_agent: "FixtureAgent/2.0" })).toMatch(
      'The page was loaded as this browser and keeps what it detected then; reload it (navigate with url "reload") so it loads as user agent FixtureAgent/2.0.',
    );
  });

  test("does not ask for a reload once the page loaded with the emulated identity", async () => {
    await ok("navigate", { tab, url: "reload" });
    expect(await ok("emulate", { tab, color_scheme: "dark" })).not.toMatch(/reload/);
  });

  test("says after a reset that the page keeps the emulated identity until a reload", async () => {
    expect(await ok("emulate", { tab, reset: true })).toMatch(
      'The page was loaded as user agent FixtureAgent/2.0 and keeps what it detected then; reload it (navigate with url "reload") so it loads as this browser.',
    );
  });
});
