import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TAB_COUNTER_FILE = "tab-counter.json";
export const RANDOM_BASE_MIN = 100_000;
const RANDOM_BASE_SPAN = 900_000;
const DEFAULT_BLOCK = 50;

type CounterOptions = { block?: number; random?: () => number };

function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  renameSync(temporary, file);
}

function readReserved(file: string) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { reserved?: unknown };
    const reserved = parsed.reserved;
    return typeof reserved === "number" && Number.isSafeInteger(reserved) && reserved >= 0 ? reserved : undefined;
  } catch {
    return undefined;
  }
}

export class TabCounter {
  private readonly file: string;
  private readonly block: number;
  private readonly random: () => number;
  private last?: number;
  private reserved = 0;

  constructor(dataDir: string, options: CounterOptions = {}) {
    this.file = path.join(dataDir, TAB_COUNTER_FILE);
    this.block = Math.max(1, options.block ?? DEFAULT_BLOCK);
    this.random = options.random ?? Math.random;
  }

  next() {
    if (this.last === undefined) {
      const saved = readReserved(this.file);
      this.last = saved ?? RANDOM_BASE_MIN + Math.floor(this.random() * RANDOM_BASE_SPAN);
      this.reserved = this.last;
    }
    this.last += 1;
    if (this.last > this.reserved) this.reserve(this.last + this.block - 1);
    return `t${this.last}`;
  }

  private reserve(upTo: number) {
    this.reserved = upTo;
    try {
      writeJsonAtomic(this.file, { reserved: upTo });
    } catch {
      return;
    }
  }
}

export const TAB_HISTORY_FILE = "tab-history.json";
const HISTORY_LIMIT = 200;
const HISTORY_SAVE_DELAY_MS = 1000;

export type TabEnd = "closed" | "closed-outside" | "restart";
export type TabSighting = { id: string; url: string; title?: string };
export type KnownTab = TabSighting & { end: TabEnd };

const END_TEXT: Record<TabEnd, string> = {
  closed: "it was closed",
  "closed-outside": "it was closed outside this session",
  restart: "it was open before the daemon restarted, and tab ids are never reused",
};

export function describeMissingTab(id: string, known: KnownTab | undefined) {
  if (!known) return `Tab ${id} is not open.`;
  const title = known.title ? ` ${JSON.stringify(known.title)}` : "";
  return `Tab ${id} is not open (it was at ${known.url}${title}); ${END_TEXT[known.end]}.`;
}

function isKnownTab(value: unknown): value is KnownTab {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.url === "string" && (entry.title === undefined || typeof entry.title === "string") && typeof entry.end === "string" && entry.end in END_TEXT;
}

type HistoryOptions = { limit?: number; delayMs?: number };

export class TabHistory {
  private readonly file: string;
  private readonly limit: number;
  private readonly delayMs: number;
  private readonly live: () => TabSighting[];
  private entries?: Map<string, KnownTab>;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string, live: () => TabSighting[], options: HistoryOptions = {}) {
    this.file = path.join(dataDir, TAB_HISTORY_FILE);
    this.live = live;
    this.limit = Math.max(1, options.limit ?? HISTORY_LIMIT);
    this.delayMs = options.delayMs ?? HISTORY_SAVE_DELAY_MS;
  }

  find(id: string) {
    return this.loaded().get(id);
  }

  closed(tab: TabSighting, end: TabEnd) {
    const entries = this.loaded();
    entries.delete(tab.id);
    entries.set(tab.id, { id: tab.id, url: tab.url, title: tab.title || undefined, end });
    while (entries.size > this.limit) entries.delete(entries.keys().next().value ?? "");
    this.changed();
  }

  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref();
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const open = this.live().map((tab): KnownTab => ({ id: tab.id, url: tab.url, title: tab.title || undefined, end: "restart" }));
    const openIds = new Set(open.map((tab) => tab.id));
    const closed = [...this.loaded().values()].filter((entry) => !openIds.has(entry.id));
    try {
      writeJsonAtomic(this.file, { tabs: [...closed, ...open].slice(-this.limit) });
    } catch {
      return;
    }
  }

  private loaded() {
    if (this.entries) return this.entries;
    this.entries = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { tabs?: unknown };
      const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isKnownTab) : [];
      for (const tab of tabs.slice(-this.limit)) this.entries.set(tab.id, { id: tab.id, url: tab.url, title: tab.title, end: tab.end });
    } catch {
      return this.entries;
    }
    return this.entries;
  }
}
