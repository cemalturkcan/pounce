import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "../config/config.ts";
import { NoSecretStore } from "../shared/secrets.ts";
import { ToolError } from "../shared/errors.ts";
import { clipToFile, defineTool, type ToolDeps } from "./common.ts";
import { readLog } from "../log/logger.ts";
import { OutputStore, Redactor } from "../shared/output.ts";
import { createDeps } from "../server/setup.ts";
import { callTool, connectInMemory } from "../../tests/mcpHarness.ts";

async function withServer<T>(
  register: (server: McpServer, deps: ToolDeps) => void,
  run: (client: Client) => Promise<T>,
) {
  const workDir = await mkdtemp(path.join(tmpdir(), "web-agent-tool-input-"));
  const deps = createDeps(
    loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir }),
    new NoSecretStore(),
  );
  const server = new McpServer({ name: "units", version: "0" });
  register(server, deps);
  const client = await connectInMemory(server, "units");
  try {
    return await run(client);
  } finally {
    await client.close();
    await deps.log.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

function registerGreeter(
  server: McpServer,
  deps: ToolDeps,
  greet: (name: string) => Promise<{ text: string; data: { greeting: string; names: string[] } }>,
) {
  defineTool(server, deps, {
    name: "greet",
    title: "Greet",
    description: "Greet the name.",
    input: { name: z.string() },
    output: { greeting: z.string(), names: z.array(z.string()) },
    handler: async (input) => greet(input.name),
  });
}

const greeting = async (name: string) => ({
  text: `Hello ${name}`,
  data: { greeting: `Hello ${name}`, names: [name] },
});

test("a tool's input transforms run once per call", async () => {
  let transforms = 0;
  await withServer(
    (server, deps) =>
      defineTool(server, deps, {
        name: "echo",
        title: "Echo",
        description: "Echo the word.",
        input: {
          word: z.string().transform((word) => {
            transforms += 1;
            return word.toUpperCase();
          }),
        },
        handler: async (input) => input.word,
      }),
    (client) => client.callTool({ name: "echo", arguments: { word: "hi" } }),
  );
  expect(transforms).toBe(1);
});

test("a tool with an output shape lists its fields in the output schema", async () => {
  const listed = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => client.listTools(),
  );
  expect(Object.keys(listed.tools[0]?.outputSchema?.properties ?? {})).toEqual([
    "greeting",
    "names",
    "text",
    "notes",
  ]);
});

test("a tool with an output shape requires only its text, since a dialog can end it early", async () => {
  const listed = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => client.listTools(),
  );
  expect(listed.tools[0]?.outputSchema?.required).toEqual(["text"]);
});

test("a tool with an output shape returns its data as structured content", async () => {
  const result = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.structured).toMatchObject({ greeting: "Hello Ada", names: ["Ada"] });
});

test("a tool with an output shape repeats its text in the structured content", async () => {
  const result = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.structured?.text).toBe(result.text);
});

test("a tool with an output shape keeps its text content", async () => {
  const result = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.text).toBe("Hello Ada");
});

function registerReader(
  server: McpServer,
  deps: ToolDeps,
  read: () => Promise<{
    text: string;
    payloadFrame?: (shown: string) => string;
    data: { content?: string };
  }>,
) {
  defineTool(server, deps, {
    name: "read",
    title: "Read",
    description: "Read the content.",
    input: {},
    output: { content: z.string().optional() },
    payload: ["content"],
    handler: read,
  });
}

const PAGE_TEXT = "page";
const pageFrame = (shown: string) => `[page]\n${shown}\n[end]`;
const reading = async () => ({
  text: pageFrame(PAGE_TEXT),
  payloadFrame: pageFrame,
  data: { content: PAGE_TEXT },
});

test("a tool's structured text points to its payload field instead of repeating the payload", async () => {
  const result = await withServer(
    (server, deps) => registerReader(server, deps, reading),
    (client) => callTool(client, "read"),
  );
  expect(result.structured?.text).toBe("[page]\n(content in the content field)\n[end]");
});

test("a tool with a payload field keeps the payload in its text content", async () => {
  const result = await withServer(
    (server, deps) => registerReader(server, deps, reading),
    (client) => callTool(client, "read"),
  );
  expect(result.text).toBe(`[page]\n${PAGE_TEXT}\n[end]`);
});

test("a tool whose result leaves out its payload field keeps the payload in its structured text", async () => {
  const result = await withServer(
    (server, deps) =>
      registerReader(server, deps, async () => ({ ...(await reading()), data: {} })),
    (client) => callTool(client, "read"),
  );
  expect(result.structured?.text).toBe(`[page]\n${PAGE_TEXT}\n[end]`);
});

function registerNoted(
  server: McpServer,
  deps: ToolDeps,
  note: () => Promise<{
    text: string;
    structuredText?: string;
    data: { body?: string; notes?: string[] };
  }>,
) {
  defineTool(server, deps, {
    name: "noted",
    title: "Noted",
    description: "Return a body with a note.",
    input: {},
    output: { body: z.string().optional(), notes: z.array(z.string()).optional() },
    handler: note,
  });
}

const NOTE = "Note: the page moved.";

