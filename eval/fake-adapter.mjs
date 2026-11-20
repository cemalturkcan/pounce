const sourcesOf = (prompt) => [...prompt.matchAll(/<document source="([^"]+)">/g)].map((match) => match[1]);

export default {
  name: "eval fake adapter",
  async complete({ system, prompt }) {
    const sources = sourcesOf(prompt);
    if (system.startsWith("You review web pages")) {
      const [first, ...rest] = sources;
      const issue = first ? [`- [medium] ${first}, header: the navigation links overlap the page title`] : [];
      return { text: [...issue, rest.length ? `OK: ${rest.join(", ")}` : ""].join("\n"), usage: { input_tokens: 1, output_tokens: 1 } };
    }
    if (system.startsWith("You answer one question")) {
      return { text: sources.map((source) => `- The page has nothing unusual [${source}]`).join("\n"), usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return { text: "SAME", usage: { input_tokens: 1, output_tokens: 1 } };
  },
};
