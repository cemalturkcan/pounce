import { z } from "zod";

const jsonText = z.string().transform((text, context) => {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: "custom", message: "Invalid JSON" });
    return z.NEVER;
  }
});

export function parseJson<Schema extends z.ZodType>(text: string, schema: Schema) {
  return jsonText.pipe(schema).safeParse(text);
}

export function parseJsonOrThrow<Schema extends z.ZodType>(text: string, schema: Schema) {
  return jsonText.pipe(schema).parse(text);
}
