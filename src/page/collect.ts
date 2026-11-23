import { writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  inSequence,
  runPool,
  sleep,
  TIMED_OUT,
  untilAborted,
  withDeadline,
} from "../shared/async.ts";
import {
  type BodyType,
  classifyBody,
  emptyErrorResponse,
  noContentResponse,
  settleErrorPage,
  extractPdfText,
  fetchBody,
  isDownloadError,
  isTextKind,
} from "./body.ts";
import type { BrowserManager } from "../browser/manager.ts";
import { evaluateIsolated } from "../browser/evaluate.ts";
import { capture } from "./capture.ts";
import { acceptConsentOnce } from "../overlays/consent.ts";
import { parseJson } from "../shared/decode.ts";
import { describeError } from "../shared/errors.ts";
import { extractPage, summarizeStructured } from "./extract.ts";
import { pageMarkdown } from "./markdown.ts";
import { shownUrl, slugify, type OutputStore } from "../shared/output.ts";
import { waitForContent } from "./settle.ts";
import { registrableDomain } from "./sites.ts";
import { pageLinks, pageText, pageTitle, rawSnapshot } from "./page.ts";
import { PAGE_FILE_FORMATS, pageFile } from "./save-page.ts";
import { namedStatus, type Tab } from "../browser/tab.ts";
import { dialogBlocked, raceDialog } from "../browser/dialogs.ts";
import { type Challenge, probeLanding, settleChallenge, standsInForPage } from "./checks.ts";

type CollectPart =
  | "text"
  | "markdown"
  | "links"
  | "snapshot"
  | "screenshot"
  | "structured"
  | "pdf"
  | "mhtml"
  | "html";

type ScrollInput = { maxSteps: number; stepPx?: number; idleMs: number };

type ScrollOutcome = { steps: number; height: number; capped: boolean };

type SaveInput = {
  include: CollectPart[];
  scope: "main" | "page";
  settleMs: number;
  maxWaitMs: number;
  timeoutMs: number;
  fullPage: boolean;
  previewChars: number;
  scroll?: ScrollInput;
  label?: string;
  signal?: AbortSignal;
  halt?: AbortSignal;
  deadline?: number;
  capture?: (tab: Tab, base: string, dir: string) => Promise<string[]>;
  redact?: (text: string) => string;
};

type CollectInput = SaveInput & {
  urls: string[];
  concurrency: number;
  delayMs?: number;
  waitUntil: "commit" | "domcontentloaded" | "load";
};

async function writeText(file: string, text: string, input: SaveInput) {
  input.halt?.throwIfAborted();
  await writeFile(file, input.redact ? input.redact(text) : text);
}

async function writeBytes(file: string, bytes: Buffer, input: SaveInput) {
  input.halt?.throwIfAborted();
  await writeFile(file, bytes);
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
  statusNote?: string;
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
  reason?: NotCollectedReason;
};

type NotCollectedReason = "challenge" | "blocked" | "no-content" | "http-error";

const LINK_LIMIT = 500;
const SCROLL_PROBE_MS = 2000;
const STATUS_PROBE_MS = 1500;
const CLOSE_GRACE_MS = 5000;
const SAVE_MARGIN_MS = 2000;

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

export function siteKey(url: string) {
  const parsed = URL.parse(url);
  if (!parsed?.hostname) return url;
  return isLocalHost(parsed.hostname) ? parsed.host : registrableDomain(parsed.hostname);
}

export function normalizeUrl(url: string) {
  const trimmed = url.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !HOST_PORT.test(trimmed)) return trimmed;
  const host = /^(\[[^\]]+\]|[^/:?#]+)/.exec(trimmed)?.[1] ?? "";
  return `${isLocalHost(host) ? "http" : "https"}://${trimmed}`;
}

function pageLimit(input: SaveInput) {
  return (
    2 * input.timeoutMs +
    input.settleMs +
    (input.scroll ? input.scroll.maxSteps * (input.scroll.idleMs + SCROLL_PROBE_MS) : 0)
  );
}

