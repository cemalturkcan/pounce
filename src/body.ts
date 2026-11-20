import { execFile } from "node:child_process";
import type { BrowserContext, Page } from "playwright-core";
import { TIMED_OUT, withDeadline } from "./async.ts";
import type { Tab } from "./browser.ts";
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

const withoutHash = (url: string) => url.replace(/#.*$/, "");

async function documentBody(tab: Tab) {
  const document = tab.document;
  if (!document || withoutHash(document.url) !== withoutHash(tab.page.url())) return undefined;
  return withDeadline(document.response.body(), FETCH_MS)
    .then((body) => (body === TIMED_OUT ? undefined : body))
    .catch(() => undefined);
}

async function renderedText(page: Page) {
  const text = await withDeadline(page.evaluate(() => document.body?.innerText ?? ""), PROBE_MS).catch(() => undefined);
  return typeof text === "string" ? text : undefined;
}

async function pdfFromPage(page: Page) {
  const data = await withDeadline(
    page.evaluate(async (url) => {
      const response = await fetch(url, { cache: "force-cache", credentials: "include" });
      const blob = await response.blob();
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }, withoutHash(page.url())),
    FETCH_MS,
  ).catch(() => undefined);
  return typeof data === "string" ? Buffer.from(data, "base64") : undefined;
}

export async function readTabBody(tab: Tab, type: BodyType, store: OutputStore) {
  const url = tab.page.url();
  const body = type.kind === "pdf" ? await pdfFromPage(tab.page) : await documentBody(tab);
  if (isTextKind(type.kind)) {
    if (body) return { text: body.toString("utf8") };
    const text = await renderedText(tab.page);
    if (text !== undefined) return { text, note: "The response body of this tab is no longer available, so this is the text the tab shows." };
  }
  if (!body) return { note: `This tab shows ${type.mime}, but the browser no longer holds the response body of ${url}. Load it again with navigate and call read_text again.` };
  const kind = type.kind === "pdf" ? "pages" : "downloads";
  const file = await store.write(kind, store.uniqueName(url, type.extension), body);
  const size = `${body.length} bytes`;
  if (type.kind !== "pdf") return { note: `This tab shows ${type.mime} (${size}), which has no text to read; it was saved to ${file}. Use screenshot to look at an image.` };
  const extracted = await extractPdfText(file);
  if (extracted.text === undefined) return { note: `This tab shows a PDF (${size}); it was saved to ${file}, but ${extracted.unavailable}.` };
  return { text: extracted.text, note: `PDF text extracted with pdftotext; the PDF is saved to ${file}.` };
}
