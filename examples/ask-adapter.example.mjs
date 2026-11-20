export default {
  name: "example HTTP adapter",
  async complete({ system, prompt, model, maxTokens, signal }) {
    const response = await fetch("https://llm.example.invalid/v1/complete", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.EXAMPLE_LLM_KEY ?? ""}` },
      body: JSON.stringify({ model, system, prompt, max_tokens: maxTokens }),
      signal,
    });
    if (!response.ok) throw new Error(`example adapter: HTTP ${response.status}`);
    const body = await response.json();
    return {
      text: String(body.text ?? ""),
      usage: { input_tokens: Number(body.input_tokens ?? 0), output_tokens: Number(body.output_tokens ?? 0) },
    };
  },
};
