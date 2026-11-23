import type { BrowseResult } from "./run.ts";
import { addUsage, type AskUsage } from "./adapter.ts";
import { browsedLines, foundNothing, onlyStatesAbsence } from "./escalation.ts";
import { type AskReport, TRUNCATED_NOTE } from "./run.ts";

function totalUsage(results: { usage?: AskUsage }[]) {
  const total: AskUsage = {};
  for (const result of results) addUsage(total, result.usage);
  return Object.keys(total).length ? total : undefined;
}
import { CITATION, issueSource, sortIssues } from "./reply.ts";
import { fieldPointer } from "../shared/output.ts";

const DISPUTED_MARK = "[browse disagreed, without evidence on the page]";

const CONCLUDED = new Set<BrowseResult["outcome"]>(["found", "partial", "not_found", "blocked"]);

export function describeUsage(usage: AskUsage) {
  return Object.entries(usage)
    .map(
      ([key, value]) =>
        `${key.replace(/_/g, " ")} ${/cost|usd/i.test(key) ? `$${value.toFixed(4)}` : value}`,
    )
    .join(", ");
}

function describeBrowsed(result: BrowseResult) {
  const why = result.how ?? result.error;
  return `${result.source}: ${result.outcome}, ${result.steps} steps, ${result.toolCalls.length} tool calls${why ? ` (${why})` : ""}`;
}

export function renderBrowseDetails(results: BrowseResult[]) {
  if (results.length === 0) return "";
  const sections = results.map((result) => {
    const calls = result.toolCalls.map(
      (call) =>
        `- ${call.name}${call.target ? ` ${call.target}` : ""}${call.blocked ? ` (refused: ${call.blocked})` : call.error ? ` (error: ${call.error})` : ""}`,
    );
    return [
      `### ${result.source}`,
      `Outcome: ${result.outcome}${result.how ? ` (${result.how})` : ""}${result.error ? `; ${result.error}` : ""}`,
      `Start URL: ${result.url}`,
      ...(result.finalUrl ? [`Final URL: ${result.finalUrl}`] : []),
      `Steps: ${result.steps}, ${(result.ms / 1000).toFixed(1)} s. Usage: ${result.usage ? describeUsage(result.usage) : "not reported"}.`,
      `Tool calls (${result.toolCalls.length}):`,
      ...calls,
      ...(result.transcript ? [`Transcript: ${result.transcript}`] : []),
    ].join("\n");
  });
  return ["## Browsing", ...sections].join("\n\n");
}

