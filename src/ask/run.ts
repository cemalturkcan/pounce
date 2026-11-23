import path from "node:path";
import { z } from "zod";
import {
  type AskAdapter,
  type AskInput,
  type AskUsage,
  completeLogged,
  isCutOff,
  failureReason,
} from "./adapter.ts";
import { ToolError, messageOf } from "../shared/errors.ts";
import { clipHeadTail } from "../shared/output.ts";
import {
  ASK_BROWSE_NOTE,
  ASK_SYSTEM,
  buildPrompt,
  REVIEW_BROWSE_NOTE,
  REVIEW_SYSTEM,
} from "./prompt.ts";
import { checkCounts } from "./counts.ts";
import { CITATION, parseEscalations, parseReply, parseReview } from "./reply.ts";
import { AskSetupError } from "./errors.ts";
import type { AskDocument, AskMode, Escalation } from "./types.ts";

export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;
export const DEFAULT_BATCH_CHARS = 3_000_000;
export const IMAGE_CHARS = 6000;
export const MAX_IMAGES_PER_CALL = 100;
export const TRUNCATED_NOTE =
  "answer cut off at the output limit or the context window; raise max_output_tokens or lower batch_chars";

export type BatchResult = {
  index: number;
  sources: string[];
  answers: string[];
  notFound: string[];
  error?: string;
  truncated?: boolean;
  interrupted?: boolean;
  usage?: AskUsage;
  reply?: string;
  escalations?: Escalation[];
  ms: number;
};

export type BrowseSelection = {
  source: string;
  reason: "not_found" | "hidden" | "interaction" | "all";
  hint?: string;
  found: string[];
  unclear?: string[];
};

type BrowseStatus = "found" | "partial" | "not_found" | "blocked";
export type BrowseOutcome =
  | BrowseStatus
  | "no_report"
  | "refused"
  | "cut_off"
  | "context_full"
  | "timed_out"
  | "cancelled"
  | "failed";
type BrowseIssue = { severity: "high" | "medium" | "low"; where: string; issue: string };
export type BrowseToolCall = { name: string; target?: string; error?: string; blocked?: string };

export type BrowseResult = {
  source: string;
  url: string;
  finalUrl?: string;
  outcome: BrowseOutcome;
  lines: string[];
  issues?: BrowseIssue[];
  dropped?: { issue: string; evidence: string }[];
  disputed?: string[];
  how?: string;
  steps: number;
  toolCalls: BrowseToolCall[];
  usage?: AskUsage;
  ms: number;
  error?: string;
  transcript?: string;
};

export type AskReport = {
  mode?: AskMode;
  batches: BatchResult[];
  empty: string[];
  clipped: { source: string; chars: number }[];
  browse?: { results: BrowseResult[]; skipped?: string };
};

type AskOptions = {
  question: string;
  documents: AskDocument[];
  batchChars: number;
  maxPagesPerBatch?: number;
  maxCharsPerPage?: number;
  concurrency: number;
  model: string;
  maxTokens: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: AskMode;
  browse?: boolean;
};

export function clipDocument(document: AskDocument, maxChars: number): AskDocument {
  const clipped = clipHeadTail(document.text, maxChars);
  return clipped.truncated ? { ...document, text: clipped.text } : document;
}

