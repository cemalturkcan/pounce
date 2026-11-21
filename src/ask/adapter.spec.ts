import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  type AskAdapter,
  type AskToolDefinition,
  completeLogged,
  converseLogged,
  failureReason,
  jsonObjectSchema,
  modelId,
  supportsTools,
} from "./adapter.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { logFileName, Logger, useLogger } from "../log/logger.ts";
import { Redactor } from "../shared/output.ts";
import { z } from "zod";

let dir: string;
let logger: Logger;
const redactor = new Redactor();

async function entries() {
  await logger.flush();
  const raw = await readFile(path.join(dir, logFileName(Date.now())), "utf8");
  return {
    raw,
    list: raw
      .split("\n")
      .filter(Boolean)
      .map((line) => parseJsonOrThrow(line, jsonObjectSchema)),
  };
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "web-agent-adapter-log-"));
  logger = new Logger({ dir, redactor, stderr: () => undefined });
  useLogger(logger);
});

afterAll(async () => {
  useLogger(undefined);
  await rm(dir, { recursive: true, force: true });
});

const input = (signal = new AbortController().signal) => ({
  system: "sys",
  prompt: "page text that must not be logged",
  model: "claude-haiku-5-5",
  maxTokens: 100,
  images: [
    { mediaType: "image/png" as const, data: "AAAA" },
    { mediaType: "image/jpeg" as const, data: "BBBBBBBB" },
  ],
  signal,
});

test("a successful model call is logged with its numbers and no content", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({
      text: "answer text",
      stopReason: "end_turn",
      usage: { input_tokens: 1200, output_tokens: 30 },
    }),
  };
  const reply = await completeLogged(adapter, input(), { tool: "ask_pages", call: 2, pages: 5 });
  expect(reply.text).toBe("answer text");
  const { raw, list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.call === 2);
  expect(entry).toBeDefined();
  expect(entry?.level).toBe("info");
  expect(entry?.tool).toBe("ask_pages");
  expect(entry?.adapter).toBe("fake");
  expect(entry?.model).toBe("claude-haiku-5-5");
  expect(entry?.pages).toBe(5);
  expect(entry?.images).toBe(2);
  expect(entry?.imageBytes).toBe(12);
  expect(entry?.stopReason).toBe("end_turn");
  expect(entry?.usage).toStrictEqual({ input_tokens: 1200, output_tokens: 30 });
  expect(entry?.ok).toBe(true);
  expect(entry?.ms).toBeNumber();
  expect(raw).not.toMatch(/must not be logged|answer text|AAAA/);
});

test("a failed model call is logged at warn with the redacted first error line and rethrown", async () => {
  redactor.register("api", "sk-ant-secret-key-1234");
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => {
      throw new Error("401 invalid key sk-ant-secret-key-1234\nsecond line detail");
    },
  };
  await expect(
    completeLogged(adapter, input(), { tool: "compare_design", call: "r3" }),
  ).rejects.toThrow(/401 invalid key/);
  const { raw, list } = await entries();
  const entry = list.find(
    (candidate) => candidate.event === "model_call" && candidate.call === "r3",
  );
  expect(entry).toBeDefined();
  expect(entry?.level).toBe("warn");
  expect(entry?.ok).toBe(false);
  expect(entry?.tool).toBe("compare_design");
  expect(entry?.error).toBe("401 invalid key <secret:api>");
  expect(raw).not.toMatch(/sk-ant-secret-key-1234|second line detail/);
});

test("an interrupted stream is logged at warn with its stop reason", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({
      text: "partial",
      stopReason: "interrupted",
      usage: { output_tokens: 7 },
    }),
  };
  const reply = await completeLogged(adapter, input(), { tool: "ask_pages", call: 9, pages: 1 });
  expect(reply.stopReason).toBe("interrupted");
  const { list } = await entries();
  const entry = list.find((candidate) => candidate.event === "model_call" && candidate.call === 9);
  expect(entry).toBeDefined();
  expect(entry?.level).toBe("warn");
  expect(entry?.ok).toBe(true);
  expect(entry?.stopReason).toBe("interrupted");
});

