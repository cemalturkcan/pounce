import { z } from "zod";
import type { JsonValue } from "./jsonc.ts";

const jsonValue = z.json();

export class TomlError extends Error {}

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

export function setTomlTable(
  text: string,
  keys: readonly string[],
  entry: Record<string, JsonValue>,
) {
  const header = keys.join(".");
  const block = tableBlock(header, entry);
  const found = new RegExp(`^[ \\t]*\\[${escapeHeader(header)}\\][ \\t]*(#[^\\n]*)?$`, "m").exec(
    text,
  );
  if (!found) {
    const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}${block}`;
  }
  const bodyStart = found.index + found[0].length + 1;
  const next = /^[ \t]*\[/m.exec(text.slice(bodyStart));
  const end = next ? bodyStart + next.index : text.length;
  const trailing = next ? "\n" : "";
  return `${text.slice(0, found.index)}${block}${trailing}${text.slice(end)}`;
}
