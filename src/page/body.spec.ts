import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tinyPdf } from "../../e2e/fixture-content.ts";
import { classifyBody, extractPdfText } from "./body.ts";

const cases: [string | undefined, string, string, string][] = [
  ["application/pdf", "https://a.test/r", "pdf", "pdf"],
  ["application/json; charset=utf-8", "https://a.test/r", "json", "json"],
  ["application/ld+json", "https://a.test/r", "json", "json"],
  ["text/plain", "https://a.test/r", "text", "txt"],
  ["text/csv", "https://a.test/r", "csv", "csv"],
  ["text/markdown", "https://a.test/r", "text", "md"],
  ["image/jpeg", "https://a.test/r", "image", "jpg"],
  ["image/svg+xml", "https://a.test/r", "image", "svg"],
  ["application/octet-stream", "https://a.test/files/archive.zip?x=1", "binary", "zip"],
  ["application/octet-stream", "https://a.test/files/blob", "binary", "bin"],
  ["text/html; charset=utf-8", "https://a.test/r.pdf", "html", "html"],
  ["application/xhtml+xml", "https://a.test/r", "html", "html"],
  [undefined, "https://a.test/r", "html", "html"],
];

for (const [contentType, url, kind, extension] of cases) {
  test(`classifyBody maps ${contentType ?? "no content type"} at ${url} to ${kind} .${extension}`, () => {
    const body = classifyBody(contentType, url);
    expect([body.kind, body.extension]).toStrictEqual([kind, extension]);
  });
}

test("extractPdfText returns the text of a PDF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-text-"));
  const text = `Total ${Math.random().toString(36).slice(2, 10)}`;
  try {
    const file = path.join(dir, "a.pdf");
    await writeFile(file, tinyPdf(text));
    expect((await extractPdfText(file)).text?.trim()).toBe(text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractPdfText explains that text extraction is unavailable without pdftotext", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-text-"));
  try {
    const file = path.join(dir, "a.pdf");
    await writeFile(file, tinyPdf("x"));
    expect((await extractPdfText(file, path.join(dir, "no-pdftotext"))).unavailable ?? "").toMatch(
      /pdftotext is not installed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