async function guarded<T extends SaveInput>(
  input: T,
  result: CollectedPage,
  work: (job: T) => Promise<void>,
) {
  const limit = pageLimit(input);
  const halted = new AbortController();
  try {
    const outcome = await withDeadline(
      untilAborted(
        work({ ...input, halt: halted.signal, deadline: Date.now() + limit }),
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
    halted.abort();
  }
}

async function collectOne(
  manager: BrowserManager,
  openTab: () => Promise<Tab>,
  dir: string,
  input: CollectInput,
  url: string,
  index: number,
  started: () => void,
): Promise<CollectedPage> {
  const base = collectedBase({ index: index + 1, url });
  const result: CollectedPage = { index: index + 1, url, files: [] };
  const tab = await openTab();
  started();
  tab.unattended = true;
  const releaseRendering = manager.holdRendering(tab);
  try {
    await guarded(input, result, (job) => saveOne(manager, tab, dir, job, url, base, result));
  } finally {
    await withDeadline(manager.closeTab(tab.id), CLOSE_GRACE_MS).catch(() => undefined);
    releaseRendering();
  }
  return result;
}

async function saveTab(
  manager: BrowserManager,
  owner: string,
  dir: string,
  input: SaveInput,
  tab: Tab,
  index: number,
): Promise<CollectedPage> {
  const url = tab.page.url();
  const result: CollectedPage = { index: index + 1, url, files: [] };
  if (tab.dialog) return { ...result, error: dialogBlocked(tab, tab.dialog, "save_pages").message };
  const endAction = manager.beginAction(tab, "save_pages", owner);
  try {
    await guarded(input, result, (job) =>
      raceDialog(
        tab,
        settleAndSave(manager, tab, dir, job, collectedBase(result), result),
        (dialog) => {
          result.error = dialogBlocked(tab, dialog, "save_pages").message;
        },
      ),
    );
  } finally {
    endAction();
    manager.markSeen(tab);
  }
  return result;
}

async function settle(page: Tab["page"], input: SaveInput, result: CollectedPage) {
  const settled = await waitForContent(page, {
    quietMs: input.settleMs,
    maxWaitMs: Math.min(input.maxWaitMs, input.timeoutMs),
  });
  if (!settled.settled && !settled.unresponsive) result.unsettledMs = settled.ms;
}

async function settleAndSave(
  manager: BrowserManager,
  tab: Tab,
  dir: string,
  input: SaveInput,
  base: string,
  result: CollectedPage,
) {
  await settle(tab.page, input, result);
  await saveParts(manager, tab, dir, input, base, result);
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
  const startedAt = Date.now();
  let response;
  try {
    response = await page.goto(url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
  } catch (error) {
    const answered = noContentResponse(tab, startedAt, error);
    if (answered) {
      result.status = answered.status();
      result.finalUrl = answered.url();
      result.reason = "no-content";
      result.error = `no content: the server answered HTTP ${namedStatus(answered.status())}, so there is no page to save`;
      return undefined;
    }
    const failed = emptyErrorResponse(tab, error);
    if (failed) {
      result.status = failed.status();
      result.finalUrl = failed.url();
      result.error = `http error: HTTP ${failed.status()} with an empty body, so there is nothing to save`;
      await settleErrorPage(page);
      await checkChallenge(manager, tab, input, result);
      return undefined;
    }
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
  await settle(page, input, result);
  await acceptConsentOnce(tab, manager.config.autoConsent);
  result.status = response?.status();
  await saveParts(manager, tab, dir, input, base, result);
}

export function pageStatus(
  url: string,
  documentStatus: number | undefined,
  timedStatus: number | undefined,
): { status: number } | { statusNote: string } {
  if (!/^https?:/i.test(url)) return { statusNote: "not loaded over HTTP" };
  const status = documentStatus ?? (timedStatus ? timedStatus : undefined);
  if (status !== undefined) return { status };
  return {
    statusNote:
      "the browser reported no HTTP status for this page, as when it comes from a cache or the page made it itself",
  };
}

async function timingStatus(manager: BrowserManager, page: Tab["page"]) {
  const status = await withDeadline(
    evaluateIsolated(
      manager.config.engine,
      page,
      `performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0`,
      z.number(),
    ),
    STATUS_PROBE_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  return status === TIMED_OUT ? undefined : status;
}

async function readStatus(manager: BrowserManager, tab: Tab, result: CollectedPage) {
  const current = tab.documents.find((document) => document.id === tab.currentDocument);
  Object.assign(
    result,
    pageStatus(tab.page.url(), current?.status, await timingStatus(manager, tab.page)),
  );
}

function notCollectedLine(challenge: Challenge, status: number | undefined) {
  if (challenge.kind === "block") {
    const source = challenge.provider ? `${challenge.provider}, ` : "";
    const refused = `the site refused the visit (${source}${challenge.detail}), so the page is not counted as collected`;
    return status === 429
      ? `rate limited: ${refused}; wait before loading this site again, or raise delay_ms`
      : `blocked: ${refused}; do not retry or reload`;
  }
  return `challenge: a ${challenge.provider} check (${challenge.detail}) stands in for the page, so it is not counted as collected`;
}

async function checkChallenge(
  manager: BrowserManager,
  tab: Tab,
  input: SaveInput,
  result: CollectedPage,
) {
  const left = () => (input.deadline ?? Infinity) - Date.now() - SAVE_MARGIN_MS;
  const probed = await probeLanding(tab, left());
  if (!probed) return;
  const outcome = await settleChallenge(
    tab.page,
    probed,
    result.status,
    Math.min(input.timeoutMs, left()),
  );
  if (outcome.cleared) {
    result.status = undefined;
    result.statusNote = undefined;
    await readStatus(manager, tab, result);
  }
  if (!outcome.challenge || !standsInForPage(outcome.challenge)) return;
  result.reason = outcome.challenge.kind === "block" ? "blocked" : "challenge";
  result.error = notCollectedLine(outcome.challenge, result.status);
}

async function saveParts(
  manager: BrowserManager,
  tab: Tab,
  dir: string,
  input: SaveInput,
  base: string,
  result: CollectedPage,
) {
  const { page } = tab;
  if (result.status === undefined) await readStatus(manager, tab, result);
  await checkChallenge(manager, tab, input, result);
  if (input.scroll) result.scrolled = await autoScroll(page, input.scroll);
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
  if (input.capture) {
    input.halt?.throwIfAborted();
    result.files.push(...(await input.capture(tab, base, dir)));
  }
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
    await writeBytes(path.join(dir, `${base}.jpg`), image, input);
    result.files.push(`${base}.jpg`);
  }
  await inSequence(
    PAGE_FILE_FORMATS.filter((format) => input.include.includes(format)),
    async (format) => {
      const content = await pageFile(page, format);
      const file = path.join(dir, `${base}.${format}`);
      await (Buffer.isBuffer(content)
        ? writeBytes(file, content, input)
        : writeText(file, content, input));
      result.files.push(`${base}.${format}`);
    },
  );
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
  input: SaveInput,
  result: CollectedPage,
) {
  result.type = type.mime;
  result.bytes = body.length;
  const raw = `${base}.${type.extension}`;
  if (isTextKind(type.kind)) await writeText(path.join(dir, raw), body.toString("utf8"), input);
  else await writeBytes(path.join(dir, raw), body, input);
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

function outputKind(include: CollectPart[]) {
  return PAGE_FILE_FORMATS.some((format) => include.includes(format)) ? "pages" : "collect";
}

async function writeIndex(dir: string, results: CollectedPage[], input: SaveInput) {
  const listed = results.map((result) => ({ ...result, reason: reasonOf(result) }));
  await writeText(path.join(dir, "index.json"), JSON.stringify(listed, null, 2), input);
  return { dir, results };
}

export async function collectPages(
  manager: BrowserManager,
  store: OutputStore,
  owner: string,
  input: CollectInput,
) {
  const { dir } = await store.uniqueDir(outputKind(input.include), input.label ?? "pages");
  const urls = input.urls.map(normalizeUrl);
  const openTab = serializedOpener(manager, owner);
  const job: CollectInput = { ...input, redact: input.redact ?? ((text) => store.redact(text)) };
  const collected = await runPool(
    urls,
    input.concurrency,
    (url, index, started) => collectOne(manager, openTab, dir, job, url, index, started),
    input.signal,
    { gapMs: input.delayMs ?? 0, keyOf: siteKey },
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
  return writeIndex(dir, results, job);
}

export async function saveTabs(
  manager: BrowserManager,
  store: OutputStore,
  owner: string,
  tabs: Tab[],
  input: SaveInput,
) {
  const { dir } = await store.uniqueDir(outputKind(input.include), input.label ?? "tabs");
  const job: SaveInput = { ...input, redact: input.redact ?? ((text) => store.redact(text)) };
  const results = await inSequence(tabs, (tab, index) =>
    saveTab(manager, owner, dir, job, tab, index),
  );
  return writeIndex(dir, results, job);
}

type PageOutcome = NotCollectedReason | "failed" | "collected";

function reasonOf(result: CollectedPage): NotCollectedReason | undefined {
  if (result.reason) return result.reason;
  return result.status !== undefined && result.status >= 400 ? "http-error" : undefined;
}

function pageOutcome(result: CollectedPage): PageOutcome {
  return reasonOf(result) ?? (result.error ? "failed" : "collected");
}

function tally(results: CollectedPage[]) {
  const count = (outcome: PageOutcome) =>
    results.filter((result) => pageOutcome(result) === outcome).length;
  return {
    collected: count("collected"),
    httpErrors: count("http-error"),
    challenges: count("challenge"),
    blocked: count("blocked"),
    noContent: count("no-content"),
    failed: count("failed"),
  };
}

const counted = (count: number, one: string, many = one) =>
  count ? [`${count} ${count === 1 ? one : many}`] : [];

function notCountedLine(results: CollectedPage[]) {
  const counts = tally(results);
  const statuses = results
    .filter((result) => pageOutcome(result) === "http-error")
    .map((result) => result.status)
    .join(", ");
  const parts = [
    ...counted(counts.httpErrors, `HTTP error (${statuses})`, `HTTP errors (${statuses})`),
    ...counted(counts.challenges, "challenge", "challenges"),
    ...counted(counts.blocked, "blocked"),
    ...counted(counts.noContent, "answered with no content"),
    ...counted(counts.failed, "failed"),
  ];
  return parts.length ? [`Not counted: ${parts.join(", ")}.`] : [];
}

export function collectSummary(dir: string, results: CollectedPage[]) {
  return {
    dir,
    ...tally(results),
    total: results.length,
    pages: results.map((result) => ({
      index: result.index,
      url: shownUrl(result.url),
      finalUrl: result.finalUrl === undefined ? undefined : shownUrl(result.finalUrl),
      status: result.status,
      statusNote: result.statusNote,
      title: result.title,
      type: result.type,
      bytes: result.bytes,
      note: result.note,
      scrolled: result.scrolled,
      unsettledMs: result.unsettledMs,
      chars: result.chars,
      files: result.files,
      preview: result.preview,
      data: result.data,
      error: result.error,
      reason: reasonOf(result),
    })),
  };
}

const INDEX_LINES =
  "Each line: number, HTTP status, final URL, title (or [content type] for PDFs, JSON, images and other files, which are saved as they are), text length, files.";
const READ_FILES = "Read or grep the files for the content; index.json has the same list.";

function indexText(dir: string, results: CollectedPage[], legend: string, shown: string) {
  const { collected } = tally(results);
  return [
    `Collected ${collected} of ${results.length} pages into ${dir}`,
    ...notCountedLine(results),
    legend,
    shown,
  ].join("\n");
}

export function collectIndexFrame(dir: string, results: CollectedPage[]) {
  return (shown: string) => indexText(dir, results, READ_FILES, shown);
}

export function renderCollectIndex(dir: string, results: CollectedPage[]) {
  return indexText(dir, results, `${INDEX_LINES} ${READ_FILES}`, renderCollectLines(results));
}

function renderCollectLines(results: CollectedPage[]) {
  const lines: string[] = [];
  for (const result of results) {
    const number = String(result.index).padStart(2, "0");
    if (result.error) {
      const kept = result.files.length ? ` → ${result.files.join(", ")}` : "";
      const head = result.reason === "no-content" ? result.status : "FAILED";
      lines.push(`${number} ${head} ${shownUrl(result.url)} — ${result.error}${kept}`);
      continue;
    }
    const size =
      result.chars !== undefined
        ? ` ${result.chars} chars`
        : result.bytes !== undefined
          ? ` ${result.bytes} bytes`
          : "";
    const label = result.type ? `[${result.type}]` : `"${result.title ?? ""}"`;
    const marker =
      reasonOf(result) === "http-error" ? " — http error: not counted as collected" : "";
    lines.push(
      `${number} ${result.status ?? "-"} ${shownUrl(result.finalUrl ?? result.url)} ${label}${size} → ${result.files.join(", ")}${marker}`,
    );
    if (result.statusNote) lines.push(`   status unknown: ${result.statusNote}`);
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
