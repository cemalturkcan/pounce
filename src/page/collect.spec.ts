import { expect, test } from "bun:test";
import {
  collectIndexFrame,
  collectedIndex,
  collectSummary,
  normalizeUrl,
  pageStatus,
  renderCollectIndex,
  siteKey,
} from "./collect.ts";

test("a malformed index.json entry is skipped and the others are kept", () => {
  const index = JSON.stringify([
    { index: 1, url: "https://example.test/", files: ["01-example-test.md"] },
    { index: "two", url: "https://example.test/pricing", files: [] },
    {
      index: 3,
      url: "https://example.test/docs",
      finalUrl: "https://example.test/docs/",
      files: ["03-example-test-docs.md"],
    },
  ]);

  expect(collectedIndex(index)).toStrictEqual([
    { index: 1, url: "https://example.test/" },
    { index: 3, url: "https://example.test/docs", finalUrl: "https://example.test/docs/" },
  ]);
});

test("normalizeUrl adds a scheme only when missing", () => {
  expect(normalizeUrl("example.com/x")).toBe("https://example.com/x");
  expect(normalizeUrl(" http://localhost:3000 ")).toBe("http://localhost:3000");
  expect(normalizeUrl("about:blank")).toBe("about:blank");
  expect(normalizeUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
});

test("normalizeUrl treats host:port as a URL, http for local hosts", () => {
  expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000");
  expect(normalizeUrl("localhost:3000/a?b=1")).toBe("http://localhost:3000/a?b=1");
  expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  expect(normalizeUrl("[::1]:3000")).toBe("http://[::1]:3000");
  expect(normalizeUrl("app.localhost:5173")).toBe("http://app.localhost:5173");
  expect(normalizeUrl("192.168.1.10:9000")).toBe("http://192.168.1.10:9000");
  expect(normalizeUrl("10.0.0.2")).toBe("http://10.0.0.2");
  expect(normalizeUrl("example.com:8443/api")).toBe("https://example.com:8443/api");
  expect(normalizeUrl("172.32.0.1:80")).toBe("https://172.32.0.1:80");
});

test("collectSummary carries each page's HTTP status and title", () => {
  const summary = collectSummary("/tmp/c", [
    { index: 1, url: "https://example.test/", status: 404, title: "Missing", files: ["01.txt"] },
  ]);
  expect(summary.pages).toMatchObject([{ status: 404, title: "Missing" }]);
});

test("collectSummary carries each page's text length", () => {
  const summary = collectSummary("/tmp/c", [
    { index: 1, url: "https://example.test/", status: 200, chars: 1045, files: ["01.txt"] },
  ]);
  expect(summary.pages).toMatchObject([{ chars: 1045 }]);
});

const unknownStatus = {
  index: 1,
  url: "https://example.test/",
  statusNote: "the browser reported no HTTP status for this page",
  files: ["01.txt"],
};

test("collectSummary says why a page's status is unknown", () => {
  expect(collectSummary("/tmp/c", [unknownStatus]).pages).toMatchObject([
    { statusNote: "the browser reported no HTTP status for this page" },
  ]);
});

test("the index says why a page's status is unknown", () => {
  expect(renderCollectIndex("/tmp/c", [unknownStatus])).toContain(
    "   status unknown: the browser reported no HTTP status for this page",
  );
});

test("a page's status is the status of its document's response", () => {
  expect(pageStatus("https://a.test/", 404, 200)).toStrictEqual({ status: 404 });
});

test("without a response the status comes from the page's navigation timing", () => {
  expect(pageStatus("https://a.test/", undefined, 200)).toStrictEqual({ status: 200 });
});

test("a page not loaded over HTTP has no status and says so, whatever its timing reports", () => {
  expect(pageStatus("data:text/html,x", undefined, 200)).toStrictEqual({
    statusNote: "not loaded over HTTP",
  });
});

test("an HTTP page without a response or timing status says the browser reported none", () => {
  expect(pageStatus("https://a.test/", undefined, 0)).toStrictEqual({
    statusNote:
      "the browser reported no HTTP status for this page, as when it comes from a cache or the page made it itself",
  });
});

test("a host with and without www is one site when pages are paced", () => {
  expect(siteKey("https://www.example.com/a")).toBe(siteKey("https://example.com/b"));
});

test("subdomains of one registrable domain are one site when pages are paced", () => {
  expect(siteKey("https://shop.example.co.uk/a")).toBe(siteKey("https://blog.example.co.uk/b"));
});

test("local servers on different ports are different sites when pages are paced", () => {
  expect(siteKey("http://localhost:3000/")).not.toBe(siteKey("http://localhost:4000/"));
});

test("collectSummary carries every fact the index prints for a page", () => {
  const page = {
    index: 1,
    url: "https://example.test/report.pdf",
    finalUrl: "https://example.test/report.pdf",
    status: 200,
    title: "Report",
    type: "application/pdf",
    bytes: 2048,
    note: "saved as it was served",
    scrolled: { steps: 3, height: 4200, capped: true },
    unsettledMs: 5000,
    chars: 900,
    files: ["01-report.pdf"],
    preview: "Quarterly report",
    data: "structured data: Product",
  };
  expect(collectSummary("/tmp/c", [page]).pages).toStrictEqual([
    {
      index: 1,
      url: "https://example.test/report.pdf",
      finalUrl: "https://example.test/report.pdf",
      status: 200,
      statusNote: undefined,
      title: "Report",
      type: "application/pdf",
      bytes: 2048,
      note: "saved as it was served",
      scrolled: { steps: 3, height: 4200, capped: true },
      unsettledMs: 5000,
      chars: 900,
      files: ["01-report.pdf"],
      preview: "Quarterly report",
      data: "structured data: Product",
      error: undefined,
      reason: undefined,
    },
  ]);
});

const mixedPages = [
  { index: 1, url: "https://example.test/", status: 200, title: "Home", files: ["01.txt"] },
  { index: 2, url: "https://example.test/gone", status: 404, title: "Missing", files: ["02.txt"] },
  {
    index: 3,
    url: "https://example.test/broken",
    status: 500,
    files: [],
    error: "http error: HTTP 500 with an empty body, so there is nothing to save",
  },
  {
    index: 4,
    url: "https://example.test/guarded",
    status: 403,
    files: ["04.txt"],
    reason: "challenge" as const,
    error: "challenge: Cloudflare check on this page",
  },
  {
    index: 5,
    url: "https://example.test/limited",
    status: 429,
    files: ["05.txt"],
    reason: "blocked" as const,
    error: "blocked: the site refused the visit",
  },
  { index: 6, url: "https://example.test/hung", files: [], error: "timed out after 60000 ms" },
];

test("collectSummary counts only pages without an HTTP error, challenge, block or failure as collected", () => {
  expect(collectSummary("/tmp/c", mixedPages).collected).toBe(1);
});

test("collectSummary counts pages with an HTTP error apart from the collected ones", () => {
  expect(collectSummary("/tmp/c", mixedPages).httpErrors).toBe(2);
});

test("collectSummary counts pages showing a challenge", () => {
  expect(collectSummary("/tmp/c", mixedPages).challenges).toBe(1);
});

test("collectSummary counts pages the site blocked", () => {
  expect(collectSummary("/tmp/c", mixedPages).blocked).toBe(1);
});

test("collectSummary counts pages that failed for another reason", () => {
  expect(collectSummary("/tmp/c", mixedPages).failed).toBe(1);
});

test("collectSummary carries why a page was not collected", () => {
  expect(collectSummary("/tmp/c", mixedPages).pages[3]?.reason).toBe("challenge");
});

test("the index head counts the collected pages without the HTTP errors, challenges and blocks", () => {
  expect(renderCollectIndex("/tmp/c", mixedPages)).toStartWith(
    "Collected 1 of 6 pages into /tmp/c\nNot counted: 2 HTTP errors (404, 500), 1 challenge, 1 blocked, 1 failed.",
  );
});

test("the index head of a fully collected folder has no line on pages not counted", () => {
  expect(renderCollectIndex("/tmp/c", mixedPages.slice(0, 1))).not.toContain("Not counted");
});

test("the index text explains the index lines it prints", () => {
  expect(renderCollectIndex("/tmp/c", mixedPages)).toContain("\nEach line: number, HTTP status");
});

test("the index frame around a pointer to the pages field leaves out the explanation of index lines", () => {
  expect(collectIndexFrame("/tmp/c", mixedPages)("(pages in the pages field)")).toBe(
    "Collected 1 of 6 pages into /tmp/c\nNot counted: 2 HTTP errors (404, 500), 1 challenge, 1 blocked, 1 failed.\nRead or grep the files for the content; index.json has the same list.\n(pages in the pages field)",
  );
});

test("the index line of a page showing a challenge names the files kept from it", () => {
  expect(renderCollectIndex("/tmp/c", mixedPages)).toContain(
    "04 FAILED https://example.test/guarded — challenge: Cloudflare check on this page → 04.txt",
  );
});

test("collectSummary lists a page answered with HTTP 404 with reason http-error", () => {
  expect(collectSummary("/tmp/c", mixedPages).pages[1]?.reason).toBe("http-error");
});

test("collectSummary lists a page answered with an empty HTTP 500 with reason http-error", () => {
  expect(collectSummary("/tmp/c", mixedPages).pages[2]?.reason).toBe("http-error");
});

test("collectSummary keeps reason challenge for a challenge answered with HTTP 403", () => {
  expect(collectSummary("/tmp/c", mixedPages).pages[3]?.reason).toBe("challenge");
});

test("the index line of a page answered with an HTTP error says it is not counted", () => {
  expect(renderCollectIndex("/tmp/c", mixedPages)).toContain(
    '02 404 https://example.test/gone "Missing" → 02.txt — http error: not counted as collected',
  );
});
