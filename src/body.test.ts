import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tinyPdf } from "../e2e/fixture.ts";
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
    assert.deepEqual([body.kind, body.extension], [kind, extension]);
  });
}

const pdftotextInstalled = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("extractPdfText returns the text of a PDF", { skip: pdftotextInstalled ? false : "pdftotext is not installed" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-text-"));
  const text = `Total ${Math.random().toString(36).slice(2, 10)}`;
  try {
    const file = path.join(dir, "a.pdf");
    await writeFile(file, tinyPdf(text));
    assert.equal((await extractPdfText(file)).text?.trim(), text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractPdfText explains that text extraction is unavailable without pdftotext", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pdf-text-"));
  try {
    const file = path.join(dir, "a.pdf");
    await writeFile(file, tinyPdf("x"));
    assert.match((await extractPdfText(file, path.join(dir, "no-pdftotext"))).unavailable ?? "", /pdftotext is not installed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
