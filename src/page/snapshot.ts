import {
  ACTIONABLE_ROLES,
  contextLabel,
  indentOf,
  lineContexts,
  lineElement,
  subtreeEnd,
  unwrappedLine,
  VALUE_ROLES,
} from "../browser/ref.ts";

const ROLE_PATTERN = /^\s*-\s+([a-z]+)/;

export function interactiveOnly(snapshot: string) {
  return snapshot
    .split("\n")
    .filter(isControl)
    .map((line) => line.trim().replace(/:$/, ""))
    .join("\n");
}

function refOfLine(line: string) {
  return /\[ref=([^\]\s]+)\]/.exec(line)?.[1];
}

export const shownRefs = (text: string) =>
  new Set(text.split("\n").flatMap((line) => refOfLine(line) ?? []));

export function topLevelRefs(snapshot: string) {
  const lines = snapshot.split("\n").filter((line) => line.trim());
  const minIndent = Math.min(...lines.map(indentOf));
  const refs: string[] = [];
  for (const line of lines) {
    if (indentOf(line) !== minIndent) continue;
    const ref = refOfLine(line);
    if (ref) refs.push(ref);
  }
  return refs;
}

function dedent(lines: string[]) {
  const base = indentOf(lines[0] ?? "");
  return lines
    .map((line) => line.slice(Math.min(base, indentOf(line))))
    .join("\n")
    .trimEnd();
}

export function cutSubtree(snapshot: string, ref: string) {
  const lines = snapshot.split("\n");
  const start = lines.findIndex((line) => refOfLine(line) === ref);
  if (start === -1) return undefined;
  return dedent(lines.slice(start, subtreeEnd(lines, start)));
}

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);

function roleOf(line: string) {
  return ROLE_PATTERN.exec(line)?.[1];
}

function isControl(line: string) {
  const role = roleOf(line);
  return role !== undefined && ACTIONABLE_ROLES.has(role) && line.includes("[ref=");
}

const INLINE_TEXT = /\]:\s*\S|^\s*- text:\s*\S/;

function isText(line: string) {
  const role = roleOf(line) ?? "";
  if (LANDMARK_ROLES.has(role) || isControl(line)) return false;
  return role === "heading" || INLINE_TEXT.test(line);
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

type Scoped = { text: string; note?: string };

function scopeRoots(lines: string[], dialogRefs: string[] | undefined) {
  if (dialogRefs?.length) {
    const starts = dialogRefs
      .map((ref) => lines.findIndex((line) => refOfLine(line) === ref))
      .filter((start) => start !== -1);
    if (starts.length > 0) return { label: "the open dialog", starts };
  }
  const mains = lines.flatMap((line, index) =>
    roleOf(line) === "main" && refOfLine(line) ? [index] : [],
  );
  return mains.length === 1 ? { label: "the main landmark", starts: mains } : undefined;
}

export function scopeSnapshot(snapshot: string, dialogRefs: string[] | undefined): Scoped {
  const lines = snapshot.split("\n");
  const roots = scopeRoots(lines, dialogRefs);
  if (!roots) return { text: snapshot };
  const ranges = roots.starts.map((start) => [start, subtreeEnd(lines, start)] as const);
  const inside = (index: number) => ranges.some(([start, end]) => index >= start && index < end);
  let landmarks = 0;
  let controls = 0;
  let texts = 0;
  lines.forEach((line, index) => {
    if (
      inside(index) ||
      ranges.some(([start]) => index < start && subtreeEnd(lines, index) > start)
    )
      return;
    if (LANDMARK_ROLES.has(roleOf(line) ?? "")) landmarks += 1;
    if (isControl(line)) controls += 1;
    if (isText(line)) texts += 1;
  });
  const counted = (
    [
      [landmarks, "landmark"],
      [controls, "control"],
      [texts, "text line"],
    ] as const
  ).filter(([count]) => count > 0);
  if (counted.length === 0) return { text: snapshot };
  const parts = counted.map(([count, word]) => plural(count, word));
  const left = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  const verb = counted.length === 1 && counted[0]?.[0] === 1 ? "is" : "are";
  return {
    text: ranges.map(([start, end]) => dedent(lines.slice(start, end))).join("\n"),
    note: `Scoped to ${roots.label}; ${left} outside it ${verb} not shown. Pass scope: "full" for the whole page.`,
  };
}

export function collapseNavigation(snapshot: string) {
  const lines = snapshot.split("\n");
  const kept: string[] = [];
  let collapsed = 0;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const end = roleOf(line) === "navigation" ? subtreeEnd(lines, index) : index + 1;
    const controls = lines.slice(index + 1, end).filter(isControl);
    if (controls.length > 0 && controls.every((control) => roleOf(control) === "link")) {
      kept.push(`${line.replace(/:$/, "")} [${plural(controls.length, "link")}, collapsed]`);
      collapsed += 1;
      index = end;
      continue;
    }
    kept.push(line);
    index += 1;
  }
  const text = kept.join("\n");
  if (collapsed === 0) return { text };
  return {
    text,
    note: `${plural(collapsed, "link-only navigation menu")} collapsed; pass a menu's ref as target to list its links.`,
  };
}

