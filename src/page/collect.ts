import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runPool, sleep, TIMED_OUT, untilAborted, withDeadline } from "../shared/async.ts";
import {
  type BodyType,
  classifyBody,
  extractPdfText,
  fetchBody,
  isDownloadError,
  isTextKind,
} from "./body.ts";
import type { BrowserManager } from "../browser/manager.ts";
import { capture } from "./capture.ts";
import { acceptConsentOnce } from "../overlays/consent.ts";
import { parseJson } from "../shared/decode.ts";
import { describeError } from "../shared/errors.ts";
import { extractPage, summarizeStructured } from "./extract.ts";
import { pageMarkdown } from "./markdown.ts";
import { slugify, timestampSlug, type OutputStore } from "../shared/output.ts";
import { waitForContent } from "./settle.ts";
import { pageLinks, pageText, pageTitle, rawSnapshot } from "./page.ts";
import type { Tab } from "../browser/tab.ts";

type CollectPart = "text" | "markdown" | "links" | "snapshot" | "screenshot" | "structured";

type ScrollInput = { maxSteps: number; stepPx?: number; idleMs: number };

type ScrollOutcome = { steps: number; height: number; capped: boolean };

type CollectInput = {
  urls: string[];
  include: CollectPart[];
  scope: "main" | "page";
  concurrency: number;
  waitUntil: "commit" | "domcontentloaded" | "load";
  settleMs: number;
  maxWaitMs: number;
  timeoutMs: number;
  fullPage: boolean;
  previewChars: number;
  scroll?: ScrollInput;
  label?: string;
  signal?: AbortSignal;
  capture?: (tab: Tab, base: string, dir: string) => Promise<string[]>;
  redact?: (text: string) => string;
};

function writeText(file: string, text: string, input: CollectInput) {
  return writeFile(file, input.redact ? input.redact(text) : text);
}

const collectedIndexEntrySchema = z.object({
  index: z.number().int(),
  url: z.string(),
  finalUrl: z.string().optional().catch(undefined),
  error: z.string().optional(),
});

export type CollectedIndexEntry = z.infer<typeof collectedIndexEntrySchema>;

export function collectedIndex(text: string): CollectedIndexEntry[] {
  const decoded = parseJson(text, z.array(z.unknown()));
  if (!decoded.success) return [];
  return decoded.data.flatMap((entry) => {
    const page = collectedIndexEntrySchema.safeParse(entry);
    return page.success ? [page.data] : [];
  });
}

type CollectedPage = {
  index: number;
  url: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  type?: string;
  bytes?: number;
  note?: string;
  scrolled?: ScrollOutcome;
  unsettledMs?: number;
  chars?: number;
  links?: number;
  files: string[];
  preview?: string;
  data?: string;
  error?: string;
};

const LINK_LIMIT = 500;
const SCROLL_PROBE_MS = 2000;
const CLOSE_GRACE_MS = 5000;

const HOST_PORT = /^(\[[0-9a-f:.]+\]|[a-z0-9-]+(\.[a-z0-9-]+)*):\d{1,5}(?=$|[/?#])/i;

export function isLocalHost(host: string) {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.endsWith(".localhost") || bare === "::1" || bare === "0.0.0.0")
    return true;
  const octets = bare.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  )
    return false;
  const [first = 0, second = 0] = octets;
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254)
  );
}

export function normalizeUrl(url: string) {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !HOST_PORT.test(trimmed)) return trimmed;
  const host = /^(\[[^\]]+\]|[^/:?#]+)/.exec(trimmed)?.[1] ?? "";
  return `${isLocalHost(host) ? "http" : "https"}://${trimmed}`;
}

async function collectOne(
  manager: BrowserManager,
  openTab: () => Promise<Tab>,
  dir: string,
  input: CollectInput,
  url: string,
  index: number,
): Promise<CollectedPage> {
  const base = collectedBase({ index: index + 1, url });
  const result: CollectedPage = { index: index + 1, url, files: [] };
  const tab = await openTab();

  try {
    const limit =
      2 * input.timeoutMs +
      input.settleMs +
      (input.scroll ? input.scroll.maxSteps * (input.scroll.idleMs + SCROLL_PROBE_MS) : 0);
    const outcome = await withDeadline(
      untilAborted(
        saveOne(manager, tab, dir, input, url, base, result),
        input.signal,
        () => new Error("cancelled before the page was saved"),
      ),
      limit,
    );
    if (outcome === TIMED_OUT)
      result.error = `timed out after ${limit} ms; the page did not load or did not answer while its content was saved`;
  } catch (error) {
    result.error = describeError(error).split("\n")[0];
  } finally {
    await withDeadline(manager.closeTab(tab.id), CLOSE_GRACE_MS).catch(() => undefined);
  }
  return result;
}

