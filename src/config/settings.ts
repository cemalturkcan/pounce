import { readFileSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "../shared/decode.ts";

export const askSetting = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("claude") }),
  z.object({ mode: z.literal("api-key"), apiKey: z.string().min(1).optional() }),
  z.object({ mode: z.literal("adapter"), path: z.string().min(1) }),
  z.object({ mode: z.literal("off") }),
]);
export type AskSetting = z.infer<typeof askSetting>;
export type AskMode = AskSetting["mode"];

export const settingsSchema = z.object({
  ask: askSetting.optional(),
  agents: z.array(z.string()).optional(),
  entries: z.record(z.string(), z.json()).optional(),
  profile: z.string().optional(),
  desktop: z.boolean().optional(),
});
export type Settings = z.infer<typeof settingsSchema>;

export function readSettings(file: string): Settings {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const parsed = parseJson(text, settingsSchema);
  if (parsed.success) return parsed.data;
  throw new Error(
    `Invalid ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}. Fix it or run \`pounce install\` again.`,
  );
}

export function resolveAsk(
  setting: AskSetting | undefined,
  envKey: string | undefined,
): AskSetting {
  if (setting?.mode !== "api-key") return setting ?? { mode: "claude" };
  const apiKey = envKey ?? setting.apiKey;
  return apiKey ? { mode: "api-key", apiKey } : { mode: "api-key" };
}
