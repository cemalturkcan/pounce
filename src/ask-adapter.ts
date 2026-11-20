import { logEvent } from "./log.ts";

export type AskImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type AskImage = {
  mediaType: AskImageMediaType;
  data: string;
  label?: string;
};

export type AskInput = {
  system: string;
  prompt: string;
  model: string;
  maxTokens: number;
  images?: AskImage[];
  signal: AbortSignal;
};

export type AskUsage = Record<string, number>;

export type AskReply = {
  text: string;
  usage?: AskUsage;
  stopReason?: string;
};

export type AskAdapter = {
  name: string;
  complete(input: AskInput): Promise<AskReply>;
};

export type ModelCallContext = { tool: string; call: number | string; pages?: number };

function firstLine(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

export async function completeLogged(adapter: AskAdapter, input: AskInput, context: ModelCallContext): Promise<AskReply> {
  const startedAt = Date.now();
  const images = input.images ?? [];
  const fields = {
    tool: context.tool,
    adapter: adapter.name,
    model: input.model,
    call: context.call,
    pages: context.pages,
    images: images.length,
    imageBytes: images.reduce((total, image) => total + image.data.length, 0),
    promptChars: input.prompt.length,
  };
  try {
    const reply = await adapter.complete(input);
    logEvent("model_call", { ...fields, ms: Date.now() - startedAt, ok: true, stopReason: reply?.stopReason, usage: reply?.usage });
    return reply;
  } catch (error) {
    logEvent("model_call", { ...fields, ms: Date.now() - startedAt, ok: false, error: firstLine(error) }, "warn");
    throw error;
  }
}
