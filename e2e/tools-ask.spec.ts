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
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture } = useToolsHarness("tools-ask");

describe("ask_pages edge cases through the tool", () => {
  let saved: ToolDeps["ask"];
  const seen: string[][] = [];
  let failAll = false;
  const scripted: AskAdapter = {
    name: "scripted adapter",
    complete: async ({ prompt }) => {
      const sources = [...prompt.matchAll(/<document source="([^"]+)">/g)].map(
        (match) => match[1] ?? "",
      );
      seen.push(sources);
      if (failAll) throw new Error(`upstream refused ${sources.length} pages`);
      return { text: sources.map((source) => `- seen [${source}]`).join("\n") };
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
    const dir = /^Raw model replies: (\S+)$/m.exec(text)?.[1] ?? "";
    expect(dir, text).toMatch(/\S/);
    const names = (await readdir(dir)).toSorted();
    expect(names).toEqual(["call-1.txt"]);
    expect(await readFile(path.join(dir, "call-1.txt"), "utf8")).toMatch(/^- seen \[/m);
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

  test("cancelling ask_pages with urls stops the collection", async () => {
    const before = (await ok("tabs_list")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
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
    const after = (await ok("tabs_list")).split("\n").filter((line) => /^t\d+ /.test(line)).length;
    expect(after).toBeLessThanOrEqual(before);
    expect(stallRequests()).toBeLessThanOrEqual(6);
  });
});