export function packBatches(
  documents: AskDocument[],
  batchChars: number,
  maxPages = Number.POSITIVE_INFINITY,
) {
  const batches: AskDocument[][] = [];
  let current: AskDocument[] = [];
  let size = 0;
  let images = 0;
  for (const document of documents) {
    const count = document.images?.length ?? 0;
    const weight = document.text.length + count * IMAGE_CHARS;
    if (
      current.length > 0 &&
      (size + weight > batchChars ||
        current.length >= maxPages ||
        images + count > MAX_IMAGES_PER_CALL)
    ) {
      batches.push(current);
      current = [];
      size = 0;
      images = 0;
    }
    current.push(document);
    size += weight;
    images += count;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function uniqueSources(documents: AskDocument[]) {
  const seen = new Map<string, number>();
  const taken = new Set(documents.map((document) => document.source));
  return documents.map((document) => {
    const count = (seen.get(document.source) ?? 0) + 1;
    seen.set(document.source, count);
    if (count === 1) return document;
    let suffix = count;
    while (taken.has(`${document.source}#${suffix}`)) suffix += 1;
    const source = `${document.source}#${suffix}`;
    taken.add(source);
    return { ...document, source };
  });
}

export function sourceNames(files: string[]) {
  const bases = files.map((file) => path.basename(file));
  if (new Set(bases).size === bases.length) return bases;
  const folders = files.map((file) => path.dirname(path.resolve(file)).split(path.sep));
  const common: string[] = [];
  for (const [index, part] of (folders[0] ?? []).entries()) {
    if (!folders.every((folder) => folder[index] === part)) break;
    common.push(part);
  }
  const root = common.join(path.sep) || path.sep;
  return files.map((file) => path.relative(root, path.resolve(file)));
}

const CONTEXT_OVERFLOW =
  /prompt is too long|exceeds? (?:the )?(?:model'?s? )?context (?:window|limit|length)/i;

export function exceedsContextWindow(cause: unknown) {
  const message = messageOf(cause);
  return (
    /\bmodel_context_window_exceeded\b/.test(message) ||
    (/\binvalid_request_error\b/.test(message) && CONTEXT_OVERFLOW.test(message))
  );
}

const TOO_LARGE_FOR_CONTEXT = "the page does not fit the model's context window on its own";

function exceedsRequestSize(cause: unknown) {
  return /\brequest_too_large\b|\bHTTP 413\b/.test(messageOf(cause));
}

const TOO_LARGE_FOR_REQUEST = "the page is too large for one request on its own";

function callSignal(options: AskOptions) {
  const signals = [
    ...(options.timeoutMs === undefined ? [] : [AbortSignal.timeout(options.timeoutMs)]),
    ...(options.signal ? [options.signal] : []),
  ];
  return signals.length ? AbortSignal.any(signals) : new AbortController().signal;
}

type BatchOutcome = Omit<BatchResult, "index">;

const replyText = z.object({ text: z.string() });

function hasContent(document: AskDocument) {
  return Boolean(document.text.trim() || document.images?.length);
}

function askInput(options: AskOptions, batch: AskDocument[], system: string) {
  const input: AskInput = {
    system,
    prompt: buildPrompt(options.question, batch, options.mode),
    model: options.model,
    maxTokens: options.maxTokens,
    signal: callSignal(options),
  };
  const images = batch.flatMap((document) => document.images ?? []);
  if (images.length) input.images = images;
  return input;
}

function checkedCounts<T extends { answers: string[] }>(parsed: T, batch: AskDocument[]): T {
  const texts = new Map(
    batch.flatMap((document) => (document.plain ? [] : [[document.source, document.text]])),
  );
  const answers = parsed.answers.map((answer) => {
    const text = texts.get(CITATION.exec(answer)?.[1] ?? "");
    return checkCounts(answer, text === undefined ? [] : [text]);
  });
  return { ...parsed, answers };
}

export async function askPages(adapter: AskAdapter, options: AskOptions): Promise<AskReport> {
  const named = uniqueSources(options.documents);
  const empty = named
    .filter((document) => !hasContent(document))
    .map((document) => document.source);
  const clipped: AskReport["clipped"] = [];
  const documents = named.filter(hasContent).map((document) => {
    const kept =
      options.maxCharsPerPage === undefined
        ? document
        : clipDocument(document, options.maxCharsPerPage);
    if (kept !== document) clipped.push({ source: document.source, chars: document.text.length });
    return kept;
  });
  const batches = packBatches(documents, options.batchChars, options.maxPagesPerBatch);
  const outcomes = Array.from<BatchOutcome[] | undefined>({ length: batches.length });
  let cursor = 0;
  let setupError: unknown;
  const review = options.mode === "review";

  const run = async (batch: AskDocument[], call: string): Promise<BatchOutcome[]> => {
    const sources = batch.map((document) => document.source);
    const started = Date.now();
    try {
      const base = review ? REVIEW_SYSTEM : ASK_SYSTEM;
      const system = options.browse
        ? `${base}\n\n${review ? REVIEW_BROWSE_NOTE : ASK_BROWSE_NOTE}`
        : base;
      const reply = await completeLogged(adapter, askInput(options, batch, system), {
        tool: "ask_pages",
        call,
        pages: batch.length,
      });
      const decoded = replyText.safeParse(reply);
      if (!decoded.success) throw new ToolError(`${adapter.name} returned no text.`);
      const { text } = decoded.data;
      if (reply.stopReason === "refusal")
        throw new ToolError("the model refused to answer (stop reason refusal)");
      const escalated = options.browse
        ? parseEscalations(text, sources, options.mode ?? "answer")
        : undefined;
      const answerText = escalated ? escalated.text : text;
      const parsed = review
        ? parseReview(answerText, sources)
        : checkedCounts(parseReply(answerText, sources), batch);
      const outcome: BatchOutcome = {
        sources,
        ...parsed,
        usage: reply.usage,
        reply: text,
        ms: Date.now() - started,
      };
      if (isCutOff(reply.stopReason)) outcome.truncated = true;
      if (reply.stopReason === "interrupted") outcome.interrupted = true;
      if (escalated) outcome.escalations = escalated.escalations;
      return [outcome];
    } catch (cause) {
      if (cause instanceof AskSetupError) setupError = cause;
      const splittable = !setupError && !options.signal?.aborted;
      const overflow = splittable && exceedsContextWindow(cause);
      const oversized = splittable && exceedsRequestSize(cause);
      if ((overflow || oversized) && batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        const first = await run(batch.slice(0, half), `${call}.1`);
        if (setupError) return first;
        const second = await run(batch.slice(half), `${call}.2`);
        return [...first, ...second];
      }
      const reason = failureReason(cause, options.timeoutMs);
      return [
        {
          sources,
          answers: [],
          notFound: [],
          error: overflow
            ? `${TOO_LARGE_FOR_CONTEXT}: ${reason}`
            : oversized
              ? `${TOO_LARGE_FOR_REQUEST}: ${reason}`
              : reason,
          ms: Date.now() - started,
        },
      ];
    }
  };

  const worker = async (): Promise<void> => {
    if (cursor >= batches.length || setupError || options.signal?.aborted) return;
    const index = cursor;
    cursor += 1;
    outcomes[index] = await run(batches[index] ?? [], String(index + 1));
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, batches.length) }, worker));
  if (setupError) throw setupError;
  if (options.signal?.aborted)
    throw new ToolError("The call was cancelled before every model call finished.");
  const results = outcomes
    .flatMap((outcome) => outcome ?? [])
    .map((outcome, index): BatchResult => Object.assign({ index: index + 1 }, outcome));
  const report: AskReport = { batches: results, empty, clipped };
  return review ? { mode: "review", ...report } : report;
}

export function allBatchesFailed(report: AskReport) {
  return report.batches.length > 0 && report.batches.every((batch) => batch.error);
}
