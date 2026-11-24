import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "../shared/decode.ts";

const askSetting = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("claude") }),
  z.object({ mode: z.literal("api-key"), apiKey: z.string().trim().min(1).optional() }),
  z.object({ mode: z.literal("adapter"), path: z.string().min(1) }),
  z.object({ mode: z.literal("off") }),
]);
export type AskSetting = z.infer<typeof askSetting>;
export type AskMode = AskSetting["mode"];

export const STORED_VARIABLE = /^WEB_AGENT_[A-Z0-9_]+$/;

const SETTING_FIELDS = {
  env: z.record(z.string().regex(STORED_VARIABLE), z.string()).optional(),
  ask: askSetting.optional(),
  agents: z.array(z.string()).optional(),
  entries: z.record(z.string(), z.json()).optional(),
  profile: z.string().optional(),
  desktop: z.boolean().optional(),
};

const settingsSchema = z.object(SETTING_FIELDS);
export type Settings = z.infer<typeof settingsSchema>;

export type SettingsRead = { settings: Settings; problem?: string };

const jsonObject = z.record(z.string(), z.json());
type JsonField = z.infer<typeof jsonObject>[string];

function describeIssues(error: z.ZodError) {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

const variableName = z.string().regex(STORED_VARIABLE);
const variableValue = z.string();

function validVariables(field: JsonField | undefined) {
  const variables = jsonObject.safeParse(field);
  if (!variables.success) return undefined;
  const valid = Object.entries(variables.data).filter(
    ([key, value]) => variableName.safeParse(key).success && variableValue.safeParse(value).success,
  );
  return valid.length ? Object.fromEntries(valid) : undefined;
}

function validFields(raw: z.infer<typeof jsonObject>): Settings {
  return settingsSchema.parse(
    Object.fromEntries(
      Object.entries(SETTING_FIELDS).flatMap(([key, schema]) => {
        const field = schema.safeParse(key === "env" ? validVariables(raw[key]) : raw[key]);
        return field.success && field.data !== undefined ? [[key, field.data]] : [];
      }),
    ),
  );
}

export function readSettingsLeniently(file: string): SettingsRead {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { settings: {} };
  }
  const parsed = parseJson(text, settingsSchema);
  if (parsed.success) return { settings: parsed.data };
  const problem = describeIssues(parsed.error);
  const raw = parseJson(text, jsonObject);
  return { settings: raw.success ? validFields(raw.data) : {}, problem };
}

export function invalidSettings(file: string, problem: string) {
  return new Error(`Invalid ${file}: ${problem}. Fix it or run \`pounce install\` again.`);
}

export function resolveAsk(
  setting: AskSetting | undefined,
  envKey: string | undefined,
): AskSetting {
  if (setting?.mode !== "api-key") return setting ?? { mode: "claude" };
  const apiKey = envKey ?? setting.apiKey;
  return apiKey ? { mode: "api-key", apiKey } : { mode: "api-key" };
}
