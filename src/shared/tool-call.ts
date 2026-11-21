export type ToolCallExtra = { sessionId?: string; signal: AbortSignal; parentRequestId?: string };
export type ToolCallResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};
