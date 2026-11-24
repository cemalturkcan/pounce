import { z } from "zod";

const jsonValue = z.json();
export type JsonValue = z.infer<typeof jsonValue>;

type ValueNode =
  | { kind: "object"; start: number; end: number; members: MemberNode[] }
  | {
      kind: "other";
      start: number;
      end: number;
    };
type MemberNode = { key: string; keyStart: number; value: ValueNode };

export class JsoncError extends Error {}

class Scanner {
  position = 0;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  fail(what: string): never {
    throw new JsoncError(`${what} at offset ${this.position}`);
  }

  skipTrivia() {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "﻿") {
        this.position += 1;
      } else if (text.startsWith("//", this.position)) {
        const end = text.indexOf("\n", this.position);
        this.position = end === -1 ? text.length : end;
      } else if (text.startsWith("/*", this.position)) {
        const end = text.indexOf("*/", this.position + 2);
        if (end === -1) this.fail("Unclosed comment");
        this.position = end + 2;
      } else return;
    }
  }

  string() {
    const start = this.position;
    this.position += 1;
    while (this.position < this.text.length) {
      const char = this.text[this.position];
      if (char === "\\") this.position += 2;
      else if (char === '"') {
        this.position += 1;
        return {
          start,
          end: this.position,
          value: z.string().parse(JSON.parse(this.text.slice(start, this.position))),
        };
      } else this.position += 1;
    }
    return this.fail("Unclosed string");
  }

  value(): ValueNode {
    this.skipTrivia();
    const char = this.text[this.position];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') {
      const { start, end } = this.string();
      return { kind: "other", start, end };
    }
    const start = this.position;
    while (this.position < this.text.length && /[^\s,}\]/]/.test(this.text[this.position] ?? ""))
      this.position += 1;
    if (this.position === start) this.fail("Expected a value");
    return { kind: "other", start, end: this.position };
  }

  object(): ValueNode {
    const start = this.position;
    this.position += 1;
    const members: MemberNode[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.text[this.position] === "}") break;
      if (this.text[this.position] !== '"') this.fail("Expected a key");
      const key = this.string();
      this.skipTrivia();
      if (this.text[this.position] !== ":") this.fail("Expected a colon");
      this.position += 1;
      members.push({ key: key.value, keyStart: key.start, value: this.value() });
      this.skipTrivia();
      if (this.text[this.position] === ",") this.position += 1;
      else if (this.text[this.position] !== "}") this.fail("Expected a comma or }");
    }
    this.position += 1;
    return { kind: "object", start, end: this.position, members };
  }

  array(): ValueNode {
    const start = this.position;
    this.position += 1;
    for (;;) {
      this.skipTrivia();
      if (this.text[this.position] === "]") break;
      this.value();
      this.skipTrivia();
      if (this.text[this.position] === ",") this.position += 1;
      else if (this.text[this.position] !== "]") this.fail("Expected a comma or ]");
    }
    this.position += 1;
    return { kind: "other", start, end: this.position };
  }
}

function parseTree(text: string): Extract<ValueNode, { kind: "object" }> {
  const scanner = new Scanner(text);
  const root = scanner.value();
  scanner.skipTrivia();
  if (scanner.position !== text.length) scanner.fail("Unexpected text after the document");
  if (root.kind !== "object") throw new JsoncError("The document is not an object");
  return root;
}

