import type { BrowseResult } from "./run.ts";
import { addUsage, type AskUsage } from "./adapter.ts";
import { browsedLines, onlyStatesAbsence, resolvedByBrowsing } from "./escalation.ts";
import { type AskReport, TRUNCATED_NOTE } from "./run.ts";

function totalUsage(results: { usage?: AskUsage }[]) {
  const total: AskUsage = {};
  for (const result of results) addUsage(total, result.usage);
  return Object.keys(total).length ? total : undefined;
}
import { CITATION, citedSources, sortIssues } from "./reply.ts";

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

export function renderAskResults(
  question: string,
  report: AskReport,
  adapter: string,
  model: string,
) {
  const results = report.batches;
  const review = report.mode === "review";
  const browsed = report.browse?.results ?? [];
  const lines = [`${review ? "Review" : "Question"}: ${question}`, ""];
  const resolved = new Set(
    review
      ? []
      : browsed
          .filter(
            (result) =>
              (result.outcome === "found" || result.outcome === "partial") && result.lines.length,
          )
          .map((result) => result.source),
  );
  const browsedNotFound = new Set(
    review
      ? []
      : browsed.filter((result) => result.outcome === "not_found").map((result) => result.source),
  );
  const keepRead = (answer: string) => {
    const source = CITATION.exec(answer)?.[1] ?? "";
    if (resolved.has(source)) return !resolvedByBrowsing(answer);
    return !(browsedNotFound.has(source) && onlyStatesAbsence(answer));
  };
  const answers = [
    ...results.flatMap((result) => (result.error ? [] : result.answers)).filter(keepRead),
    ...browsedLines(report),
  ];
  lines.push(...(review ? sortIssues(answers) : answers));
  if (answers.length === 0)
    lines.push(review ? "No page had issues." : "No page had anything relevant.");
  const answered = review
    ? new Set(browsed.filter((result) => result.issues?.length).map((result) => result.source))
    : citedSources(answers);
  const settledByBrowsing = review
    ? browsed
        .filter((result) => result.outcome === "found" && !result.issues?.length)
        .map((result) => result.source)
    : [...browsedNotFound];
  const outcomes = new Map(browsed.map((result) => [result.source, result.outcome]));
  const notFound = [
    ...new Set([...results.flatMap((result) => result.notFound), ...settledByBrowsing]),
  ]
    .filter((source) => !answered.has(source))
    .map((source) =>
      !review && outcomes.has(source) ? `${source} (browsed: ${outcomes.get(source)})` : source,
    );
  if (notFound.length)
    lines.push("", `${review ? "No issues in" : "Nothing relevant in"}: ${notFound.join(", ")}`);
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
  if (browsed.length) {
    const browseUsage = totalUsage(browsed);
    lines.push(
      "",
      `Browsed ${browsed.length} page(s):`,
      ...browsed.map(describeBrowsed),
      `Browsing usage: ${browseUsage ? describeUsage(browseUsage) : "not reported"}.`,
    );
  }
  const usage = totalUsage(results);
  const slowest = Math.max(0, ...results.map((result) => result.ms));
  lines.push(
    "",
    `Adapter: ${adapter}, model ${model}, ${results.length} call(s), slowest ${(slowest / 1000).toFixed(1)} s. Usage: ${usage ? describeUsage(usage) : "not reported"}.`,
  );
  return lines.join("\n");
}