export function askResultParts(question: string, report: AskReport) {
  const results = report.batches;
  const review = report.mode === "review";
  const browsed = report.browse?.results ?? [];
  const lines = [`${review ? "Review" : "Question"}: ${question}`, ""];
  const browsedNotFound = new Set(
    review ? [] : browsed.filter(foundNothing).map((result) => result.source),
  );
  const sources = [
    ...new Set([
      ...results.flatMap((result) => result.sources),
      ...browsed.map((result) => result.source),
    ]),
  ];
  const sourceOf = (line: string) =>
    (review ? issueSource(line, sources) : CITATION.exec(line)?.[1]) ?? "";
  const replaced = new Set(
    review
      ? []
      : browsed
          .filter(
            (result) =>
              (result.outcome === "found" || result.outcome === "partial") && result.lines.length,
          )
          .map((result) => result.source),
  );
  const dropped = browsed.flatMap((result) => result.dropped ?? []);
  const droppedLines = new Set(dropped.map((entry) => entry.issue));
  const disputed = new Set(browsed.flatMap((result) => result.disputed ?? []));
  const keepRead = (answer: string) => {
    if (droppedLines.has(answer)) return false;
    const source = sourceOf(answer);
    if (replaced.has(source)) return false;
    return !(browsedNotFound.has(source) && onlyStatesAbsence(answer));
  };
  const markDisputed = (answer: string) =>
    disputed.has(answer) ? `${answer} ${DISPUTED_MARK}` : answer;
  const answers = [
    ...results
      .flatMap((result) => (result.error ? [] : result.answers))
      .filter(keepRead)
      .map(markDisputed),
    ...browsedLines(report),
  ];
  const shown = review ? sortIssues(answers) : answers;
  const answered = new Set(answers.map(sourceOf).filter(Boolean));
  const settledByBrowsing = review
    ? browsed
        .filter((result) => result.outcome === "found" && !result.issues?.length)
        .map((result) => result.source)
    : [...browsedNotFound];
  const outcomes = new Map(browsed.map((result) => [result.source, result.outcome]));
  const partlyReviewed = (result: BrowseResult) =>
    review && result.outcome === "partial" && !result.issues?.length;
  const unfinished = new Set(
    browsed
      .filter((result) => !CONCLUDED.has(result.outcome) || partlyReviewed(result))
      .map((result) => result.source),
  );
  const unanswered = [
    ...new Set([
      ...results.flatMap((result) => result.notFound),
      ...settledByBrowsing,
      ...unfinished,
    ]),
  ].filter((source) => !answered.has(source));
  const withOutcome = (source: string) =>
    !review && outcomes.has(source) ? `${source} (browsed: ${outcomes.get(source)})` : source;
  const nothingRelevant = unanswered.filter((source) => !unfinished.has(source));
  const notAnswered = unanswered.filter((source) => unfinished.has(source));
  const partlyAnswered = review
    ? []
    : browsed
        .filter(
          (result) =>
            (result.outcome === "partial" || unfinished.has(result.source)) &&
            answered.has(result.source),
        )
        .map((result) => result.source);
  const answersAt = lines.length;
  lines.push(...shown);
  if (dropped.length)
    lines.push(
      "",
      "Dropped by browsing:",
      ...dropped.map(
        (entry) => `${entry.issue.replace(/^-\s*/, "")} (the page shows "${entry.evidence}")`,
      ),
    );
  if (answers.length === 0 && notAnswered.length === 0)
    lines.push(review ? "No page had issues." : "No page had anything relevant.");
  if (partlyAnswered.length)
    lines.push("", `Partly answered: ${partlyAnswered.map(withOutcome).join(", ")}`);
  if (nothingRelevant.length)
    lines.push(
      "",
      `${review ? "No issues in" : "Nothing relevant in"}: ${nothingRelevant.map(withOutcome).join(", ")}`,
    );
  if (notAnswered.length)
    lines.push(
      "",
      `${review ? "Not fully checked" : "Not answered"}: ${notAnswered.map(withOutcome).join(", ")}`,
    );
  if (report.empty.length) lines.push("", `Empty pages (not sent): ${report.empty.join(", ")}`);
  if (report.clipped.length)
    lines.push(
      "",
      `Clipped to their start and end: ${report.clipped.map((entry) => `${entry.source} (${entry.chars} chars)`).join(", ")}`,
    );
  const truncated = results.filter((result) => result.truncated && !result.error);
  if (truncated.length) {
    lines.push("", "Cut off calls (their answers above may be incomplete):");
    for (const result of truncated)
      lines.push(`call ${result.index} [${result.sources.join(", ")}]: ${TRUNCATED_NOTE}`);
  }
  const interrupted = results.filter((result) => result.interrupted);
  if (interrupted.length) {
    lines.push("", "Interrupted calls (their answers above may be incomplete):");
    for (const result of interrupted)
      lines.push(`call ${result.index} [${result.sources.join(", ")}]`);
  }
  const failed = results.filter((result) => result.error);
  if (failed.length) {
    lines.push("", "Failed calls (their pages were not read):");
    for (const result of failed)
      lines.push(`call ${result.index} [${result.sources.join(", ")}]: ${result.error}`);
  }
  if (report.browse?.skipped) lines.push("", report.browse.skipped);
  const pointedLines = browsed.length
    ? [...lines, "", `Browsed ${browsed.length} page(s): ${fieldPointer("browsed")}`]
    : lines;
  if (browsed.length)
    lines.push("", `Browsed ${browsed.length} page(s):`, ...browsed.map(describeBrowsed));
  return {
    text: lines.join("\n"),
    answers: shown,
    answersFrame: (pointer: string) =>
      (shown.length
        ? [
            ...pointedLines.slice(0, answersAt),
            pointer,
            ...pointedLines.slice(answersAt + shown.length),
          ]
        : pointedLines
      ).join("\n"),
    nothingRelevant: review ? [] : nothingRelevant,
    noIssues: review ? nothingRelevant : [],
    notAnswered,
    partlyAnswered,
  };
}

export function renderAskResults(question: string, report: AskReport) {
  return askResultParts(question, report).text;
}

export function renderAskStats(report: AskReport, adapter: string, model: string) {
  const results = report.batches;
  const browsed = report.browse?.results ?? [];
  const browseUsage = totalUsage(browsed);
  const usage = totalUsage(results);
  const slowest = Math.max(0, ...results.map((result) => result.ms));
  return [
    ...(browsed.length
      ? [`Browsing usage: ${browseUsage ? describeUsage(browseUsage) : "not reported"}.`]
      : []),
    `Adapter: ${adapter}, model ${model}, ${results.length} call(s), slowest ${(slowest / 1000).toFixed(1)} s. Usage: ${usage ? describeUsage(usage) : "not reported"}.`,
  ].join("\n");
}