test("a tool's own structured text replaces its text in the structured content", async () => {
  const result = await withServer(
    (server, deps) =>
      registerNoted(server, deps, async () => ({
        text: "Saved to /tmp/a.jpg",
        structuredText: "Saved to (body in the body field)",
        data: { body: "/tmp/a.jpg" },
      })),
    (client) => callTool(client, "noted"),
  );
  expect(result.structured?.text).toBe("Saved to (body in the body field)");
});

test("a tool with notes points to its notes field in the structured text instead of repeating them", async () => {
  const result = await withServer(
    (server, deps) =>
      registerNoted(server, deps, async () => ({
        text: `body\n${NOTE}`,
        structuredText: "body",
        data: { notes: [NOTE] },
      })),
    (client) => callTool(client, "noted"),
  );
  expect(result.structured?.text).toBe("(notes in the notes field)\nbody");
});

test("a tool with notes keeps them in its text content", async () => {
  const result = await withServer(
    (server, deps) =>
      registerNoted(server, deps, async () => ({
        text: `body\n${NOTE}`,
        structuredText: "body",
        data: { notes: [NOTE] },
      })),
    (client) => callTool(client, "noted"),
  );
  expect(result.text).toBe(`body\n${NOTE}`);
});

test("structured content masks registered secrets like the text does", async () => {
  const result = await withServer(
    (server, deps) => {
      deps.redactor.register("token", "s3cr3t-value");
      registerGreeter(server, deps, greeting);
    },
    (client) => callTool(client, "greet", { name: "s3cr3t-value" }),
  );
  expect(result.structured).toEqual({
    greeting: "Hello <secret:token>",
    names: ["<secret:token>"],
    text: "Hello <secret:token>",
  });
});

test("a failing tool with an output shape returns its error as text", async () => {
  const result = await withServer(
    (server, deps) =>
      registerGreeter(server, deps, async () => {
        throw new ToolError("No greeting today.");
      }),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.text).toStartWith("No greeting today.");
});

test("a failing tool with an output shape returns no structured content", async () => {
  const result = await withServer(
    (server, deps) =>
      registerGreeter(server, deps, async () => {
        throw new ToolError("No greeting today.");
      }),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.structured).toBeUndefined();
});

test("a failing tool with an output shape returns the fields its error carries with the error text", async () => {
  const result = await withServer(
    (server, deps) =>
      registerGreeter(server, deps, async () => {
        throw new ToolError("No greeting today.", undefined, { greeting: "none" });
      }),
    (client) => callTool(client, "greet", { name: "Ada" }),
  );
  expect(result.structured).toStrictEqual({ greeting: "none", text: result.text });
});

test("a tool failing with an error that wraps another logs the wrapped error's stack", async () => {
  let log: ToolDeps["log"] | undefined;
  const entries = await withServer(
    (server, deps) => {
      log = deps.log;
      registerGreeter(server, deps, async () => {
        throw new ToolError("No greeting today.", undefined, undefined, {
          cause: new Error("the greeter broke"),
        });
      });
    },
    async (client) => {
      await callTool(client, "greet", { name: "Ada" });
      await log?.flush();
      return (await readLog(log?.dir ?? "", { tool: "greet", limit: 1 })).entries;
    },
  );
  expect(entries).toEqual([
    expect.objectContaining({ stack: expect.stringContaining("common.spec.ts") }),
  ]);
});

test("a call with an undeclared argument fails naming that argument", async () => {
  const result = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    (client) => callTool(client, "greet", { name: "Ada", nickname: "A" }),
  );
  expect(result.text).toMatch(/Invalid arguments for tool greet: .*"nickname"/);
});

test("a call with an undeclared argument does not run the tool", async () => {
  let runs = 0;
  await withServer(
    (server, deps) =>
      registerGreeter(server, deps, async (name) => {
        runs += 1;
        return greeting(name);
      }),
    (client) => callTool(client, "greet", { name: "Ada", nickname: "A" }),
  );
  expect(runs).toBe(0);
});

test("a tool's listed input schema forbids undeclared arguments", async () => {
  const tools = await withServer(
    (server, deps) => registerGreeter(server, deps, greeting),
    async (client) => (await client.listTools()).tools,
  );
  expect(tools[0]?.inputSchema.additionalProperties).toBe(false);
});

async function withStore<T>(run: (store: OutputStore) => Promise<T>) {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-clip-"));
  try {
    return await run(new OutputStore(root, new Redactor()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("clipToFile names the file that holds the full text of a clipped one", async () => {
  const saved = await withStore(async (store) => {
    const clipped = await clipToFile(store, "scripts", "long", "y".repeat(500), 100);
    return { clipped, content: await Bun.file(clipped.file ?? "").text() };
  });
  expect(saved.content).toBe("y".repeat(500));
});

test("clipToFile keeps a preview of a clipped text without the file note", async () => {
  const clipped = await withStore((store) =>
    clipToFile(store, "scripts", "long", "y".repeat(500), 100),
  );
  expect(clipped.preview).toMatch(/^y+… \[\d+ chars omitted\] …\ny+$/);
});

test("clipToFile names no file for text that fits", async () => {
  const clipped = await withStore((store) => clipToFile(store, "scripts", "short", "ok", 100));
  expect(clipped.file).toBe(undefined);
});
