import { z } from "zod";
import type { AskToolDefinition, AskToolUseBlock } from "../ask/adapter.ts";
import type { AskMode } from "../ask/types.ts";

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

const status = z
  .enum(["found", "partial", "not_found", "blocked"])
  .describe(
    "found: everything the task asks for this page; partial: some of it; not_found: the page and the pages it links to do not show it; blocked: a sign-in wall, a CAPTCHA or a refused action stands in the way.",
  );
const how = z.string().describe("One short English sentence on what you did, for the logs.");

const REPORT_SCHEMAS = {
  answer: z.strictObject({
    status,
    lines: z
      .array(z.string())
      .describe(
        "The facts, one per entry, each naming its subject and keeping the conditions the page attaches.",
      ),
    how,
  }),
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
        "What a visitor would see as broken after the interaction; empty when it looks right.",
      ),
    how,
  }),
} as const;

const REPORT_DESCRIPTION =
  "Finish the task: send the facts you found for this page with a status. Call it exactly once, as your last call.";
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

export function validated<T>(parsed: z.ZodSafeParseResult<T>): Checked<T> {
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map((issue) => {
    const where = issue.path.length ? issue.path.join(".") : "input";
    const keys = issue.code === "unrecognized_keys" ? ` (${issue.keys.join(", ")})` : "";
    return `${where}: ${issue.message}${keys}`;
  });
  return { ok: false, error: `Invalid input: ${issues.join("; ")}` };
}
