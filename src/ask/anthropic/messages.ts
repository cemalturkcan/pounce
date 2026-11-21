import { z } from "zod";
import type {
  AskAssistantBlock,
  AskImage,
  AskImageMediaType,
  AskMessage,
  AskToolInputSchema,
  AskUserBlock,
  JsonObject,
} from "../adapter.ts";
import { billingHeader, CLAUDE_CODE_IDENTITY } from "./identity.ts";

const textField = z.object({ text: z.string() });

type CacheControl = { type: string };
type TextContent = { type: "text"; text: string; cache_control?: CacheControl };
type ImageContent = {
  type: "image";
  source: { type: "base64"; media_type: AskImageMediaType; data: string };
  cache_control?: CacheControl;
};
type ToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: (TextContent | ImageContent)[];
  is_error?: boolean;
  cache_control?: CacheControl;
};
type ToolUseContent = { type: "tool_use"; id: string; name: string; input: unknown };
type UserContent = TextContent | ImageContent | ToolResultContent;
type AssistantContent = TextContent | ToolUseContent | JsonObject;
type RequestContent = UserContent | AssistantContent;
type ConversationMessage = { role: AskMessage["role"]; content: RequestContent[] };
type RequestMessage = { role: AskMessage["role"]; content: string | RequestContent[] };
type SystemBlock = { type: "text"; text: string; cache_control?: CacheControl };
export type MessagesRequest = {
  model: string;
  max_tokens: number;
  stream: true;
  system: SystemBlock[];
  tools?: { name: string; description: string; input_schema: AskToolInputSchema }[];
  messages: RequestMessage[];
};

export function firstText(content: string | RequestContent[] | undefined) {
  if (content === undefined || Array.isArray(content))
    return textField.safeParse(content?.find((part) => part.type === "text")).data?.text ?? "";
  return content;
}

function imageBlock({ mediaType, data }: AskImage): ImageContent {
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

export function messageContent(prompt: string, images?: AskImage[]): string | UserContent[] {
  if (!images?.length) return prompt;
  return [
    ...images.flatMap((image): UserContent[] => [
      ...(image.label ? [{ type: "text" as const, text: `Screenshot: ${image.label}` }] : []),
      imageBlock(image),
    ]),
    { type: "text", text: prompt },
  ];
}

function userBlock(block: AskUserBlock): UserContent {
  if (block.type === "image") return imageBlock(block.image);
  if (block.type === "text") return { type: "text", text: block.text };
  const result: ToolResultContent = {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content.map((part) =>
      part.type === "image" ? imageBlock(part.image) : { type: "text", text: part.text },
    ),
  };
  return block.isError ? { ...result, is_error: true } : result;
}

function assistantBlock(block: AskAssistantBlock): AssistantContent {
  if (block.type === "opaque") return block.raw;
  if (block.raw) return block.raw;
  if (block.type === "tool_use")
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "text", text: block.text };
}

export const EPHEMERAL = { type: "ephemeral" };

function isBlankText(block: AssistantContent) {
  return block.type === "text" && !textField.safeParse(block).data?.text.trim();
}

export function conversationMessages(messages: AskMessage[]) {
  const serialized = messages
    .map((message): ConversationMessage => ({
      role: message.role,
      content:
        message.role === "user"
          ? message.content.map(userBlock)
          : message.content.map(assistantBlock).filter((block) => !isBlankText(block)),
    }))
    .filter((message) => message.role === "user" || message.content.length > 0);
  const last = serialized.at(-1);
  const lastBlock = last?.content.at(-1);
  if (last?.role === "user" && lastBlock)
    last.content[last.content.length - 1] = { ...lastBlock, cache_control: EPHEMERAL };
  return serialized;
}

export function systemBlocks(
  firstUserText: string,
  system: string,
  cacheControl?: CacheControl,
): SystemBlock[] {
  return [
    { type: "text", text: billingHeader(firstUserText) },
    { type: "text", text: CLAUDE_CODE_IDENTITY },
    cacheControl
      ? { type: "text", text: system, cache_control: cacheControl }
      : { type: "text", text: system },
  ];
}
