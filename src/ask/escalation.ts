import type { AskReport, BrowseResult, BrowseSelection } from "./run.ts";
import { CITATION, citedSources, issueSource } from "./reply.ts";

const PAGE_NOUN = String.raw`(?:page|site|document|text|screenshot|listing)s?`;
const CONTENT_NOUN = String.raw`(?:page|document|text|screenshot|listing)s?`;
const PAGE_SUBJECT = String.raw`^(?:[\w'’-]+\s+){0,4}?${PAGE_NOUN}\s+`;
const CONTENT_SUBJECT = String.raw`^(?:[\w'’-]+\s+){0,4}?${CONTENT_NOUN}\s+`;
const INFORMATION = String.raw`(?:(?:any|a|an)\s+)?(?:[\w'’-]+\s+){0,2}?(?:information|info|details?|data|prices?|pricing|figures?|costs?|amounts?)(?:\s+(?:for|about|on|of)\s+.+)?$`;
const PAGE_PLACE = String.raw`\s+(?:anywhere\s+)?(?:on|in)\s+(?:the|this)\s+(?:[\w'’-]+\s+){0,3}?${PAGE_NOUN}\b`;
const NOT_SHOWN = String.raw`(?:shown|stated|listed|mentioned|specified|displayed|visible|found|published|disclosed)`;
const ABSENCE = [
  new RegExp(
    String.raw`${PAGE_SUBJECT}(?:does not|doesn't|do not|don't|did not|didn't|never)\s+(?:show|state|list|mention|specify|display|say|reveal|disclose|publish)\b`,
    "i",
  ),
  new RegExp(
    String.raw`${PAGE_SUBJECT}(?:shows?|states?|mentions?|specifies|displays?|says|reveals?)\s+(?:no|nothing)\b`,
    "i",
  ),
  new RegExp(
    String.raw`${CONTENT_SUBJECT}(?:does not|doesn't|do not|don't|did not|didn't|never)\s+(?:contain|include|provide|give|list|have)\s+${INFORMATION}`,
    "i",
  ),
  new RegExp(
    String.raw`${CONTENT_SUBJECT}(?:contains?|includes?|provides?|gives?|lists?|has|have)\s+no\s+${INFORMATION}`,
    "i",
  ),
  new RegExp(String.raw`\b(?:is|are|was|were)\s+(?:not|never)\s+${NOT_SHOWN}${PAGE_PLACE}`, "i"),
  new RegExp(String.raw`^no\s+.*?\b(?:is|are)\s+${NOT_SHOWN}${PAGE_PLACE}`, "i"),
];
const BEYOND_ABSENCE = /[,;:()\d$€£¥—–]|\b(?:but|which|while|although|only|except|instead)\b/i;
const UNCERTAIN_WORD = String.raw`(?:unclear|not clear|ambiguous|uncertain)`;
const UNCERTAIN = new RegExp(String.raw`\b${UNCERTAIN_WORD}\b`, "i");

function factOf(answer: string) {
  return answer.replace(CITATION, "").replace(/^-\s*/, "").trim();
}

export function onlyStatesAbsence(answer: string) {
  const fact = factOf(answer);
  return !BEYOND_ABSENCE.test(fact) && ABSENCE.some((pattern) => pattern.test(fact));
}

function isUnclear(answer: string) {
  return UNCERTAIN.test(factOf(answer));
}

export function selectEscalations(report: AskReport, browse: "auto" | "all"): BrowseSelection[] {
  const review = report.mode === "review";
  const read = report.batches.filter((batch) => !batch.error);
  const allAnswers = read.flatMap((batch) => batch.answers);
  const absent = review ? new Set<string>() : citedSources(allAnswers.filter(onlyStatesAbsence));
  const answers = review ? allAnswers : allAnswers.filter((answer) => !onlyStatesAbsence(answer));
  const answered = citedSources(answers);
  const missing = new Set(read.flatMap((batch) => batch.notFound));
  const hints = new Map<string, string[]>();
  for (const escalation of read.flatMap((batch) => batch.escalations ?? []))
    hints.set(escalation.source, [...(hints.get(escalation.source) ?? []), escalation.hint]);
  const selected = new Map<string, BrowseSelection>();
  for (const source of read.flatMap((batch) => batch.sources)) {
    if (selected.has(source)) continue;
    const hint = hints.get(source)?.join("; ");
    const notFound =
      !review && ((missing.has(source) && !answered.has(source)) || absent.has(source));
    const reason = hint
      ? review
        ? "interaction"
        : "hidden"
      : notFound
        ? "not_found"
        : browse === "all"
          ? "all"
          : undefined;
    if (!reason) continue;
    const cited = answers.filter((answer) =>
      review ? issueSource(answer, [source]) === source : CITATION.exec(answer)?.[1] === source,
    );
    const unclear = review ? [] : cited.filter(isUnclear);
    const selection: BrowseSelection = {
      source,
      reason,
      found: review ? cited : cited.filter((answer) => !isUnclear(answer)),
    };
    if (hint) selection.hint = hint;
    if (unclear.length) selection.unclear = unclear;
    selected.set(source, selection);
  }
  return [...selected.values()];
}

export function mergeBrowse(
  report: AskReport,
  results: BrowseResult[],
  skipped?: string,
): AskReport {
  const browse: NonNullable<AskReport["browse"]> = { results };
  if (skipped) browse.skipped = skipped;
  return { ...report, browse };
}

export function foundNothing(result: BrowseResult) {
  return result.outcome === "not_found" || result.outcome === "blocked";
}

export function browsedLines(report: AskReport) {
  const results = report.browse?.results ?? [];
  if (report.mode === "review")
    return results.flatMap((result) =>
      (result.issues ?? []).map(
        (issue) =>
          `- [${issue.severity}] [browsed] ${result.source}, ${issue.where}: ${issue.issue}`,
      ),
    );
  return results
    .filter((result) => !foundNothing(result))
    .flatMap((result) =>
      result.lines.map((line) => `- [browsed] ${line.replace(/^[-*•]\s*/, "")} [${result.source}]`),
    );
}
