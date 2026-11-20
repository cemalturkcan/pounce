// maxTokens defaults to 128000. Requests that large need the streaming Messages API ("stream": true) to avoid HTTP timeouts;
// this non-streaming sketch only shows the shapes: images become base64 image blocks before the text, and stop_reason is passed through.
// converse() is optional and enables browsing in ask_pages: tools go out as { name, description, input_schema }, tool results as
// tool_result blocks, and every response block keeps its raw JSON so the next turn sends it back byte for byte (thinking included).
const ENDPOINT = "https://llm-gateway.example.invalid/v1/messages";

const imageBlock = (image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });

function userBlock(block) {
  if (block.type === "image") return imageBlock(block.image);
  if (block.type === "tool_result") {
    const content = block.content.map((part) => (part.type === "image" ? imageBlock(part.image) : { type: "text", text: part.text }));
    return { type: "tool_result", tool_use_id: block.toolUseId, content, ...(block.isError ? { is_error: true } : {}) };
  }
  return { type: "text", text: block.text };
}

function assistantBlock(block) {
  if (block.raw) return block.raw;
  if (block.type === "tool_use") return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  return { type: "text", text: block.text };
}

function replyBlock(raw) {
  if (raw.type === "text") return { type: "text", text: raw.text, raw };
  if (raw.type === "tool_use") return { type: "tool_use", id: raw.id, name: raw.name, input: raw.input, raw };
  return { type: "opaque", raw };
}

async function post(body, signal) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.EXAMPLE_LLM_KEY ?? "" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`example adapter: HTTP ${response.status}`);
  return response.json();
}

export default {
  name: "example Messages API adapter",
  async complete({ system, prompt, model, maxTokens, signal, images = [] }) {
    const content = [...images.map(imageBlock), { type: "text", text: prompt }];
    const body = await post({ model, system, max_tokens: maxTokens, messages: [{ role: "user", content }] }, signal);
    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      stopReason: body.stop_reason,
      usage: { input_tokens: Number(body.usage?.input_tokens ?? 0), output_tokens: Number(body.usage?.output_tokens ?? 0) },
    };
  },
  async converse({ system, tools, messages, model, maxTokens, signal }) {
    const body = await post(
      {
        model,
        system,
        max_tokens: maxTokens,
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
        messages: messages.map((message) => ({ role: message.role, content: message.content.map(message.role === "user" ? userBlock : assistantBlock) })),
      },
      signal,
    );
    return {
      content: (body.content ?? []).map(replyBlock),
      stopReason: body.stop_reason,
      usage: { input_tokens: Number(body.usage?.input_tokens ?? 0), output_tokens: Number(body.usage?.output_tokens ?? 0) },
    };
  },
};
