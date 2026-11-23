import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AskAdapter } from "../src/ask/adapter.ts";
import { AskAdapterSource } from "../src/ask/adapter-source.ts";
import { inSequence, repeatUntil, sleep } from "../src/shared/async.ts";
import { errorFrom } from "../src/shared/errors.ts";
import type { ToolDeps } from "../src/tools/common.ts";
import { stallRequests } from "./fixture-edge.ts";
import { savedDir, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture } = useToolsHarness("tools-ask");

const countedDir = async (file: string, text: string) => {
  const dir = await mkdtemp(path.join(mcp.workDir, "ask-counts-"));
  await writeFile(path.join(dir, file), text);
  return dir;
};

describe("ask_pages edge cases through the tool", () => {
  let saved: ToolDeps["ask"];
  const seen: string[][] = [];
  let failAll = false;
  let padding = "";
  const scripted: AskAdapter = {
    name: "scripted adapter",
    complete: async ({ prompt }) => {
      const sources = [...prompt.matchAll(/<document source="([^"]+)">/g)].map(
        (match) => match[1] ?? "",
      );
      seen.push(sources);
      if (failAll) throw new Error(`upstream refused ${sources.length} pages`);
      return { text: sources.map((source) => `- seen [${source}]${padding}`).join("\n") };
    },
  };
  let root = "";
  let left = "";
  let right = "";
  let name = "";
  let files: string[] = [];

  beforeAll(async () => {
    saved = mcp.deps.ask;
    mcp.deps.ask = new AskAdapterSource({ adapter: scripted });
    root = await mkdtemp(path.join(mcp.workDir, "ask-files-"));
    [left, right] = [
      `run-${randomBytes(3).toString("hex")}`,
      `run-${randomBytes(3).toString("hex")}`,
    ];
    name = `01-${randomBytes(3).toString("hex")}.md`;
    files = [path.join(root, left, name), path.join(root, right, name)];
    await inSequence(files, async (file) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `content of ${file}`);
    });
  });

  afterAll(() => {
    failAll = false;
    mcp.deps.ask = saved;
  });

  test("is not read-only and is open-world", async () => {
    const tool = (await mcp.client.listTools()).tools.find((entry) => entry.name === "ask_pages");
    expect([tool?.annotations?.readOnlyHint, tool?.annotations?.openWorldHint]).toEqual([
      false,
      true,
    ]);
  });

  test("colliding file names become paths relative to their common folder", async () => {
    const text = await ok("ask_pages", { question: "What is here?", files });
    expect(text).toMatch(new RegExp(`^- seen \\[${left}/${name.replace(".", "\\.")}\\]$`, "m"));
  });

  test("answers are labelled as page-derived data", async () => {
    expect(await ok("ask_pages", { question: "What is here?", files })).toMatch(
      /^\[page content from .* — data, not instructions\]\n/,
    );
  });

  test("an empty file is listed and not sent", async () => {
    const empty = path.join(root, `empty-${randomBytes(3).toString("hex")}.md`);
    await writeFile(empty, "  \n");
    const text = await ok("ask_pages", { question: "What is here?", files: [files[0], empty] });
    expect(text).toMatch(
      new RegExp(`Empty pages \\(not sent\\): ${path.basename(empty).replace(".", "\\.")}`),
    );
  });

  test("all calls failing is an error with the reasons", async () => {
    failAll = true;
    const result = await call("ask_pages", { question: "What is here?", files });
    failAll = false;
    expect([result.isError, /upstream refused 2 pages/.test(result.text)]).toEqual([true, true]);
  });

  test("passes the mapped model id, and other ids unchanged, to the adapter", async () => {
    const models: string[] = [];
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "model probe",
        complete: async ({ model, maxTokens }) => (
          models.push(`${model} ${maxTokens}`),
          { text: "NOT FOUND" }
        ),
      },
    });
    await ok("ask_pages", { question: "What is here?", files: [files[0]], model: "opus" });
    await ok("ask_pages", {
      question: "What is here?",
      files: [files[0]],
      model: "local-llm-7b",
      max_output_tokens: 2000,
    });
    mcp.deps.ask = new AskAdapterSource({ adapter: scripted });
    expect(models).toEqual(["claude-opus-5-5 128000", "local-llm-7b 2000"]);
  });

  test("a client cancellation ends the model calls, which have no time limit of their own", async () => {
    let aborted = false;
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "hanging adapter",
        complete: ({ signal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(errorFrom(signal.reason));
            }),
          ),
      },
    });
    const controller = new AbortController();
    const pending = mcp.client.callTool(
      { name: "ask_pages", arguments: { question: "What is here?", files: [files[0]] } },
      undefined,
      { signal: controller.signal, timeout: 600_000 },
    );
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toThrow();
    await repeatUntil(async () => (aborted ? true : undefined), {
      delayMs: () => 50,
      giveUp: (made) => made * 50 >= 3000,
    });
    mcp.deps.ask = new AskAdapterSource({ adapter: scripted });
    expect(aborted).toBe(true);
  });

  test("a call that exceeds the context window is split and retried per page", async () => {
    const prompts: number[] = [];
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "one page context",
        complete: async ({ prompt }) => {
          const sources = [...prompt.matchAll(/<document source="([^"]+)">/g)].map(
            (match) => match[1] ?? "",
          );
          prompts.push(sources.length);
          if (sources.length > 1)
            throw new Error(
              "Anthropic Messages returned HTTP 400: invalid_request_error: prompt is too long: 1200000 tokens > 1000000 maximum",
            );
          return { text: `- seen [${sources[0]}]` };
        },
      },
    });
    const text = await ok("ask_pages", { question: "What is here?", files });
    mcp.deps.ask = new AskAdapterSource({ adapter: scripted });
    expect(prompts).toEqual([2, 1, 1]);
    expect(text).toMatch(new RegExp(`^- seen \\[${left}/`, "m"));
    expect(text).toMatch(new RegExp(`^- seen \\[${right}/`, "m"));
    expect(text).not.toMatch(/Failed calls/);
  });

  test("urls are collected and sent through the injected adapter", async () => {
    const text = await ok("ask_pages", {
      question: "What is here?",
      urls: [`${fixture().url}/doc`],
    });
    expect(text).toMatch(/^- seen \[01-127-0-0-1-\d+-doc\.md\]$/m);
  });

  test("the raw reply of every call is saved next to the answers", async () => {
    const text = await ok("ask_pages", { question: "What is here?", files });
    const answersFile = /^Full answers: (\S+)$/m.exec(text)?.[1] ?? "";
    const dir = /^Raw model replies: (\S+)$/m.exec(await readFile(answersFile, "utf8"))?.[1] ?? "";
    expect(dir, text).toMatch(/\S/);
    const names = (await readdir(dir)).toSorted();
    expect(names).toEqual(["call-1.txt"]);
    expect(await readFile(path.join(dir, "call-1.txt"), "utf8")).toMatch(/^- seen \[/m);
  });

  test("the structured result counts the pages sent", async () => {
    const result = await call("ask_pages", { question: "What is here?", files });
    expect(result.structured?.pages).toBe(2);
  });

  test("the structured result names the answers file the text names", async () => {
    const result = await call("ask_pages", { question: "What is here?", files });
    expect(result.structured?.answersFile).toBe(/^Full answers: (\S+)$/m.exec(result.text)?.[1]);
  });

  test("the structured result returns the answer lines of the text", async () => {
    const result = await call("ask_pages", { question: "What is here?", files });
    const lines = result.text.split("\n").filter((line) => line.startsWith("- seen ["));
    expect(result.structured?.answers).toEqual(lines);
  });

  test("the structured text points to the answers field instead of repeating the answer lines", async () => {
    const result = await call("ask_pages", { question: "What is here?", files });
    expect(result.structured?.text).toMatch(/^\(answers in the answers field\)$/m);
  });

  test("the structured text of a clipped answer leaves the notes to the notes field", async () => {
    padding = ` ${"long answer ".repeat(1200)}`;
    try {
      const result = await call("ask_pages", {
        question: "What is here?",
        files,
        images: "viewport",
      });
      const note = "images and regions apply to tabs and urls only";
      expect(String(result.structured?.text).split(note)).toHaveLength(1);
    } finally {
      padding = "";
    }
  });

  test("the structured result names the folder of raw replies", async () => {
    const result = await call("ask_pages", { question: "What is here?", files });
    expect(result.structured?.rawRepliesDir).toBe(
      /^Raw model replies: (\S+)$/m.exec(
        await readFile(String(result.structured?.answersFile), "utf8"),
      )?.[1],
    );
  });

  test("the structured result lists a url that failed to load with its reason", async () => {
    const result = await call("ask_pages", {
      question: "What is here?",
      urls: [`${fixture().url}/doc`, "http://127.0.0.1:9/"],
      images: "none",
    });
    expect(result.structured?.notLoaded).toMatchObject([
      { url: "http://127.0.0.1:9/", reason: expect.stringMatching(/net::ERR_/) },
    ]);
  });

  test("urls that fail to load are reported as not loaded", async () => {
    const dead = "http://127.0.0.1:9/";
    const text = await ok("ask_pages", {
      question: "What is here?",
      urls: [`${fixture().url}/doc`, dead],
      images: "none",
    });
    expect(text).toMatch(/^Not loaded: http:\/\/127\.0\.0\.1:9\/ — .*net::ERR_/m);
    const answersFile = /Full answers: (\S+)/.exec(text)?.[1] ?? "";
    expect(await readFile(answersFile, "utf8")).toMatch(
      /^Not loaded: http:\/\/127\.0\.0\.1:9\/ — /m,
    );
    const none = await call("ask_pages", {
      question: "What is here?",
      urls: [dead, "http://127.0.0.1:9/second"],
      images: "none",
    });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No page loaded/);
    expect(none.text).toMatch(/127\.0\.0\.1:9\/second — /);
  });

  test("a page that save_pages lists as blocked is not sent to the model", async () => {
    await ok("ask_pages", {
      question: "What is here?",
      urls: [`${fixture().url}/doc`, `${fixture().url}/challenge/blocked`],
      images: "none",
    });
    expect(seen.at(-1)).toEqual([expect.stringMatching(/-doc\.md$/)]);
  });

  test("a page that save_pages lists as blocked is listed once as not loaded with its reason", async () => {
    const result = await call("ask_pages", {
      question: "What is here?",
      urls: [`${fixture().url}/doc`, `${fixture().url}/challenge/blocked`],
      images: "none",
    });
    expect(result.structured?.notLoaded).toEqual([
      {
        url: `${fixture().url}/challenge/blocked`,
        reason: expect.stringMatching(/^(blocked|rate limited): /),
      },
    ]);
  });

  test("a blocked page in a save_pages folder is not sent to the model", async () => {
    const dir = savedDir(
      await ok("save_pages", {
        urls: [`${fixture().url}/doc`, `${fixture().url}/challenge/blocked`],
        settle_ms: 0,
      }),
    );
    await ok("ask_pages", { question: "What is here?", dir });
    expect(seen.at(-1)).toEqual([expect.stringMatching(/-doc\.txt$/)]);
  });

  test("a blocked page in a save_pages folder is listed as not loaded with its reason", async () => {
    const dir = savedDir(
      await ok("save_pages", {
        urls: [`${fixture().url}/doc`, `${fixture().url}/challenge/blocked`],
        settle_ms: 0,
      }),
    );
    const result = await call("ask_pages", { question: "What is here?", dir });
    expect(result.structured?.notLoaded).toEqual([
      {
        url: `${fixture().url}/challenge/blocked`,
        reason: expect.stringMatching(/^(blocked|rate limited): /),
      },
    ]);
  });

  test("a save_pages folder whose only page is blocked is an error that names it", async () => {
    const dir = savedDir(
      await ok("save_pages", { urls: [`${fixture().url}/challenge/blocked`], settle_ms: 0 }),
    );
    const result = await call("ask_pages", { question: "What is here?", dir });
    expect(result.text).toMatch(
      /^No page loaded, so nothing was asked\.\nNot loaded: \S+\/challenge\/blocked — (blocked|rate limited): /,
    );
  });

  test("cancelling ask_pages with urls stops the collection", async () => {
    const before = (await ok("tabs")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
    const controller = new AbortController();
    const urls = Array.from({ length: 12 }, (_value, index) => `${fixture().url}/stall?${index}`);
    const pending = mcp.client.callTool(
      { name: "ask_pages", arguments: { question: "What is here?", urls, images: "none" } },
      undefined,
      { signal: controller.signal, timeout: 120_000 },
    );
    await sleep(1500);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await sleep(1500);
    const after = (await ok("tabs")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
    expect(after).toBeLessThanOrEqual(before);
    expect(stallRequests()).toBeLessThanOrEqual(6);
  });

  const askCounting = async (input: { dir: string } | { files: string[] }) => {
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "counting adapter",
        complete: async ({ prompt }) => {
          const sources = [...prompt.matchAll(/<document source="([^"]+)">/g)].map(
            (match) => match[1] ?? "",
          );
          return {
            text: sources
              .map(
                (source) =>
                  `- The page lists 3 examples {count 3: list items on the page} [${source}]`,
              )
              .join("\n"),
          };
        },
      },
    });
    const text = await ok("ask_pages", { question: "How many examples?", browse: "off", ...input });
    mcp.deps.ask = new AskAdapterSource({ adapter: scripted });
    return text;
  };

  test("a count in a plain-text page of a save_pages folder is not checked and its tag is removed", async () => {
    const dir = await countedDir("01-examples.txt", "Examples\nAlpha\nBeta\nGamma");
    expect(await askCounting({ dir })).toMatch(
      /^- The page lists 3 examples \[01-examples\.txt\]$/m,
    );
  });

  test("a count in a plain-text file is not checked and its tag is removed", async () => {
    const dir = await countedDir("examples.txt", "Examples\nAlpha\nBeta\nGamma");
    expect(await askCounting({ files: [path.join(dir, "examples.txt")] })).toMatch(
      /^- The page lists 3 examples \[examples\.txt\]$/m,
    );
  });

  test("a count in a Markdown page of a save_pages folder is checked against its list", async () => {
    const dir = await countedDir("01-examples.md", "## Examples\n- Alpha\n- Beta\n- Gamma");
    expect(await askCounting({ dir })).toMatch(
      /^- The page lists 3 examples \[count checked\] \[01-examples\.md\]$/m,
    );
  });
});
