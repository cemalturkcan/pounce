import type { AskMode, Escalation } from "./types.ts";

function sourceTokens(source: string) {
  const tokens = new Set([source]);
  const withoutExtension = source.replace(/\.(md|txt)$/i, "");
  tokens.add(withoutExtension);
  const tabId = /^(t\d+) /.exec(source)?.[1];
  if (tabId) tokens.add(tabId);
  return tokens;
}

function sourceMatcher(sources: string[]) {
  const owners = new Map<string, string[]>();
  for (const source of sources) {
    for (const token of sourceTokens(source))
      owners.set(token, [...(owners.get(token) ?? []), source]);
  }
  return (entry: string) => {
    const exact = sources.find((source) => source === entry);
    if (exact) return exact;
    const matched = owners.get(entry);
    return matched?.length === 1 ? matched[0] : undefined;
  };
}

export const CITATION = /\[([^[\]]+)\]\s*$/;

const NOT_FOUND_LINE = /^(?:[-*•]\s*|\d+[.)]\s*)?[*_\s]*NOT FOUND[*_\s]*:?[*_\s]*(.*)$/i;
const TOKEN_SEPARATOR = /[\s,;()[\]*`_"']+/;

function listedSources(listed: string, match: (entry: string) => string | undefined) {
  const found: string[] = [];
  for (const entry of listed.split(",")) {
    const whole = match(entry.replace(/[[\]*`_]/g, "").trim());
    if (whole) {
      found.push(whole);
      continue;
    }
    for (const token of entry.split(TOKEN_SEPARATOR)) {
      const source = token ? match(token) : undefined;
      if (source) found.push(source);
    }
  }
  return found;
}

export function citedSources(answers: string[]) {
  return new Set(
    answers
      .map((answer) => CITATION.exec(answer)?.[1])
      .filter((source): source is string => source !== undefined),
  );
}

export function parseReply(text: string, sources: string[]) {
  const match = sourceMatcher(sources);
  const answers: string[] = [];
  const notFound = new Set<string>();
  const trimmed = text.trim();
  if (/^NOT FOUND\.?$/i.test(trimmed)) return { answers, notFound: [...sources] };
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const missing = NOT_FOUND_LINE.exec(line);
    if (missing) {
      for (const source of listedSources(missing[1] ?? "", match)) notFound.add(source);
      continue;
    }
    const answer = line.startsWith("- ") ? line : `- ${line.replace(/^[*•]\s*/, "")}`;
    const cited = CITATION.exec(answer);
    const source = cited ? match((cited[1] ?? "").replace(/[*`_]/g, "").trim()) : undefined;
    answers.push(cited && source ? `${answer.slice(0, cited.index)}[${source}]` : answer);
  }
  const answered = citedSources(answers);
  return { answers, notFound: [...notFound].filter((source) => !answered.has(source)) };
}

const SEVERITIES = ["high", "medium", "low"] as const;
const ISSUE = /^[-*•]?\s*\[(high|medium|low)\]\s*(.+)$/i;

function citedSource(
  rest: string,
  sources: string[],
  match: (entry: string) => string | undefined,
) {
  const plain = rest.replace(/^[[*`_]+/, "");
  const candidates = sources
    .flatMap((source) => [...sourceTokens(source)].map((token) => ({ token, source })))
    .toSorted((left, right) => right.token.length - left.token.length);
  for (const { token } of candidates) {
    if (!plain.startsWith(token)) continue;
    const closing = /^[\]*`_]*/.exec(plain.slice(token.length))?.[0] ?? "";
    const remainder = plain.slice(token.length + closing.length).replace(/^\s*\([^)]*\)/, "");
    const separated =
      /^\s*[,:]|^\s+[-–—]\s/.test(remainder) || (closing.includes("]") && /^\s+\S/.test(remainder));
    if (!separated) continue;
    const source = match(token);
    if (source)
      return { source, after: remainder.replace(/^\s*,?\s*/, "").replace(/^[-–—]\s+/, "") };
  }
  return undefined;
}

const ESCALATION_LINE = {
  answer: /^[-*•\s]*[*_]*HIDDEN[*_]*\s*:\s*(.+)$/i,
  review: /^[-*•\s]*[*_]*NEEDS INTERACTION[*_]*\s*:\s*(.+)$/i,
} satisfies Record<AskMode, RegExp>;

export function parseEscalations(text: string, sources: string[], mode: AskMode) {
  const match = sourceMatcher(sources);
  const escalations: Escalation[] = [];
  const kept: string[] = [];
  for (const raw of text.split("\n")) {
    const line = ESCALATION_LINE[mode].exec(raw.trim());
    if (!line) {
      kept.push(raw);
      continue;
    }
    const cited = citedSource((line[1] ?? "").trim(), sources, match);
    const hint = cited?.after.replace(/^\s*[:,]\s*/, "").trim();
    if (cited && hint) escalations.push({ source: cited.source, hint });
    else kept.push(raw);
  }
  return { text: kept.join("\n").trim(), escalations };
}

export function parseReview(text: string, sources: string[]) {
  const match = sourceMatcher(sources);
  const answers: string[] = [];
  const ok = new Set<string>();
  for (const raw of text.trim().split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const clean = /^[*_\s]*OK[*_\s]*:[*_\s]*(.*)$/i.exec(line);
    if (clean) {
      for (const entry of (clean[1] ?? "").split(/,\s*(?=\S)/)) {
        const source = match(entry.replace(/[[\]*`_]/g, "").trim());
        if (source) ok.add(source);
      }
      continue;
    }
    const issue = ISSUE.exec(line);
    if (!issue) {
      answers.push(line.startsWith("- ") ? line : `- ${line.replace(/^[*•]\s*/, "")}`);
      continue;
    }
    const severity = (issue[1] ?? "").toLowerCase();
    const rest = (issue[2] ?? "").trim();
    const cited = citedSource(rest, sources, match);
    answers.push(
      cited ? `- [${severity}] ${cited.source}, ${cited.after}` : `- [${severity}] ${rest}`,
    );
  }
  return { answers, notFound: [...ok] };
}

function severityRank(line: string) {
  const severity = /^- \[(\w+)\]/.exec(line)?.[1] ?? "";
  const rank = SEVERITIES.findIndex((known) => known === severity);
  return rank === -1 ? SEVERITIES.length : rank;
}

export function sortIssues(lines: string[]) {
  return lines
    .map((line, index) => ({ line, index, rank: severityRank(line) }))
    .toSorted((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.line);
}
