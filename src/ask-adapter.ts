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