function lineStart(text: string, offset: number) {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function indentAt(text: string, offset: number) {
  const start = lineStart(text, offset);
  return /^[ \t]*/.exec(text.slice(start, offset))?.[0] ?? "";
}

function ownsLine(text: string, offset: number) {
  return text.slice(lineStart(text, offset), offset).trim() === "";
}

function indentUnit(text: string) {
  const indents = text
    .split("\n")
    .map((line) => /^([ \t]+)\S/.exec(line)?.[1])
    .filter((indent): indent is string => indent !== undefined);
  if (indents.some((indent) => indent.startsWith("\t"))) return "\t";
  const widths = indents.map((indent) => indent.length);
  return " ".repeat(widths.length ? widths.reduce((least, width) => Math.min(least, width)) : 2);
}

function render(value: JsonValue, unit: string, indent: string) {
  return JSON.stringify(value, null, unit).replaceAll("\n", `\n${indent}`);
}

function nest(keys: string[], value: JsonValue): JsonValue {
  return keys.reduceRight<JsonValue>((inner, key) => ({ [key]: inner }), value);
}

function endOfLineComment(text: string, offset: number) {
  const rest = /^[ \t]*\/\/[^\n]*/.exec(text.slice(offset));
  return rest ? offset + rest[0].length : offset;
}

function insertMember(
  text: string,
  object: Extract<ValueNode, { kind: "object" }>,
  key: string,
  value: JsonValue,
) {
  const unit = indentUnit(text);
  const objectIndent = indentAt(text, object.start);
  const inline =
    !text.slice(object.start, object.end).includes("\n") &&
    (object.members.length > 0 || !text.trim().includes("\n"));
  const last = object.members.at(-1);
  if (inline) {
    const member = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    if (!last) return `${text.slice(0, object.start + 1)}${member}${text.slice(object.end - 1)}`;
    return `${text.slice(0, last.value.end)}, ${member}${text.slice(last.value.end)}`;
  }
  const first = object.members[0];
  const memberIndent =
    first && ownsLine(text, first.keyStart) ? indentAt(text, first.keyStart) : objectIndent + unit;
  const member = `${JSON.stringify(key)}: ${render(value, unit, memberIndent)}`;
  if (!last) {
    const inner = text.slice(object.start + 1, object.end - 1);
    const tail = inner.trim() === "" ? `\n${objectIndent}` : inner;
    return `${text.slice(0, object.start + 1)}\n${memberIndent}${member}${tail}${text.slice(object.end - 1)}`;
  }
  const scanner = new Scanner(text);
  scanner.position = last.value.end;
  scanner.skipTrivia();
  const trailingComma = text[scanner.position] === ",";
  if (trailingComma) {
    const at = endOfLineComment(text, scanner.position + 1);
    return `${text.slice(0, at)}\n${memberIndent}${member},${text.slice(at)}`;
  }
  const at = endOfLineComment(text, last.value.end);
  const comment = text.slice(last.value.end, at);
  return `${text.slice(0, last.value.end)},${comment}\n${memberIndent}${member}${text.slice(at)}`;
}

function onlyTrivia(text: string) {
  const scanner = new Scanner(text);
  scanner.skipTrivia();
  return scanner.position === text.length;
}

function withEmptyObject(text: string) {
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}{}\n`;
}

export function setJsoncMember(text: string, keys: readonly string[], value: JsonValue): string {
  const source = onlyTrivia(text) ? withEmptyObject(text.trim() === "" ? "" : text) : text;
  let object = parseTree(source);
  let depth = 0;
  for (; depth < keys.length - 1; depth += 1) {
    const member = object.members.find((candidate) => candidate.key === keys[depth]);
    if (!member) break;
    if (member.value.kind !== "object")
      throw new JsoncError(`${keys.slice(0, depth + 1).join(".")} is not an object`);
    object = member.value;
  }
  const [key = "", ...rest] = keys.slice(depth);
  const existing =
    rest.length === 0 ? object.members.find((member) => member.key === key) : undefined;
  if (!existing) return insertMember(source, object, key, nest(rest, value));
  const unit = indentUnit(source);
  const indent = ownsLine(source, existing.keyStart) ? indentAt(source, existing.keyStart) : "";
  const rendered =
    source.slice(existing.value.start, existing.value.end).includes("\n") || indent
      ? render(value, unit, indent)
      : JSON.stringify(value);
  return `${source.slice(0, existing.value.start)}${rendered}${source.slice(existing.value.end)}`;
}

function memberLineEnd(text: string, member: MemberNode) {
  const comma = /^[ \t]*,?/.exec(text.slice(member.value.end))?.[0].length ?? 0;
  const at = endOfLineComment(text, member.value.end + comma);
  const newline = /^[ \t\r]*\n/.exec(text.slice(at));
  return newline ? at + newline[0].length : at;
}

function commaAfter(text: string, offset: number) {
  const scanner = new Scanner(text);
  scanner.position = offset;
  scanner.skipTrivia();
  return text[scanner.position] === "," ? scanner.position : undefined;
}

function removalCuts(text: string, members: MemberNode[], index: number) {
  const member = members[index];
  const next = members[index + 1];
  const previous = members[index - 1];
  if (!member) return undefined;
  const ownLine = ownsLine(text, member.keyStart);
  const start = ownLine ? lineStart(text, member.keyStart) : member.keyStart;
  if (next) {
    if (!ownsLine(text, next.keyStart)) return [{ start, end: next.keyStart }];
    return [{ start, end: Math.min(memberLineEnd(text, member), lineStart(text, next.keyStart)) }];
  }
  if (!previous) return undefined;
  if (!ownLine) return [{ start: previous.value.end, end: member.value.end }];
  const cut = { start, end: memberLineEnd(text, member) };
  const comma = commaAfter(text, previous.value.end);
  if (comma === undefined || commaAfter(text, member.value.end) !== undefined) return [cut];
  return [cut, { start: comma, end: comma + 1 }];
}

export function removeJsoncMember(text: string, keys: readonly string[]): string {
  let object = parseTree(text);
  for (const key of keys.slice(0, -1)) {
    const member = object.members.find((candidate) => candidate.key === key);
    if (member?.value.kind !== "object") return text;
    object = member.value;
  }
  const index = object.members.findIndex((member) => member.key === keys.at(-1));
  if (index === -1) return text;
  const cuts = removalCuts(text, object.members, index) ?? [
    { start: object.start + 1, end: object.end - 1 },
  ];
  return cuts.reduce((kept, cut) => `${kept.slice(0, cut.start)}${kept.slice(cut.end)}`, text);
}

export function parseJsonc(text: string): JsonValue {
  if (onlyTrivia(text)) return {};
  parseTree(text);
  return jsonValue.parse(Bun.JSONC.parse(text));
}
