import assert from "node:assert/strict";
import { test } from "node:test";
import { looksVisual } from "./ask-images.ts";

const viewport = { width: 1280, height: 800 };

test("looksVisual fires for empty text, media-dominated viewports and sparse text, not for text pages", () => {
  assert.equal(looksVisual({ textChars: 0, viewport, pageHeight: 800, mediaArea: 0 }), true);
  assert.equal(looksVisual({ textChars: 4000, viewport, pageHeight: 800, mediaArea: 0.5 * 1280 * 800 }), true);
  assert.equal(looksVisual({ textChars: 120, viewport, pageHeight: 3000, mediaArea: 0 }), true);
  assert.equal(looksVisual({ textChars: 20_000, viewport, pageHeight: 5000, mediaArea: 0.1 * 1280 * 800 }), false);
  assert.equal(looksVisual({ textChars: 2500, viewport, pageHeight: 800, mediaArea: 0 }), false);
});
