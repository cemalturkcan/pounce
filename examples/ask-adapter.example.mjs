export default {
  name: "example Messages API adapter",
  async complete({ system, prompt, model, maxTokens, signal, images = [] }) {
    const content = [
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
      { type: "text", text: prompt },
    ];
    const response = await fetch("https://llm-gateway.example.invalid/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.EXAMPLE_LLM_KEY ?? "" },
      body: JSON.stringify({ model, system, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
      signal,
    });
    if (!response.ok) throw new Error(`example adapter: HTTP ${response.status}`);
    const body = await response.json();
    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      usage: { input_tokens: Number(body.usage?.input_tokens ?? 0), output_tokens: Number(body.usage?.output_tokens ?? 0) },
    };
  },
};