const URGENT_ROLES = new Set(["alert", "alertdialog", "dialog", "status"]);

function priorityOf(line: string, ancestors: string[]) {
  const roles = ancestors.map(roleOf);
  const role = roleOf(line);
  if (URGENT_ROLES.has(role ?? "") || roles.some((each) => URGENT_ROLES.has(each ?? ""))) return 0;
  if (role === "link" || roles.includes("link")) return 4;
  if (role === "heading") return 1;
  if (isControl(line)) return 2;
  return 3;
}

function ancestorIndexes(lines: string[]) {
  const stack: number[] = [];
  return lines.map((line, index) => {
    while (stack.length > 0 && indentOf(lines[stack.at(-1) ?? 0] ?? "") >= indentOf(line))
      stack.pop();
    const ancestors = [...stack];
    stack.push(index);
    return ancestors;
  });
}

export function clipByImportance(text: string, maxChars: number) {
  const lines = text.split("\n");
  if (text.length <= maxChars) return { text, kept: lines.length, total: lines.length };
  const ancestors = ancestorIndexes(lines);
  const order = lines
    .map((line, index) => ({
      index,
      priority: priorityOf(
        line,
        (ancestors[index] ?? []).map((ancestor) => lines[ancestor] ?? ""),
      ),
    }))
    .toSorted((left, right) => left.priority - right.priority || left.index - right.index);
  const keep = new Set<number>();
  let used = 0;
  for (const { index } of order) {
    const missing = [...(ancestors[index] ?? []), index].filter((each) => !keep.has(each));
    const cost = missing.reduce((sum, each) => sum + (lines[each] ?? "").length + 1, 0);
    if (used + cost > maxChars + 1) continue;
    used += cost;
    for (const each of missing) keep.add(each);
  }
  const picked = [...keep].toSorted((left, right) => left - right);
  return {
    text: picked.map((index) => lines[index]).join("\n"),
    kept: picked.length,
    total: lines.length,
  };
}

function comparableLines(text: string) {
  return text
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/ \[active\]/g, "")
        .replace(/ \[box=[^\]]*\]/g, ""),
    )
    .filter(Boolean);
}

type Edit = { kind: "+" | "-"; line: string; x: number; y: number };

function commonPrefix(before: string[], after: string[]) {
  let length = 0;
  while (length < before.length && length < after.length && before[length] === after[length])
    length += 1;
  return length;
}

function commonSuffix(before: string[], after: string[]) {
  let length = 0;
  while (
    length < before.length &&
    length < after.length &&
    before[before.length - 1 - length] === after[after.length - 1 - length]
  )
    length += 1;
  return length;
}

