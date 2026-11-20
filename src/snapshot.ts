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

const REF_PATTERN = /^(?:f\d+)?e\d+$/;
const ROLE_PATTERN = /^\s*-\s+([a-z]+)/;

export function parseRef(target: string) {
  const cleaned = target
    .trim()
    .replace(/^@/, "")
    .replace(/^\[?ref=([^\]\s]+)\]?$/, "$1");
  return REF_PATTERN.test(cleaned) ? cleaned : undefined;
}

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

export function buildMatcher(query: string, useRegex: boolean) {
  if (useRegex) {
    const expression = new RegExp(query, "i");
    return (line: string) => expression.test(line);
  }
  const needle = query.toLowerCase();
  return (line: string) => line.toLowerCase().includes(needle);
}

export type FindResult = {
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
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .join("\n");
  return { text, matches, shown };
}
