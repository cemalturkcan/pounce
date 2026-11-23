import { z } from "zod";
import type { AskToolDefinition, AskToolUseBlock } from "../ask/adapter.ts";
import type { AskMode } from "../ask/types.ts";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const STATUS_MEANING =
  "found: everything the task asks for this page; partial: your lines answer part of it; not_found: the page and the pages it links to do not show it; blocked: a sign-in wall, a CAPTCHA or a refused action kept you from the answer.";
const status = z.enum(["found", "partial", "not_found", "blocked"]).describe(STATUS_MEANING);
const how = z
  .string()
  .describe(
    "One short English sentence on what you did, for the logs, including what stopped you or what looked right.",
  );

const part = z.strictObject({
  part: z
    .string()
    .describe(
      'One thing the question asks about this page, in the words of the question, such as "the yearly price of each plan".',
    ),
  outcome: z
    .enum(["answered", "not_found", "blocked"])
    .describe(
      "answered: your lines say what this part asks; not_found: the page and the pages it links to do not show it; blocked: a sign-in wall, a CAPTCHA or a refused action kept you from it.",
    ),
  lines: z
    .array(z.string())
    .describe(
      'The facts the page shows that answer this part, one per entry, each in the language of the question, naming its subject and keeping the conditions the page attaches. Only an answered part has lines: the lines of a part that is not_found or blocked are dropped. A link label or the name of the place it points to never answers a part, so "The footer reads Powered by Acme Labs" leaves "what Acme Labs offers" not_found, or blocked when its link was refused. A line that states how many items of a kind the page shows ends with a count tag as the system prompt describes.',
    ),
});

type Part = z.output<typeof part>;

function answerReport(report: { parts: Part[]; how: string }) {
  const { parts } = report;
  const answered = parts
    .map((entry) => ({
      ...entry,
      lines: entry.outcome === "answered" ? entry.lines.filter((line) => line.trim()) : [],
    }))
    .filter((entry) => entry.lines.length);
  const lines = answered.flatMap((entry) => entry.lines);
  if (answered.length === parts.length) return { status: "found" as const, lines, how: report.how };
  if (answered.length) return { status: "partial" as const, lines, how: report.how };
  const blocked = parts.some((entry) => entry.outcome === "blocked");
  return {
    status: blocked ? ("blocked" as const) : ("not_found" as const),
    lines,
    how: report.how,
  };
}

const REPORT_SCHEMAS = {
  answer: z
    .strictObject({
      parts: z
        .array(part)
        .min(1)
        .describe(
          "The question split into the things it asks, each with its outcome on this page and the lines that answer it. A question that asks one thing has one part.",
        ),
      how,
    })
    .transform(answerReport),
  review: z.strictObject({
    status,
    issues: z
      .array(
        z.strictObject({
          severity: z
            .enum(["high", "medium", "low"])
            .describe(
              "high for unmistakable breakage, medium when visibly wrong but usable, low for polish.",
            ),
          where: z
            .string()
            .describe("The place in words a developer can find, including the interaction."),
          issue: z
            .string()
            .describe("What is wrong and, when the page makes it clear, what it should look like."),
        }),
      )
      .describe(
        "Only what a visitor would see as broken after the interaction and the first message did not list; empty when nothing new is broken. A note that something looks right goes in how.",
      ),
    dropped: z
      .array(
        z.strictObject({
          issue: z
            .number()
            .int()
            .min(1)
            .describe("The number of an issue found so far, as the first message lists it."),
          evidence: z
            .string()
            .optional()
            .describe(
              "Page text that shows the issue is not real, at least three words quoted exactly as a page-reading tool returned them, such as the text of a panel the first reviewer saw as empty. Without it the issue stays, marked as disputed.",
            ),
        }),
      )
      .optional()
      .describe(
        "Issues found so far that your check doubts or the page shows are not real; every other issue found so far stays.",
      ),
    how,
  }),
} as const;

const REPORT_DESCRIPTION =
  "Finish the task: send the parts of the question, each with its outcome and the lines that answer it. Call it exactly once, as your last call.";
const REVIEW_REPORT_DESCRIPTION =
  "Finish the task: send the issues you found after the interaction with a status. Call it exactly once, as your last call.";

export const REPORT_TOOLS = {
  answer: {
    name: "report",
    description: REPORT_DESCRIPTION,
    inputSchema: z.toJSONSchema(REPORT_SCHEMAS.answer, { io: "input" }),
  },
  review: {
    name: "report",
    description: REVIEW_REPORT_DESCRIPTION,
    inputSchema: z.toJSONSchema(REPORT_SCHEMAS.review, { io: "input" }),
  },
} satisfies Record<AskMode, AskToolDefinition>;

export type Report = z.output<(typeof REPORT_SCHEMAS)[AskMode]>;

export function checkReport(mode: AskMode, use: AskToolUseBlock): Checked<Report> {
  return mode === "answer"
    ? validated(REPORT_SCHEMAS.answer.safeParse(use.input))
    : validated(REPORT_SCHEMAS.review.safeParse(use.input));
}

function plainWords(text: string) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

const MIN_QUOTE_WORDS = 3;

export function quotedIn(evidence: string, texts: string[]) {
  const quote = plainWords(evidence);
  if (quote.length < MIN_QUOTE_WORDS) return false;
  const wanted = ` ${quote.join(" ")} `;
  return texts.some((text) => ` ${plainWords(text).join(" ")} `.includes(wanted));
}

export function validated<T>(parsed: z.ZodSafeParseResult<T>): Checked<T> {
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "input";
    const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
    return `${where}: ${issue.message}${keys}`;
  });
  return { ok: false, error: `Invalid input: ${issues.join("; ")}` };
}
