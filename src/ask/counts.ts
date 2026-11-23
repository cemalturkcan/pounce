const KINDS = ["list items", "table rows", "links", "headings"] as const;
type Kind = (typeof KINDS)[number];

const COUNT_TAG = /\s*\{count (\d+):([^}]*)\}/gi;
const COUNT_SUBJECT =
  /^ (list items|table rows|links|headings) (?:under ["“]([^"”]+)["”]|on the page)$/i;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const LINK = /(?<!!)\[[^\]]*\]\([^)\s]+\)/g;

export const COUNT_TAG_NOTE = `When a line states how many items of a kind the page shows, such as examples in a list, plans in a table or products under a heading, end the fact with a count tag: {count N: list items under "<heading>"}, where N is the number the line states, the kind is list items, table rows (without the header row), links or headings, and <heading> is the exact text of the heading the items sit under; write {count N: <kind> on the page} when they sit under no heading. The tag is checked against the page and replaced by the result, so count the items one by one and name the heading as the page writes it.`;

function plain(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isKind(value: string): value is Kind {
  return KINDS.some((kind) => kind === value);
}

function section(text: string, heading: string | undefined) {
  const lines = text.split("\n");
  if (heading === undefined) return { lines, level: 0 };
  const wanted = plain(heading);
  const starts = lines.flatMap((line, index) => {
    const match = HEADING.exec(line);
    return match && plain(match[2] ?? "") === wanted
      ? [{ index, level: (match[1] ?? "").length }]
      : [];
  });
  const [start] = starts;
  if (!start || starts.length > 1) return undefined;
  const rest = lines.slice(start.index + 1);
  const end = rest.findIndex((line) => {
    const match = HEADING.exec(line);
    return match !== null && (match[1] ?? "").length <= start.level;
  });
  return { lines: end === -1 ? rest : rest.slice(0, end), level: start.level };
}

function countTableRows(lines: string[]) {
  let rows = 0;
  let run = 0;
  for (const line of [...lines, ""]) {
    if (line.trim().startsWith("|")) {
      run += 1;
      continue;
    }
    if (run > 0) rows += Math.max(0, run - 2);
    run = 0;
  }
  return rows;
}

function countItems(lines: string[], level: number, kind: Kind) {
  if (kind === "headings")
    return lines.filter((line) => (HEADING.exec(line)?.[1] ?? "").length > level).length;
  if (kind === "links")
    return lines.reduce((sum, line) => sum + (line.match(LINK)?.length ?? 0), 0);
  if (kind === "table rows") return countTableRows(lines);
  const indents = lines.flatMap((line) => {
    const match = LIST_ITEM.exec(line);
    return match ? [(match[1] ?? "").length] : [];
  });
  const outer = Math.min(...indents);
  return indents.filter((indent) => indent === outer).length;
}

function countIn(texts: string[], kind: Kind, heading: string | undefined) {
  for (const text of texts) {
    const found = section(text, heading);
    if (found) return countItems(found.lines, found.level, kind);
  }
  return undefined;
}

export function hasCountTag(line: string) {
  return new RegExp(COUNT_TAG.source, "i").test(line);
}

export function checkCounts(line: string, texts: string[]) {
  return line.replace(COUNT_TAG, (_tag, stated: string, subject: string) => {
    const [, kind = "", heading] = COUNT_SUBJECT.exec(subject) ?? [];
    const normalized = kind.toLowerCase();
    if (!isKind(normalized)) return "";
    const counted = countIn(texts, normalized, heading);
    if (!counted) return "";
    const claimed = Number(stated);
    return counted === claimed
      ? " [count checked]"
      : ` [count checked: ${counted}, not ${claimed}]`;
  });
}
