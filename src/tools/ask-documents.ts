import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  capturePageImages,
  describePageImages,
  pageImageNotes,
  type ImageMode,
  type PageImages,
  type RegionRequest,
} from "../ask/images.ts";
import { sourceNames } from "../ask/run.ts";
import type { AskDocument, AskMode } from "../ask/types.ts";
import type { PageLocation } from "../browse/browse-pages.ts";
import type { Tab } from "../browser/tab.ts";
import {
  type CollectedIndexEntry,
  collectedBase,
  collectedIndex,
  collectPages,
} from "../page/collect.ts";
import { pageMarkdown } from "../page/markdown.ts";
import { DEFAULT_MAX_WAIT_MS, DEFAULT_QUIET_MS } from "../page/settle.ts";
import { inSequence } from "../shared/async.ts";
import { cancelled, ToolError } from "../shared/errors.ts";
import { shownUrl } from "../shared/output.ts";
import type { ToolDeps } from "./common.ts";

type DocumentRequest = {
  files?: string[];
  dir?: string;
  urls?: string[];
  tabs?: string[];
  mode: AskMode;
  images?: ImageMode;
  regions?: RegionRequest[];
};

const isMarkdown = (name: string) => /\.(?:md|markdown)$/i.test(name);

const headerUrl = (text: string) => /^<!-- URL: (\S+) · Status:/.exec(text)?.[1];

export const describeNotLoaded = ({ url, reason }: { url: string; reason: string }) =>
  `Not loaded: ${shownUrl(url)} — ${reason}`;

export async function gatherDocuments(
  deps: ToolDeps,
  owner: string,
  signal: AbortSignal,
  input: DocumentRequest,
) {
  const { manager, store } = deps;
  const documents: AskDocument[] = [];
  const locations = new Map<string, PageLocation>();
  const locate = (source: string, url: string, tab?: Tab) => {
    const location: PageLocation = { url };
    if (tab) location.tab = tab;
    locations.set(deps.redactor.redact(source), location);
  };
  const { mode } = input;
  const imageMode = input.images ?? (mode === "review" ? "full" : "auto");
  const regions = input.regions ?? [];
  const wantsImages = imageMode !== "none" || regions.length > 0;
  const shots = new Map<string, PageImages>();
  const imageLines: string[] = [];
  const imageNotes: string[] = [];
  const notLoaded: { url: string; reason: string }[] = [];
  let imageDir: string | undefined;
  if (input.files) {
    const names = sourceNames(input.files);
    await inSequence(input.files, async (file, index) => {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text === undefined)
        throw new ToolError(`Cannot read ${file}.`, "Pass absolute paths of existing text files.");
      const source = names[index] ?? path.basename(file);
      const url = headerUrl(text);
      if (url) locate(source, url);
      documents.push({ source, text, plain: !isMarkdown(file) });
    });
  } else if (input.dir || input.urls) {
    let dir = input.dir;
    let pages: CollectedIndexEntry[] | undefined;
    if (!dir) {
      const collected = await collectPages(manager, store, owner, {
        urls: input.urls ?? [],
        include: ["markdown"],
        scope: "main",
        concurrency: 6,
        waitUntil: "domcontentloaded",
        settleMs: DEFAULT_QUIET_MS,
        maxWaitMs: DEFAULT_MAX_WAIT_MS,
        timeoutMs: 30_000,
        fullPage: false,
        previewChars: 0,
        label: "ask",
        signal,
        capture: wantsImages
          ? async (tab, base, outputDir) => {
              imageDir = outputDir;
              const captured = await capturePageImages(manager, tab, {
                mode: imageMode,
                regions,
                source: `${base}.md`,
                dir: outputDir,
                base,
              });
              shots.set(`${base}.md`, captured);
              return captured.files.map((file) => path.basename(file));
            }
          : undefined,
      });
      if (signal.aborted) throw cancelled();
      dir = collected.dir;
      pages = collected.results;
    }
    const names = await readdir(dir).catch(() => undefined);
    if (!names) throw new ToolError(`Cannot read the folder ${dir}.`);
    pages ??= await readFile(path.join(dir, "index.json"), "utf8")
      .then(collectedIndex)
      .catch(() => undefined);
    const failed = (pages ?? []).filter((page) => page.error);
    notLoaded.push(...failed.map((page) => ({ url: page.url, reason: page.error ?? "" })));
    const failedBases = new Set(failed.map(collectedBase));
    for (const base of failedBases) shots.delete(`${base}.md`);
    const markdown = new Set(
      names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)),
    );
    const picked = names
      .filter(
        (name) =>
          name.endsWith(".md") || (name.endsWith(".txt") && !markdown.has(name.slice(0, -4))),
      )
      .filter((name) => !failedBases.has(name.replace(/\.(?:md|txt)$/, "")))
      .toSorted();
    if (pages?.length && failed.length === pages.length)
      throw new ToolError(
        `No page loaded, so nothing was asked.\n${notLoaded.map(describeNotLoaded).join("\n")}`,
      );
    if (picked.length === 0)
      throw new ToolError(
        `No .md or .txt files in ${dir}.`,
        'Save the pages with save_pages and include ["markdown"] or ["text"] first.',
      );
    for (const page of pages ?? []) {
      if (page.error) continue;
      const base = collectedBase(page);
      for (const name of [`${base}.md`, `${base}.txt`]) locate(name, page.finalUrl ?? page.url);
    }
    const pickedDir = dir;
    await inSequence(picked, async (name) => {
      const text = await readFile(path.join(pickedDir, name), "utf8");
      const url = headerUrl(text);
      if (url && !locations.has(deps.redactor.redact(name))) locate(name, url);
      documents.push({
        source: name,
        text,
        images: shots.get(name)?.images,
        plain: !isMarkdown(name),
      });
    });
  } else {
    await inSequence(input.tabs ?? [], async (id) => {
      const tab = manager.getTab(id);
      const source = `${tab.id} ${shownUrl(tab.page.url())}`;
      const text = await pageMarkdown(tab.page, "main");
      let images: PageImages | undefined;
      if (wantsImages) {
        imageDir ??= (await store.uniqueDir("ask", "screenshots")).dir;
        images = await capturePageImages(manager, tab, {
          mode: imageMode,
          regions,
          source,
          dir: imageDir,
          base: tab.id,
        });
        shots.set(source, images);
      }
      locate(source, tab.page.url(), tab);
      documents.push({ source, text, images: images?.images });
    });
  }
  if (
    (input.files || input.dir) &&
    (input.images === "viewport" || input.images === "full" || regions.length || mode === "review")
  )
    imageNotes.push("images and regions apply to tabs and urls only, so no screenshots were sent.");
  for (const [source, captured] of shots) {
    imageLines.push(...describePageImages(source, captured));
    imageNotes.push(...pageImageNotes(source, captured));
  }
  if (documents.every((document) => !document.text.trim() && !document.images?.length))
    throw new ToolError(
      `All pages are empty: ${documents.map((document) => document.source).join(", ")}.`,
    );
  return { documents, locations, shots, imageLines, imageNotes, notLoaded, imageDir };
}
