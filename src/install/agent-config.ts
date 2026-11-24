import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type JsonValue, parseJsonc, setJsoncMember } from "./jsonc.ts";
import { parseToml, setTomlTable } from "./toml.ts";

export type ConfigFormat = "json" | "toml";

export type EntryTarget = {
  file: string;
  format: ConfigFormat;
  keys: (current: JsonValue) => string[];
};

export type WriteOutcome = "added" | "updated" | "unchanged" | "conflict" | "manual";

const jsonObject = z.record(z.string(), z.json());

export class ConfigEditError extends Error {}

function valueAt(root: JsonValue, keys: readonly string[]): JsonValue | undefined {
  let node: JsonValue | undefined = root;
  for (const key of keys) {
    const object = jsonObject.safeParse(node);
    if (!object.success) return undefined;
    node = object.data[key];
  }
  return node;
}

function withValue(root: JsonValue, keys: readonly string[], value: JsonValue): JsonValue {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  const object = jsonObject.safeParse(root);
  const base = object.success ? object.data : {};
  return { ...base, [key]: withValue(base[key] ?? {}, rest, value) };
}

function isSymlink(file: string) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function realTarget(file: string) {
  const seen = new Set<string>();
  let current = file;
  while (isSymlink(current)) {
    if (seen.has(current)) throw new ConfigEditError(`${file} is a symlink loop.`);
    seen.add(current);
    current = path.resolve(path.dirname(current), readlinkSync(current));
  }
  return current;
}

function replaceFile(file: string, text: string, before: string | undefined) {
  const target = realTarget(file);
  mkdirSync(path.dirname(target), { recursive: true });
  const exists = existsSync(target);
  if (exists && readFileSync(target, "utf8") !== before)
    throw new ConfigEditError(`${file} changed while pounce was editing it; run install again.`);
  const mode = exists ? statSync(target).mode & 0o777 : 0o600;
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function parse(format: ConfigFormat, text: string) {
  return format === "toml" ? parseToml(text) : parseJsonc(text);
}

function reparsed(format: ConfigFormat, text: string) {
  try {
    return parse(format, text);
  } catch {
    return undefined;
  }
}

function edit(format: ConfigFormat, text: string, keys: string[], entry: JsonValue) {
  if (format === "json") return setJsoncMember(text, keys, entry);
  const table = jsonObject.safeParse(entry);
  if (!table.success) throw new ConfigEditError("A TOML entry must be a table.");
  return setTomlTable(text, keys, table.data);
}

export function readConfig(target: EntryTarget): JsonValue {
  const file = realTarget(target.file);
  return parse(target.format, existsSync(file) ? readFileSync(file, "utf8") : "");
}

export function writeEntry(
  target: EntryTarget,
  entry: JsonValue,
  owned: JsonValue | undefined,
): WriteOutcome {
  const file = realTarget(target.file);
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const current = parse(target.format, before ?? "");
  if (jsonObject.safeParse(current).success === false)
    throw new ConfigEditError(`${target.file} does not hold an object.`);
  const keys = target.keys(current);
  const existing = valueAt(current, keys);
  if (existing !== undefined && Bun.deepEquals(existing, entry, true)) return "unchanged";
  if (existing !== undefined && (owned === undefined || !Bun.deepEquals(existing, owned, true)))
    return "conflict";
  const after =
    before === undefined && target.format === "json"
      ? `${JSON.stringify(withValue(current, keys, entry), null, 2)}\n`
      : edit(target.format, before ?? "", keys, entry);
  if (!Bun.deepEquals(reparsed(target.format, after), withValue(current, keys, entry), true))
    return "manual";
  replaceFile(target.file, after, before);
  return existing === undefined ? "added" : "updated";
}
