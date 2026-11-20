import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserManager } from "./browser.ts";
import { describeError } from "./errors.ts";
import { extractPage, summarizeStructured } from "./extract.ts";
import { pageMarkdown } from "./markdown.ts";
import { slugify, timestampSlug, type OutputStore } from "./output.ts";
import { pageLinks, pageText, rawSnapshot, sleep } from "./page.ts";

export type CollectPart = "text" | "markdown" | "links" | "snapshot" | "screenshot" | "structured";

export type CollectInput = {
  urls: string[];
  include: CollectPart[];
  scope: "main" | "page";
  concurrency: number;
  waitUntil: "commit" | "domcontentloaded" | "load";
  settleMs: number;
  timeoutMs: number;
  fullPage: boolean;
  previewChars: number;
  label?: string;
};

export type CollectedPage = {
  index: number;
  url: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  chars?: number;
  links?: number;
  files: string[];
  preview?: string;
  data?: string;
  error?: string;
};

const LINK_LIMIT = 500;

export function normalizeUrl(url: string) {
  const trimmed = url.trim();
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function collectOne(
  manager: BrowserManager,
  owner: string,
  dir: string,
  input: CollectInput,
  url: string,
  index: number,
): Promise<CollectedPage> {
  const base = `${String(index + 1).padStart(2, "0")}-${slugify(url)}`;
  const result: CollectedPage = { index: index + 1, url, files: [] };
  const tab = await manager.openTab(owner);
  const { page } = tab;

  try {
    const response = await page.goto(url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
    if (input.settleMs > 0) await sleep(input.settleMs);
    result.status = response?.status();
    result.finalUrl = page.url();
    result.title = await page.title().catch(() => undefined);

    if (input.include.includes("text")) {
      const text = await pageText(page, input.scope);
      result.chars = text.length;
      result.preview = text.slice(0, input.previewChars).replace(/\s+/g, " ");
      const header = `URL: ${result.finalUrl}\nTitle: ${result.title ?? ""}\nStatus: ${result.status ?? ""}\n\n`;
      await writeFile(path.join(dir, `${base}.txt`), header + text);
      result.files.push(`${base}.txt`);
    }
    if (input.include.includes("markdown")) {
      const markdown = await pageMarkdown(page, input.scope);
      if (result.chars === undefined) {
        result.chars = markdown.length;
        result.preview = markdown.slice(0, input.previewChars).replace(/\s+/g, " ");
      }
      const header = `<!-- URL: ${result.finalUrl} · Status: ${result.status ?? ""} -->\n# ${result.title ?? ""}\n\n`;
      await writeFile(path.join(dir, `${base}.md`), header + markdown);
      result.files.push(`${base}.md`);
    }
    if (input.include.includes("links")) {
      const links = await pageLinks(page, LINK_LIMIT);
      result.links = links.length;
      await writeFile(path.join(dir, `${base}.links.tsv`), links.map((link) => `${link.url}\t${link.text}`).join("\n"));
      result.files.push(`${base}.links.tsv`);
    }
    if (input.include.includes("structured")) {
      const data = await extractPage(page);
      result.data = summarizeStructured(data);
      await writeFile(path.join(dir, `${base}.data.json`), JSON.stringify(data, null, 2));
      result.files.push(`${base}.data.json`);
    }
    if (input.include.includes("snapshot")) {
      await writeFile(path.join(dir, `${base}.snapshot.yml`), await rawSnapshot(manager, tab, {}));
      result.files.push(`${base}.snapshot.yml`);
    }
    if (input.include.includes("screenshot")) {
      const image = await page.screenshot({ type: "jpeg", quality: 70, fullPage: input.fullPage, scale: "css", timeout: input.timeoutMs });
      await writeFile(path.join(dir, `${base}.jpg`), image);
      result.files.push(`${base}.jpg`);
    }
  } catch (error) {
    result.error = describeError(error).split("\n")[0];
  } finally {
    await manager.closeTab(tab.id).catch(() => undefined);
  }
  return result;
}

export async function collectPages(manager: BrowserManager, store: OutputStore, owner: string, input: CollectInput) {
  const dir = await store.dir("collect", `${timestampSlug()}-${slugify(input.label ?? "pages", 40)}`);
  const urls = input.urls.map(normalizeUrl);
  const results: CollectedPage[] = new Array(urls.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await collectOne(manager, owner, dir, input, urls[index] ?? "", index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency, urls.length) }, worker));

  await writeFile(path.join(dir, "index.json"), JSON.stringify(results, null, 2));
  return { dir, results };
}

export function renderCollectIndex(dir: string, results: CollectedPage[]) {
  const failed = results.filter((result) => result.error).length;
  const lines = [
    `Collected ${results.length - failed} of ${results.length} pages into ${dir}`,
    "Each line: number, HTTP status, final URL, title, text length, files. Read or grep the files for the content; index.json has the same list.",
  ];
  for (const result of results) {
    const number = String(result.index).padStart(2, "0");
    if (result.error) {
      lines.push(`${number} FAILED ${result.url} — ${result.error}`);
      continue;
    }
    const size = result.chars === undefined ? "" : ` ${result.chars} chars`;
    lines.push(`${number} ${result.status ?? "-"} ${result.finalUrl} "${result.title ?? ""}"${size} → ${result.files.join(", ")}`);
    if (result.data) lines.push(`   ${result.data}`);
    if (result.preview) lines.push(`   ${result.preview}`);
  }
  return lines.join("\n");
}
