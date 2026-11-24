import type { Frame, Locator } from "playwright-core";
import { z } from "zod";
import type { TIMED_OUT } from "../shared/async.ts";
import { parseJson } from "../shared/decode.ts";

const REF_PATTERN = /^(?:f\d+)?e\d+$/;

export function parseRef(target: string) {
  const cleaned = target
    .trim()
    .replace(/^@/, "")
    .replace(/^\[?ref=([^\]\s]+)\]?$/, "$1");
  return REF_PATTERN.test(cleaned) ? cleaned : undefined;
}

export const ACTIONABLE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

const CONTEXT_ROLES = new Set([
  "row",
  "listitem",
  "article",
  "group",
  "dialog",
  "alertdialog",
  "form",
]);
const CONTEXT_NAME_CHARS = 60;

export type ElementContext = { role: string; name: string };

export type Place = { document: number; href: string };

export type RefIdentity = { role: string; name: string; line: string; frameRef?: string };

export type IssuedRef = RefIdentity & {
  loads: number;
  url: string;
  document?: number;
  href?: string;
  token: string;
  path: string[];
  bound: Promise<boolean>;
  frame?: Frame;
  content?: Promise<Place | undefined | typeof TIMED_OUT>;
};

export type LineElement = { role: string; name: string | undefined; inline: string | undefined };

const ELEMENT_LINE = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*):?(?: (.*))?$/;

export const indentOf = (line: string) => line.length - line.trimStart().length;

export function unwrappedLine(line: string) {
  const item = line.trim().replace(/^- /, "");
  const quoted = /^'(.*)'(:?)$/.exec(item);
  return quoted ? `${quoted[1]?.replaceAll("''", "'")}${quoted[2]}` : item;
}

export function lineElement(line: string): LineElement | undefined {
  const match = ELEMENT_LINE.exec(unwrappedLine(line));
  if (!match) return undefined;
  const [, role = "", rawName, , inline] = match;
  return {
    role,
    name: rawName === undefined ? undefined : unquote(rawName),
    inline: inline?.startsWith('"') ? unquote(inline.slice(1, -1)) : inline || undefined,
  };
}

export function subtreeEnd(lines: string[], start: number) {
  const base = indentOf(lines[start] ?? "");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() && indentOf(line) <= base) break;
    end += 1;
  }
  return end;
}

function subtreeText(lines: string[], start: number) {
  const parts: string[] = [];
  const end = subtreeEnd(lines, start);
  let index = start + 1;
  while (index < end) {
    const element = lineElement(lines[index] ?? "");
    const control =
      element === undefined || (ACTIONABLE_ROLES.has(element.role) && element.role !== "link");
    const text = control ? undefined : (element.name ?? element.inline);
    if (text) parts.push(text);
    index = control || text || element.role === "link" ? subtreeEnd(lines, index) : index + 1;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function lineContexts(lines: string[]) {
  const names = new Map<number, ElementContext | undefined>();
  const contextAt = (index: number) => {
    if (!names.has(index)) {
      const element = lineElement(lines[index] ?? "");
      const name = [element?.name, subtreeText(lines, index)].filter(Boolean).join(" ");
      names.set(index, element ? { role: element.role, name } : undefined);
    }
    return names.get(index);
  };
  const holders: number[] = [];
  return lines.map((line, index) => {
    while (holders.length > 0 && indentOf(lines[holders.at(-1) ?? 0] ?? "") >= indentOf(line))
      holders.pop();
    const holder = holders.at(-1);
    if (CONTEXT_ROLES.has(lineElement(line)?.role ?? "")) holders.push(index);
    return holder === undefined ? undefined : contextAt(holder);
  });
}

export const shortName = (name: string, maxChars: number) =>
  name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;

export const contextLabel = (context: ElementContext) =>
  context.name
    ? `${context.role} ${JSON.stringify(shortName(context.name, CONTEXT_NAME_CHARS))}`
    : context.role;

export const elementLabel = (identity: RefIdentity) =>
  identity.name ? `${identity.role} ${JSON.stringify(identity.name)}` : identity.role;

const REF_LINE = /^(\s*)- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(?:.*?)\[ref=([^\]\s]+)\]/;
const IFRAME_LINE = /^(\s*)- '?iframe\b.*?\[ref=([^\]\s]+)\]/;

function unquote(name: string) {
  const parsed = parseJson(`"${name}"`, z.string());
  return parsed.success ? parsed.data : name;
}

const LABEL_LINE =
  /^\s*- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=([^\]\s]+)\][^:\n]*(?::\s*(.*))?$/;
const LABEL_NAME_CHARS = 80;
export const VALUE_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "slider"]);

const shorten = (name: string) => shortName(name, LABEL_NAME_CHARS);

export function labelledByText(snapshotLine: string) {
  const match = LABEL_LINE.exec(snapshotLine);
  if (!match) return false;
  const [, role = "", rawName, , inlineText] = match;
  return rawName === undefined && !VALUE_ROLES.has(role) && Boolean(inlineText?.trim());
}

export function targetLabel(snapshotLine: string, target: string) {
  const match = LABEL_LINE.exec(snapshotLine);
  if (!match) return target;
  const [, role = "", rawName, ref = "", inlineText] = match;
  const name =
    rawName === undefined
      ? VALUE_ROLES.has(role)
        ? undefined
        : inlineText?.trim()
      : unquote(rawName);
  const where = parseRef(target) ? ref : `${ref}, from ${target}`;
  return `${role}${name ? ` ${JSON.stringify(shorten(name))}` : ""} (${where})`;
}

export function refIdentities(snapshot: string) {
  const frames: { indent: number; ref: string }[] = [];
  const identities = new Map<string, RefIdentity>();
  for (const line of snapshot.split("\n")) {
    const indent = indentOf(line);
    while (frames.length > 0 && (frames.at(-1)?.indent ?? 0) >= indent) frames.pop();
    const found = REF_LINE.exec(line);
    if (found) {
      const [, , role = "", rawName, ref = ""] = found;
      const frameRef = frames.at(-1)?.ref;
      const identity: RefIdentity = {
        role,
        name: rawName === undefined ? "" : unquote(rawName),
        line,
      };
      if (frameRef) identity.frameRef = frameRef;
      identities.set(ref, identity);
    }
    const iframe = IFRAME_LINE.exec(line);
    if (iframe) frames.push({ indent, ref: iframe[2] ?? "" });
  }
  return identities;
}

export const checkedLines = new WeakMap<Locator, string>();

export function sameElement(issued: RefIdentity | undefined, now: RefIdentity | undefined) {
  return (
    issued !== undefined &&
    issued.role === now?.role &&
    (issued.name === "" || issued.name === now.name)
  );
}

export function dropOldLoads(refs: Map<string, IssuedRef>, loads: number) {
  for (const [ref, issued] of refs) if (issued.loads < loads - 1) refs.delete(ref);
}