async function saveOne(
  manager: BrowserManager,
  tab: Tab,
  dir: string,
  input: CollectInput,
  url: string,
  base: string,
  result: CollectedPage,
) {
  const { page } = tab;
  let response;
  try {
    response = await page.goto(url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
  } catch (error) {
    if (!isDownloadError(error)) throw error;
    const fetched = await fetchBody(page.context(), url, input.timeoutMs);
    result.status = fetched.status;
    result.finalUrl = fetched.url;
    return saveBody(
      dir,
      base,
      classifyBody(fetched.contentType, fetched.url),
      fetched.body,
      input,
      result,
    );
  }
  const bodyType = classifyBody(response?.headers()["content-type"], page.url());
  if (response && bodyType.kind !== "html") {
    result.status = response.status();
    result.finalUrl = response.url();
    const body =
      bodyType.kind === "pdf"
        ? (await fetchBody(page.context(), response.url(), input.timeoutMs)).body
        : await response.body();
    return saveBody(dir, base, bodyType, body, input, result);
  }
  const settle = await waitForContent(page, {
    quietMs: input.settleMs,
    maxWaitMs: Math.min(input.maxWaitMs, input.timeoutMs),
  });
  if (!settle.settled && !settle.unresponsive) result.unsettledMs = settle.ms;
  await acceptConsentOnce(tab, manager.config.autoConsent);
  if (input.scroll) result.scrolled = await autoScroll(page, input.scroll);
  result.status = response?.status();
  result.finalUrl = page.url();
  result.title = await pageTitle(page);

  if (input.include.includes("text")) {
    const text = await pageText(page, input.scope);
    result.chars = text.length;
    result.preview = text.slice(0, input.previewChars).replace(/\s+/g, " ");
    const header = `URL: ${result.finalUrl}\nTitle: ${result.title ?? ""}\nStatus: ${result.status ?? ""}\n\n`;
    await writeText(path.join(dir, `${base}.txt`), header + text, input);
    result.files.push(`${base}.txt`);
  }
  if (input.include.includes("markdown")) {
    const markdown = await pageMarkdown(page, input.scope);
    if (result.chars === undefined) {
      result.chars = markdown.length;
      result.preview = markdown.slice(0, input.previewChars).replace(/\s+/g, " ");
    }
    const header = `<!-- URL: ${result.finalUrl} · Status: ${result.status ?? ""} -->\n# ${result.title ?? ""}\n\n`;
    await writeText(path.join(dir, `${base}.md`), header + markdown, input);
    result.files.push(`${base}.md`);
  }
  if (input.capture) result.files.push(...(await input.capture(tab, base, dir)));
  if (input.include.includes("links")) {
    const links = await pageLinks(page, LINK_LIMIT);
    result.links = links.length;
    await writeText(
      path.join(dir, `${base}.links.tsv`),
      links.map((link) => `${link.url}\t${link.text}`).join("\n"),
      input,
    );
    result.files.push(`${base}.links.tsv`);
  }
  if (input.include.includes("structured")) {
    const data = await extractPage(page);
    result.data = summarizeStructured(data);
    await writeText(path.join(dir, `${base}.data.json`), JSON.stringify(data, null, 2), input);
    result.files.push(`${base}.data.json`);
  }
  if (input.include.includes("snapshot")) {
    await writeText(
      path.join(dir, `${base}.snapshot.yml`),
      await rawSnapshot(manager, tab, {}),
      input,
    );
    result.files.push(`${base}.snapshot.yml`);
  }
  if (input.include.includes("screenshot")) {
    const image = await capture(page, {
      format: "jpeg",
      quality: 70,
      fullPage: input.fullPage,
      timeoutMs: input.timeoutMs,
    });
    await writeFile(path.join(dir, `${base}.jpg`), image);
    result.files.push(`${base}.jpg`);
  }
}

function scrollStep(stepPx: number | null) {
  window.scrollBy(0, stepPx ?? Math.max(200, Math.floor(window.innerHeight * 0.9)));
  const root = document.scrollingElement ?? document.documentElement;
  return {
    height: root.scrollHeight,
    bottom: window.scrollY + window.innerHeight >= root.scrollHeight - 2,
  };
}

function pageHeight() {
  return (document.scrollingElement ?? document.documentElement).scrollHeight;
}

async function probe<T>(promise: Promise<T>) {
  const value = await withDeadline(promise, SCROLL_PROBE_MS);
  if (value === TIMED_OUT)
    throw new Error(`the page did not answer within ${SCROLL_PROBE_MS} ms while scrolling`);
  return value;
}

async function scrollFrom(
  page: Tab["page"],
  scroll: ScrollInput,
  step: number,
  height: number,
): Promise<ScrollOutcome> {
  if (step > scroll.maxSteps) return { steps: scroll.maxSteps, height, capped: true };
  const moved = await probe(page.evaluate(scrollStep, scroll.stepPx ?? null));
  await sleep(scroll.idleMs);
  const grown = await probe(page.evaluate(pageHeight));
  const grew = grown > height || moved.height > height;
  const reached = Math.max(grown, moved.height);
  if (moved.bottom && !grew) return { steps: step, height: reached, capped: false };
  return scrollFrom(page, scroll, step + 1, reached);
}

async function autoScroll(page: Tab["page"], scroll: ScrollInput): Promise<ScrollOutcome> {
  return scrollFrom(page, scroll, 1, await probe(page.evaluate(pageHeight)));
}

function keepText(result: CollectedPage, text: string, previewChars: number) {
  result.chars = text.length;
  result.preview = text.slice(0, previewChars).replace(/\s+/g, " ");
}

async function saveBody(
  dir: string,
  base: string,
  type: BodyType,
  body: Buffer,
  input: CollectInput,
  result: CollectedPage,
) {
  result.type = type.mime;
  result.bytes = body.length;
  const raw = `${base}.${type.extension}`;
  if (isTextKind(type.kind)) await writeText(path.join(dir, raw), body.toString("utf8"), input);
  else await writeFile(path.join(dir, raw), body);
  result.files.push(raw);
  if (isTextKind(type.kind)) keepText(result, body.toString("utf8"), input.previewChars);
  if (type.kind !== "pdf") return;
  const extracted = await extractPdfText(path.join(dir, raw));
  if (extracted.text === undefined) {
    result.note = extracted.unavailable;
    return;
  }
  await writeText(path.join(dir, `${base}.txt`), extracted.text, input);
  result.files.push(`${base}.txt`);
  keepText(result, extracted.text, input.previewChars);
}

export function serializedOpener(manager: BrowserManager, owner: string) {
  let opening: Promise<unknown> = Promise.resolve();
  return () => {
    const next = opening.then(() => manager.openTab(owner));
    opening = next.catch(() => undefined);
    return next;
  };
}

export function collectedBase(page: Pick<CollectedPage, "index" | "url">) {
  return `${String(page.index).padStart(2, "0")}-${slugify(page.url)}`;
}

export async function collectPages(
  manager: BrowserManager,
  store: OutputStore,
  owner: string,
  input: CollectInput,
) {
  const dir = await store.dir(
    "collect",
    `${timestampSlug()}-${slugify(input.label ?? "pages", 40)}`,
  );
  const urls = input.urls.map(normalizeUrl);
  const openTab = serializedOpener(manager, owner);
  const job: CollectInput = { ...input, redact: input.redact ?? ((text) => store.redact(text)) };
  const collected = await runPool(
    urls,
    input.concurrency,
    (url, index) => collectOne(manager, openTab, dir, job, url, index),
    input.signal,
  );
  const results = collected.map(
    (result, index): CollectedPage =>
      result ?? {
        index: index + 1,
        url: urls[index] ?? "",
        files: [],
        error: "not started: the call was cancelled",
      },
  );

  await writeText(path.join(dir, "index.json"), JSON.stringify(results, null, 2), job);
  return { dir, results };
}

export function renderCollectIndex(dir: string, results: CollectedPage[]) {
  const failed = results.filter((result) => result.error).length;
  const lines = [
    `Collected ${results.length - failed} of ${results.length} pages into ${dir}`,
    "Each line: number, HTTP status, final URL, title (or [content type] for PDFs, JSON, images and other files, which are saved as they are), text length, files. Read or grep the files for the content; index.json has the same list.",
  ];
  for (const result of results) {
    const number = String(result.index).padStart(2, "0");
    if (result.error) {
      lines.push(`${number} FAILED ${result.url} — ${result.error}`);
      continue;
    }
    const size =
      result.chars !== undefined
        ? ` ${result.chars} chars`
        : result.bytes !== undefined
          ? ` ${result.bytes} bytes`
          : "";
    const label = result.type ? `[${result.type}]` : `"${result.title ?? ""}"`;
    lines.push(
      `${number} ${result.status ?? "-"} ${result.finalUrl} ${label}${size} → ${result.files.join(", ")}`,
    );
    if (result.note) lines.push(`   ${result.note}`);
    if (result.unsettledMs !== undefined)
      lines.push(
        `   content still changing after ${Math.round(result.unsettledMs / 1000)} s; saved as it was then`,
      );
    if (result.scrolled) {
      const { steps, height, capped } = result.scrolled;
      lines.push(
        `   scrolled ${steps} step${steps === 1 ? "" : "s"}${capped ? " (max_steps reached)" : ""}, page height ${height}px`,
      );
    }
    if (result.data) lines.push(`   ${result.data}`);
    if (result.preview) lines.push(`   ${result.preview}`);
  }
  return lines.join("\n");
}