function lineEdits(before: string[], after: string[], x0 = 0, y0 = 0): Edit[] {
  const prefix = commonPrefix(before, after);
  const suffix = commonSuffix(before.slice(prefix), after.slice(prefix));
  const left = before.slice(prefix, before.length - suffix);
  const right = after.slice(prefix, after.length - suffix);
  const x = x0 + prefix;
  const y = y0 + prefix;
  const removed = left.map((line, index): Edit => ({ kind: "-", line, x: x + index, y }));
  const added = (from: number) =>
    right.map((line, index): Edit => ({ kind: "+", line, x: from, y: y + index }));
  if (left.length === 0) return added(x);
  if (right.length === 0) return removed;
  const split = middleSnake(left, right);
  if (!split) return [...removed, ...added(x + left.length)];
  const [splitX, splitY] = split;
  return [
    ...lineEdits(left.slice(0, splitX), right.slice(0, splitY), x, y),
    ...lineEdits(left.slice(splitX), right.slice(splitY), x + splitX, y + splitY),
  ];
}

function hunks(edits: Edit[]) {
  const groups: Edit[][] = [];
  let next: { x: number; y: number } | undefined;
  for (const edit of edits) {
    const group = groups.at(-1);
    if (group && next?.x === edit.x && next.y === edit.y) group.push(edit);
    else groups.push([edit]);
    next = edit.kind === "-" ? { x: edit.x + 1, y: edit.y } : { x: edit.x, y: edit.y + 1 };
  }
  return groups;
}

function middleSnake(before: string[], after: string[]): [number, number] | undefined {
  const n = before.length;
  const m = after.length;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const forward = new Int32Array(size).fill(-1);
  const backward = new Int32Array(size).fill(-1);
  forward[offset + 1] = 0;
  backward[offset + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d += 1) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1;
      let x1 =
        k1 === -d || (k1 !== d && (forward[k1Offset - 1] ?? -1) < (forward[k1Offset + 1] ?? -1))
          ? (forward[k1Offset + 1] ?? 0)
          : (forward[k1Offset - 1] ?? 0) + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && before[x1] === after[y1]) {
        x1 += 1;
        y1 += 1;
      }
      forward[k1Offset] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Offset = offset + delta - k1;
        const x2 = backward[k2Offset] ?? -1;
        if (k2Offset >= 0 && k2Offset < size && x2 !== -1 && x1 >= n - x2) return [x1, y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2;
      let x2 =
        k2 === -d || (k2 !== d && (backward[k2Offset - 1] ?? -1) < (backward[k2Offset + 1] ?? -1))
          ? (backward[k2Offset + 1] ?? 0)
          : (backward[k2Offset - 1] ?? 0) + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && before[n - x2 - 1] === after[m - y2 - 1]) {
        x2 += 1;
        y2 += 1;
      }
      backward[k2Offset] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Offset = offset + delta - k2;
        const x1 = forward[k1Offset] ?? -1;
        if (k1Offset >= 0 && k1Offset < size && x1 !== -1 && x1 >= n - x2)
          return [x1, offset + x1 - k1Offset];
      }
    }
  }
  return undefined;
}

const removedFirst = (edit: Edit) => (edit.kind === "-" ? 0 : 1);

export function changedLines(before: string, after: string) {
  return hunks(lineEdits(comparableLines(before), comparableLines(after))).flatMap((group) =>
    group
      .toSorted((left, right) => removedFirst(left) - removedFirst(right))
      .map((edit) => `${edit.kind} ${edit.line}`),
  );
}

const SNAPSHOT_CHANGES = "Snapshot changes (+ added, - removed):";

export function addedSnapshotLines(text: string) {
  const lines = text.split("\n");
  const start = lines.indexOf(SNAPSHOT_CHANGES);
  if (start === -1) return undefined;
  return lines
    .slice(start + 1)
    .flatMap((line) => (line.startsWith("+ ") ? [line.slice(2)] : []))
    .join("\n");
}

export function diffSnapshots(before: string, after: string, maxLines?: number) {
  const lines = changedLines(before, after);
  if (lines.length === 0) return "No lines of the snapshot changed.";
  const shown = lines.slice(0, maxLines);
  const more =
    lines.length > shown.length
      ? `\n… ${lines.length - shown.length} more changed lines; take a snapshot for the full page.`
      : "";
  return `${SNAPSHOT_CHANGES}\n${shown.join("\n")}${more}`;
}

