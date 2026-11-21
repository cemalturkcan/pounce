import { z } from "zod";
import type {
  AskAdapter,
  AskAssistantBlock,
  AskImage,
  AskToolInputSchema,
  AskUserBlock,
  JsonObject,
} from "../src/ask/adapter.ts";

const ENDPOINT = "https://llm-gateway.example.invalid/v1/messages";

const responseSchema = z.object({
  content: z.array(z.record(z.string(), z.json())).default([]),
  stop_reason: z.string().optional(),
  usage: z
    .object({ input_tokens: z.number().default(0), output_tokens: z.number().default(0) })
    .default({ input_tokens: 0, output_tokens: 0 }),
});

const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.json(),
});

const imageBlock = (image: AskImage) => ({
  type: "image",
  source: { type: "base64", media_type: image.mediaType, data: image.data },
});

function userBlock(block: AskUserBlock) {
  if (block.type === "image") return imageBlock(block.image);
  if (block.type === "tool_result") {
    const content = block.content.map((part) =>
      part.type === "image" ? imageBlock(part.image) : { type: "text", text: part.text },
    );
    const result = { type: "tool_result", tool_use_id: block.toolUseId, content };
    return block.isError ? { ...result, is_error: true } : result;
  }
  return { type: "text", text: block.text };
}

function assistantBlock(block: AskAssistantBlock) {
  if (block.type === "opaque" || block.raw) return block.raw;
  if (block.type === "tool_use")
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "text", text: block.text };
}

function replyBlock(raw: JsonObject): AskAssistantBlock {
  const text = textBlockSchema.safeParse(raw);
  if (text.success) return { ...text.data, raw };
  const toolUse = toolUseBlockSchema.safeParse(raw);
  if (toolUse.success) return { ...toolUse.data, raw };
  return { type: "opaque", raw };
}

type MessagesRequest = {
  model: string;
  system: string;
  max_tokens: number;
  tools?: { name: string; description: string; input_schema: AskToolInputSchema }[];
  messages: {
    role: "user" | "assistant";
    content: ReturnType<typeof userBlock>[] | ReturnType<typeof assistantBlock>[];
  }[];
};

async function post(body: MessagesRequest, signal: AbortSignal) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.EXAMPLE_LLM_KEY ?? "" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`example adapter: HTTP ${response.status}`);
  return responseSchema.parse(await response.json());
}

const adapter: AskAdapter = {
  name: "example Messages API adapter",
  async complete({ system, prompt, model, maxTokens, signal, images = [] }) {
    const content = [...images.map(imageBlock), { type: "text", text: prompt }];
    const body = await post(
      { model, system, max_tokens: maxTokens, messages: [{ role: "user", content }] },
      signal,
    );
    const text = body.content
      .flatMap((block) => {
        const parsed = textBlockSchema.safeParse(block);
        return parsed.success ? [parsed.data.text] : [];
      })
      .join("");
    return { text, stopReason: body.stop_reason, usage: body.usage };
  },
  async converse({ system, tools, messages, model, maxTokens, signal }) {
    const body = await post(
      {
        model,
        system,
        max_tokens: maxTokens,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
        messages: messages.map((message) => ({
          role: message.role,
          content:
            message.role === "user"
              ? message.content.map(userBlock)
              : message.content.map(assistantBlock),
        })),
      },
      signal,
    );
    return {
      content: body.content.map(replyBlock),
      stopReason: body.stop_reason,
      usage: body.usage,
    };
  },
};

export default adapter;