const converseInput = (signal = new AbortController().signal) => ({
  system: "browse system",
  tools: [
    { name: "find", description: "find things", inputSchema: { type: "object" } },
  ] satisfies AskToolDefinition[],
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "page text that must not be logged" }],
    },
    {
      role: "assistant" as const,
      content: [{ type: "tool_use" as const, id: "tu1", name: "screenshot", input: {} }],
    },
    {
      role: "user" as const,
      content: [
        {
          type: "tool_result" as const,
          toolUseId: "tu1",
          content: [
            { type: "text" as const, text: "result text" },
            { type: "image" as const, image: { mediaType: "image/jpeg" as const, data: "CCCCCC" } },
          ],
        },
      ],
    },
  ],
  model: "claude-haiku-5-5",
  maxTokens: 1000,
  signal,
  conversationId: "c1",
});

test("a converse call is logged with its request, page, step, tool uses and stop reason and no content", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({ text: "" }),
    converse: async () => ({
      content: [
        { type: "text", text: "secret reasoning text" },
        { type: "tool_use", id: "tu2", name: "click", input: { target: "e5" } },
      ],
      stopReason: "tool_use",
      usage: { input_tokens: 50 },
    }),
  };
  const reply = await converseLogged(adapter, converseInput(), {
    tool: "ask_pages.browse",
    call: 4,
    requestId: "abc123",
    page: "02-acme.md",
    step: 4,
  });
  expect(reply.stopReason).toBe("tool_use");
  const { raw, list } = await entries();
  const entry = list.find(
    (candidate) => candidate.event === "model_call" && candidate.requestId === "abc123",
  );
  expect(entry).toBeDefined();
  expect(entry?.level).toBe("info");
  expect(entry?.tool).toBe("ask_pages.browse");
  expect(entry?.page).toBe("02-acme.md");
  expect(entry?.step).toBe(4);
  expect(entry?.messages).toBe(3);
  expect(entry?.toolResults).toBe(1);
  expect(entry?.images).toBe(1);
  expect(entry?.imageBytes).toBe(6);
  expect(entry?.toolUses).toStrictEqual(["click"]);
  expect(entry?.stopReason).toBe("tool_use");
  expect(entry?.usage).toStrictEqual({ input_tokens: 50 });
  expect(raw).not.toMatch(/must not be logged|result text|secret reasoning|CCCCCC|e5/);
});

test("a refused converse call is logged at warn", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({ text: "" }),
    converse: async () => ({ content: [], stopReason: "refusal" }),
  };
  await converseLogged(adapter, converseInput(), {
    tool: "ask_pages.browse",
    call: 1,
    requestId: "ref001",
    page: "p",
    step: 1,
  });
  const { list } = await entries();
  const entry = list.find(
    (candidate) => candidate.event === "model_call" && candidate.requestId === "ref001",
  );
  expect(entry?.level).toBe("warn");
});

test("a failing converse call is logged at warn with its first error line and rethrown", async () => {
  const adapter: AskAdapter = {
    name: "fake",
    complete: async () => ({ text: "" }),
    converse: async () => {
      throw new Error("overloaded\nsecond line detail");
    },
  };
  await expect(
    converseLogged(adapter, converseInput(), {
      tool: "ask_pages.browse",
      call: 2,
      requestId: "err001",
      page: "p",
      step: 2,
    }),
  ).rejects.toThrow(/overloaded/);
  const { raw, list } = await entries();
  const entry = list.find(
    (candidate) => candidate.event === "model_call" && candidate.requestId === "err001",
  );
  expect(entry?.level).toBe("warn");
  expect(entry?.ok).toBe(false);
  expect(entry?.error).toBe("overloaded");
  expect(raw).not.toMatch(/second line detail/);
});

test("supportsTools is false without converse and true with it", () => {
  expect(supportsTools({ name: "plain", complete: async () => ({ text: "" }) })).toBe(false);
  expect(
    supportsTools({
      name: "tools",
      complete: async () => ({ text: "" }),
      converse: async () => ({ content: [] }),
    }),
  ).toBe(true);
});

test("modelId maps the short names and passes any other id through", () => {
  expect(modelId("haiku")).toBe("claude-haiku-5-5");
  expect(modelId("sonnet")).toBe("claude-sonnet-5-5");
  expect(modelId("opus")).toBe("claude-opus-5-5");
  expect(modelId("Opus")).toBe("claude-opus-5-5");
  expect(modelId("my-local-model")).toBe("my-local-model");
});

test("failureReason of a schema mismatch names its first issue", () => {
  const mismatch = z.object({ text: z.string() }).safeParse({ text: 7 });
  expect(failureReason(mismatch.error, undefined)).toBe(
    "The data does not have the expected form: Invalid input: expected string, received number at text",
  );
});
