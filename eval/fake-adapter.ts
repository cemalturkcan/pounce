import type { AskAdapter } from "../src/ask/adapter.ts";

const USAGE = { input_tokens: 1, output_tokens: 1 };

const sourcesOf = (prompt: string) =>
  [...prompt.matchAll(/<document source="([^"]+)">/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

const adapter: AskAdapter = {
  name: "eval fake adapter",
  async complete({ system, prompt }) {
    const sources = sourcesOf(prompt);
    if (system.startsWith("You review web pages")) {
      const [first, ...rest] = sources;
      const issue = first
        ? [`- [medium] ${first}, header: the navigation links overlap the page title`]
        : [];
      return {
        text: [...issue, rest.length ? `OK: ${rest.join(", ")}` : ""].join("\n"),
        usage: USAGE,
      };
    }
    if (system.startsWith("You answer one question")) {
      return {
        text: sources.map((source) => `- The page has nothing unusual [${source}]`).join("\n"),
        usage: USAGE,
      };
    }
    return { text: "SAME", usage: USAGE };
  },
};

export default adapter;
