const INTERACTIVE_ROLES = new Set([
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

const ROLE_PATTERN = /^\s*-\s+([a-z]+)/;

function indentOf(line: string) {
  return line.length - line.trimStart().length;
}

export function interactiveOnly(snapshot: string) {
  return snapshot
    .split("\n")
    .filter((line) => {
      const role = ROLE_PATTERN.exec(line)?.[1];
      return role !== undefined && INTERACTIVE_ROLES.has(role) && line.includes("[ref=");
    })
    .map((line) => line.trim().replace(/:$/, ""))
    .join("\n");
}

function refOfLine(line: string) {
  return /\[ref=([^\]\s]+)\]/.exec(line)?.[1];
}

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

export function cutSubtree(snapshot: string, ref: string) {
  const lines = snapshot.split("\n");
  const start = lines.findIndex((line) => refOfLine(line) === ref);
  if (start === -1) return undefined;
  const base = indentOf(lines[start] ?? "");
  const picked = [lines[start] ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() && indentOf(line) <= base) break;
    picked.push(line);
  }
  return picked
    .map((line) => line.slice(Math.min(base, indentOf(line))))
    .join("\n")
    .trimEnd();
}

export function limitDepth(snapshot: string, depth: number) {
  return snapshot
    .split("\n")
    .filter((line) => indentOf(line) / 2 < depth)
    .join("\n");
}

export function buildMatcher(query: string, useRegex: boolean) {
  if (useRegex) {
    const expression = new RegExp(query, "i");
    return (line: string) => expression.test(line);
  }
  const needle = foldCase(query);
  return (line: string) => foldCase(line).includes(needle);
}

function foldCase(text: string) {
  return text
    .toLowerCase()
    .replace(/\u0307/g, "")
    .replace(/ı/g, "i");
}

type FindResult = {
  text: string;
  matches: number;
  shown: number;
};

export function findInSnapshot(
  snapshot: string,
  matcher: (line: string) => boolean,
  maxResults: number,
): FindResult {
  const lines = snapshot.split("\n");
  const keep = new Set<number>();
  let matches = 0;
  let shown = 0;

  lines.forEach((line, index) => {
    if (!matcher(line)) return;
    matches += 1;
    if (shown >= maxResults) return;
    shown += 1;
    keep.add(index);
    let indent = indentOf(line);
    for (let cursor = index - 1; cursor >= 0 && indent > 0; cursor -= 1) {
      const candidate = lines[cursor] ?? "";
      const candidateIndent = indentOf(candidate);
      if (candidateIndent < indent) {
        keep.add(cursor);
        indent = candidateIndent;
      }
    }
  });

  const text = [...keep]
    .toSorted((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n");
  return { text, matches, shown };
}
