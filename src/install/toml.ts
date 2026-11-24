import { z } from "zod";
import type { JsonValue } from "./jsonc.ts";

const jsonValue = z.json();

class TomlError extends Error {}

export function parseToml(text: string): JsonValue {
  try {
    return jsonValue.parse(Bun.TOML.parse(text));
  } catch (cause) {
    throw new TomlError(cause instanceof Error ? cause.message : String(cause));
  }
}

function tableBlock(header: string, entry: Record<string, JsonValue>) {
  const lines = Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  return `[${header}]\n${lines.join("\n")}\n`;
}

function escapeHeader(header: string) {
  return header.replaceAll(".", "\\.");
}

function commentsAbove(text: string, header: number, floor: number) {
  let start = header;
  while (start > floor) {
    const previous = text.lastIndexOf("\n", start - 2) + 1;
    if (previous < floor || !/^[ \t]*#/.test(text.slice(previous, start - 1))) return start;
    start = previous;
  }
  return start;
}

function tableRange(text: string, keys: readonly string[]) {
  const found = new RegExp(
    `^[ \\t]*\\[${escapeHeader(keys.join("."))}\\][ \\t]*(#[^\\n]*)?$`,
    "m",
  ).exec(text);
  if (!found) return undefined;
  const bodyStart = found.index + found[0].length + 1;
  const next = /^[ \t]*\[/m.exec(text.slice(bodyStart));
  return {
    start: found.index,
    end: next ? commentsAbove(text, bodyStart + next.index, bodyStart) : text.length,
    last: next === null,
  };
}

export function setTomlTable(
  text: string,
  keys: readonly string[],
  entry: Record<string, JsonValue>,
) {
  const block = tableBlock(keys.join("."), entry);
  const range = tableRange(text, keys);
  if (!range) {
    const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}`;
  }
  const trailing = range.last ? "" : "\n";
  return `${text.slice(0, range.start)}${block}${trailing}${text.slice(range.end)}`;
}

export function removeTomlTable(text: string, keys: readonly string[]) {
  const range = tableRange(text, keys);
  return range ? `${text.slice(0, range.start)}${text.slice(range.end)}` : text;
}
