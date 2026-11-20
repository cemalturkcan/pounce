import assert from "node:assert/strict";
import { test } from "node:test";
import { renderReport, type CompareReport } from "./visual.ts";

const region = { id: "R1", x: 0, y: 0, width: 100, height: 40, area: 4000, diffPixels: 2000, mismatch: 0.5 };

function report(overrides: Partial<Omit<CompareReport, "text">>): Omit<CompareReport, "text"> {
  return {
    url: "https://example.test/",
    reference: "/tmp/design.png",
    referenceSize: { width: 100, height: 40 },
    pageSize: { width: 100, height: 40 },
    compared: { width: 100, height: 40 },
    viewport: { width: 100, height: 40, deviceScaleFactor: 1 },
    scaledPage: false,
    notes: [],
    tolerance: 0.1,
    minRegionArea: 64,
    diffPixels: 2000,
    diffRatio: 0.5,
    regions: [],
    files: { dir: "/tmp/compare", screenshot: "/tmp/compare/page.png", diff: "/tmp/compare/diff.png", report: "/tmp/compare/report.json" },
    ...overrides,
  };
}

test("a region whose model answer was cut off says its findings may be incomplete", () => {
  const text = renderReport(report({ regions: [{ ...region, findings: [{ severity: "high", property: "color", text: "button: design blue" }], truncated: true }] }));
  assert.match(text, /^R1 .*cut off.*\[high\] \[color\] button: design blue$/m);
});

test("a cut-off whole-image check says its list may be incomplete", () => {
  const text = renderReport(report({ model: { id: "claude-haiku-5-5", adapter: "test", calls: 1, images: "", overviewTruncated: true } }));
  assert.match(text, /whole-image check was cut off/);
});
