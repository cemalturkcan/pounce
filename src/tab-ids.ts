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
