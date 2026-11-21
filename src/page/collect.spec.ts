import { expect, test } from "bun:test";
import { collectedIndex, normalizeUrl } from "./collect.ts";

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
