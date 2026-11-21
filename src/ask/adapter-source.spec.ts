import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createExampleGateway } from "../../tests/unitExampleGateway.ts";
import { token } from "../../tests/askFixtures.ts";
import type { AskAdapter } from "./adapter.ts";
import { AskAdapterSource, loadAdapterModule } from "./adapter-source.ts";

const gateway = createExampleGateway();

beforeAll(() => gateway.listen());
afterEach(() => gateway.reset());
afterAll(() => gateway.close());

test("loadAdapterModule accepts an adapter or a factory and rejects other shapes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-adapter-"));
  try {
    const write = async (name: string, body: string) => {
      const file = path.join(dir, name);
      await writeFile(file, body);
      return file;
    };
    const direct = await loadAdapterModule(
      await write(
        "direct.mjs",
        'export default { name: "direct", complete: async () => ({ text: "ok" }) };',
      ),
    );
    expect(direct.name).toBe("direct");
    expect(
      (
        await direct.complete({
          system: "",
          prompt: "",
          model: "m",
          maxTokens: 1,
          signal: new AbortController().signal,
        })
      ).text,
    ).toBe("ok");
    const factory = await loadAdapterModule(
      await write(
        "factory.mjs",
        'export default async () => ({ name: "made", complete: async () => ({ text: "" }) });',
      ),
    );
    expect(factory.name).toBe("made");
    await expect(
      loadAdapterModule(await write("wrong.mjs", "export default { name: 'x' };")),
    ).rejects.toThrow(/wrong shape[\s\S]*default export/);
    await expect(
      loadAdapterModule(await write("none.mjs", "export const adapter = 1;")),
    ).rejects.toThrow(/wrong shape/);
    await expect(loadAdapterModule(path.join(dir, "missing.mjs"))).rejects.toThrow(
      /Could not load the ask adapter at .*missing\.mjs/,
    );
    await expect(loadAdapterModule("relative.mjs")).rejects.toThrow(/must be an absolute path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const writeAdapter = (file: string, name: string) =>
  writeFile(
    file,
    `export default { name: ${JSON.stringify(name)}, complete: async () => ({ text: "ok" }) };`,
  );

test("resolution order is modulePath, then the default file when it exists, then the code adapter", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-order-"));
  try {
    const modulePath = path.join(dir, "env.mjs");
    const defaultPath = path.join(dir, "ask-adapter.mjs");
    await writeAdapter(modulePath, "from env");
    const code: AskAdapter = { name: "from code", complete: async () => ({ text: "" }) };
    expect(
      (await new AskAdapterSource({ modulePath, defaultPath, adapter: code }).get()).name,
    ).toBe("from env");
    const source = new AskAdapterSource({ defaultPath, adapter: code });
    expect((await source.get()).name).toBe("from code");
    expect(source.label).toBe("from code");
    await writeAdapter(defaultPath, "owner default");
    expect((await source.get()).name).toBe("owner default");
    expect(source.label).toBe(`owner default (${defaultPath})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a modulePath that does not exist is a load error, not a silent fallback", async () => {
  const missing = path.join(tmpdir(), `no-adapter-${token()}.mjs`);
  const source = new AskAdapterSource({
    modulePath: missing,
    adapter: { name: "from code", complete: async () => ({ text: "" }) },
  });
  await expect(source.get()).rejects.toThrow(/Could not load the ask adapter/);
});

test("loadAdapterModule loads a TypeScript adapter module", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-adapter-"));
  try {
    const file = path.join(dir, "typed.ts");
    await writeFile(
      file,
      'type Reply = { text: string };\nexport default { name: "typed", complete: async (): Promise<Reply> => ({ text: "typed ok" }) };',
    );
    const adapter = await loadAdapterModule(file);
    const reply = await adapter.complete({
      system: "",
      prompt: "",
      model: "m",
      maxTokens: 1,
      signal: new AbortController().signal,
    });
    expect(reply.text).toBe("typed ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the label names a module by path until it has loaded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ask-adapter-"));
  try {
    const file = path.join(dir, "named.mjs");
    await writeAdapter(file, "named module");
    const fromModule = new AskAdapterSource({
      modulePath: file,
      adapter: { name: "from code", complete: async () => ({ text: "" }) },
    });
    expect(fromModule.label).toBe(`module ${file}`);
    await fromModule.get();
    expect(fromModule.label).toBe(`named module (${file})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the example adapter's converse sends tools and tool results and replays raw blocks unchanged", async () => {
  const example = await loadAdapterModule(
    path.resolve(import.meta.dirname, "..", "..", "examples", "ask-adapter.example.ts"),
  );
  const thinking = { type: "thinking", thinking: "", signature: "c2ln" };
  gateway.respondWith({
    content: [thinking, { type: "tool_use", id: "tu2", name: "find", input: { query: "x" } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 3, output_tokens: 1 },
  });
  expect(example.converse).toBeFunction();
  const reply = await example.converse?.({
    system: "SYS",
    tools: [{ name: "find", description: "find", inputSchema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          { type: "opaque", raw: thinking },
          {
            type: "tool_use",
            id: "tu1",
            name: "find",
            input: {},
            raw: { type: "tool_use", id: "tu1", name: "find", input: {} },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "tu1",
            content: [
              { type: "text", text: "r" },
              { type: "image", image: { mediaType: "image/jpeg", data: "CCCC" } },
            ],
          },
        ],
      },
    ],
    model: "m",
    maxTokens: 10,
    signal: new AbortController().signal,
    conversationId: "c",
  });
  expect(gateway.received.body?.tools).toStrictEqual([
    { name: "find", description: "find", input_schema: { type: "object" } },
  ]);
  expect(gateway.received.body?.messages[1]?.content[0]).toStrictEqual(thinking);
  expect(gateway.received.body?.messages[2]?.content[0]).toStrictEqual({
    type: "tool_result",
    tool_use_id: "tu1",
    content: [
      { type: "text", text: "r" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "CCCC" } },
    ],
  });
  expect(reply?.stopReason).toBe("tool_use");
  expect(reply?.content[0]).toStrictEqual({ type: "opaque", raw: thinking });
  expect(reply?.content[1]?.type).toBe("tool_use");
});