export function limitDepth(snapshot: string, depth: number) {
  return snapshot
    .split("\n")
    .filter((line) => indentOf(line) / 2 < depth)
    .join("\n");
}

export function foldText(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");
}

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function containsWord(text: string, word: string) {
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1))
    if (!isWordChar(text[at - 1]) && !isWordChar(text[at + word.length])) return true;
  return false;
}

const EXACT = 0;
const WORD = 1;
const CONTAINS = 2;

function rankOf(line: string, needle: string) {
  const element = lineElement(line);
  const name = foldText(element?.name ?? element?.inline ?? "");
  if (name === needle || foldText(element?.role ?? "") === needle) return EXACT;
  return containsWord(name, needle) ? WORD : CONTAINS;
}

function ownerLine(lines: string[], index: number) {
  if (lineElement(lines[index] ?? "")) return index;
  const indent = indentOf(lines[index] ?? "");
  const owner = lines.findLastIndex(
    (line, before) => before < index && line.trim() !== "" && indentOf(line) < indent,
  );
  return owner === -1 ? index : owner;
}

function matchReason(line: string, own: boolean, matches: (text: string) => boolean) {
  if (!own) return /^\/([\w-]+):/.exec(unwrappedLine(line))?.[1];
  const element = lineElement(line);
  if (!element || !VALUE_ROLES.has(element.role)) return undefined;
  return element.inline !== undefined && matches(element.inline) ? "value" : undefined;
}

type FindOptions = { regex: boolean; maxResults: number };

type FindResult = {
  text: string;
  matches: number;
  shown: number;
};

export function findInSnapshot(
  snapshot: string,
  query: string,
  { regex, maxResults }: FindOptions,
): FindResult {
  const lines = snapshot.split("\n");
  const contexts = lineContexts(lines);
  const needle = foldText(query);
  const expression = regex ? new RegExp(query, "i") : undefined;
  const matches = (text: string) =>
    expression ? expression.test(text) : foldText(text).includes(needle);
  const reasons = new Map<number, Set<string>>();
  for (const [index, line] of lines.entries()) {
    if (!matches(line)) continue;
    const owner = ownerLine(lines, index);
    const why = reasons.get(owner) ?? new Set<string>();
    reasons.set(owner, why);
    const reason = matchReason(line, owner === index, matches);
    if (reason) why.add(reason);
  }
  const found = [...reasons.keys()]
    .map((index) => {
      const line = lines[index] ?? "";
      return {
        index,
        rank: expression ? EXACT : rankOf(line, needle),
        actionable: !expression && ACTIONABLE_ROLES.has(lineElement(line)?.role ?? ""),
      };
    })
    .toSorted(
      (left, right) =>
        left.rank - right.rank ||
        Number(right.actionable) - Number(left.actionable) ||
        left.index - right.index,
    );
  const shown = found.slice(0, maxResults);
  const resultLine = (index: number) => {
    const context = contexts[index];
    const line = unwrappedLine(lines[index] ?? "").replace(/:$/, "");
    const named = lineElement(lines[index] ?? "")?.name;
    const why = [...(reasons.get(index) ?? [])];
    const reason = why.length && !(named && matches(named)) ? ` (${why.join(", ")} matches)` : "";
    return context ? `${line}${reason} — in ${contextLabel(context)}` : `${line}${reason}`;
  };
  const ranked = shown.filter((hit) => hit.rank !== CONTAINS).map((hit) => resultLine(hit.index));
  const contained = shown
    .filter((hit) => hit.rank === CONTAINS)
    .map((hit) => resultLine(hit.index));
  const text = [
    ...ranked,
    ...(contained.length ? [`Also contains ${JSON.stringify(query)}:`, ...contained] : []),
  ].join("\n");
  return { text, matches: found.length, shown: shown.length };
}
