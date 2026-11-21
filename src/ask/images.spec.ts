import { expect, test } from "bun:test";
import { looksVisual } from "./images.ts";

const viewport = { width: 1280, height: 800 };

test("looksVisual fires for empty text, media-dominated viewports and sparse text, not for text pages", () => {
  expect(looksVisual({ textChars: 0, viewport, pageHeight: 800, mediaArea: 0 })).toBe(true);
  expect(
    looksVisual({ textChars: 4000, viewport, pageHeight: 800, mediaArea: 0.5 * 1280 * 800 }),
  ).toBe(true);
  expect(looksVisual({ textChars: 120, viewport, pageHeight: 3000, mediaArea: 0 })).toBe(true);
  expect(
    looksVisual({ textChars: 20_000, viewport, pageHeight: 5000, mediaArea: 0.1 * 1280 * 800 }),
  ).toBe(false);
  expect(looksVisual({ textChars: 2500, viewport, pageHeight: 800, mediaArea: 0 })).toBe(false);
});
