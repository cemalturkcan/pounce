import { execFile } from "node:child_process";
import type { BrowserContext, Page } from "playwright-core";
import { TIMED_OUT, withDeadline } from "./async.ts";
import type { OutputStore } from "./output.ts";

export type BodyKind = "html" | "pdf" | "json" | "csv" | "text" | "image" | "binary";

export type BodyType = { kind: BodyKind; extension: string; mime: string };

const IMAGE_EXTENSIONS: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico", "vnd.microsoft.icon": "ico" };
const TEXT_EXTENSIONS: Record<string, string> = { plain: "txt", markdown: "md", "x-markdown": "md", xml: "xml", javascript: "js", css: "css", tsv: "tsv", "tab-separated-values": "tsv" };

function urlExtension(url: string) {
  try {
    return /\.([a-z0-9]{1,8})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

export function classifyBody(contentType: string | undefined, url: string): BodyType {
  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const [major = "", minor = ""] = mime.split("/");
  if (!mime || mime === "text/html" || mime === "application/xhtml+xml") return { kind: "html", extension: "html", mime: mime || "text/html" };
  if (mime === "application/pdf") return { kind: "pdf", extension: "pdf", mime };
  if (minor === "json" || minor.endsWith("+json")) return { kind: "json", extension: "json", mime };
  if (mime === "text/csv") return { kind: "csv", extension: "csv", mime };
  if (major === "text") return { kind: "text", extension: TEXT_EXTENSIONS[minor] ?? "txt", mime };
  if (mime === "application/xml" || minor.endsWith("+xml")) return major === "image" ? { kind: "image", extension: "svg", mime } : { kind: "text", extension: "xml", mime };
  if (major === "image") return { kind: "image", extension: IMAGE_EXTENSIONS[minor] ?? minor.replace(/[^a-z0-9]/g, "").slice(0, 8), mime };
  return { kind: "binary", extension: urlExtension(url) ?? "bin", mime };
}

export function isTextKind(kind: BodyKind) {
  return kind === "json" || kind === "csv" || kind === "text";
}

const PDF_TEXT_TIMEOUT_MS = 30_000;

export function extractPdfText(file: string, command = "pdftotext"): Promise<{ text?: string; unavailable?: string }> {
  return new Promise((resolve) => {
    execFile(command, ["-enc", "UTF-8", file, "-"], { timeout: PDF_TEXT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (!error) return resolve({ text: stdout.replace(/\f/g, "\n").trim() });
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve({ unavailable: "pdftotext is not installed (poppler-utils), so the PDF text was not extracted" });
      resolve({ unavailable: `pdftotext could not read the PDF: ${error.message.split("\n")[0]}` });
    });
  });
}

export function isDownloadError(error: unknown) {
  return error instanceof Error && /Download is starting/i.test(error.message);
}

export async function fetchBody(context: BrowserContext, url: string, timeoutMs: number) {
  const response = await context.request.get(url, { timeout: timeoutMs, failOnStatusCode: false });
  try {
    return { status: response.status(), url: response.url(), contentType: response.headers()["content-type"], body: await response.body() };
  } finally {
    await response.dispose().catch(() => undefined);
  }
}

const PROBE_MS = 5000;
const FETCH_MS = 30_000;

export async function tabBodyType(page: Page) {
  const contentType = await withDeadline(page.evaluate(() => document.contentType), PROBE_MS).catch(() => undefined);
  return classifyBody(contentType === TIMED_OUT ? undefined : contentType, page.url());
}

export async function readTabBody(page: Page, type: BodyType, store: OutputStore) {
  const url = page.url();
  const fetched = await fetchBody(page.context(), url, FETCH_MS);
  if (isTextKind(type.kind)) return { text: fetched.body.toString("utf8") };
  const kind = type.kind === "pdf" ? "pages" : "downloads";
  const file = await store.write(kind, store.uniqueName(url, type.extension), fetched.body);
  const size = `${fetched.body.length} bytes`;
  if (type.kind !== "pdf") return { note: `This tab shows ${type.mime} (${size}), which has no text to read; it was saved to ${file}. Use screenshot to look at an image.` };
  const extracted = await extractPdfText(file);
  if (extracted.text === undefined) return { note: `This tab shows a PDF (${size}); it was saved to ${file}, but ${extracted.unavailable}.` };
  return { text: extracted.text, note: `PDF text extracted with pdftotext; the PDF is saved to ${file}.` };
}
