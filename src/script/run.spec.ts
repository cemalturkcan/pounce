import { spawn } from "node:child_process";
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";

const HUNG_AFTER_MS = 4000;

const server = Bun.serve({
  port: 0,
  fetch: (request) => new Response(request.method === "POST" ? request.body : "served"),
});
const servedUrl = `http://127.0.0.1:${server.port}/`;

afterAll(() => server.stop(true));

const outcomeOf = z.object({ outcome: z.string(), elapsed: z.number() });

async function runScriptInChild(code: string, timeoutMs: number) {
  const scriptModule = new URL("./run.ts", import.meta.url).href;
  const source = `
    const { runScript } = await import(${JSON.stringify(scriptModule)});
    class Page { goto() { return new Promise((resolve) => setTimeout(() => resolve(null), 10)); } }
    const started = Date.now();
    const deps = {
      manager: { ensureContext: async () => ({}) },
      secrets: { list: async () => [] },
    };
    const outcome = await runScript(deps, "owner", { page: new Page() }, ${JSON.stringify(code)}, { timeoutMs: ${timeoutMs} })
      .then((result) => result.returned, (error) => error.message);
    process.stdout.write(JSON.stringify({ outcome, elapsed: Date.now() - started }));
  `;
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), HUNG_AFTER_MS);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.once("exit", () => {
      clearTimeout(killer);
      resolve(text || JSON.stringify({ outcome: "hung", elapsed: HUNG_AFTER_MS }));
    });
  });
  return parseJsonOrThrow(out, outcomeOf);
}

test("code after an await is stopped at timeout_ms", async () => {
  const result = await runScriptInChild("await sleep(10); while (true) {}", 500);
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a script's own global webAgentEnter survives its timer callbacks", async () => {
  const result = await runScriptInChild(
    'globalThis.webAgentEnter = () => "mine"; await new Promise((resolve) => setTimeout(resolve, 10)); return webAgentEnter();',
    5000,
  );
  expect(result.outcome).toBe("mine");
});

test("a script that locks its own global webAgentEnter still has its timer callbacks run", async () => {
  const result = await runScriptInChild(
    'Object.defineProperty(globalThis, "webAgentEnter", { value: () => "mine" }); return await new Promise((resolve) => setTimeout(() => resolve("ran"), 10));',
    1000,
  );
  expect(result.outcome).toBe("ran");
});

test("a timer callback of a script with its own global webAgentEnter is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    'globalThis.webAgentEnter = () => "mine"; setTimeout(() => { while (true) {} }, 10); await sleep(5000);',
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on a page method's promise is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    'await page.goto("about:blank").then(() => { while (true) {} });',
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on a scope helper's promise is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    "await secrets.list().then(() => { while (true) {} });",
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on sleep's promise is stopped at timeout_ms", async () => {
  const result = await runScriptInChild("await sleep(10).then(() => { while (true) {} });", 500);
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on fetch's promise is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    `await fetch(${JSON.stringify(servedUrl)}).then(() => { while (true) {} });`,
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on a fetched response's text is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    `const response = await fetch(${JSON.stringify(servedUrl)}); await response.text().then(() => { while (true) {} });`,
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop chained on a response body reader is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    `const response = await fetch(${JSON.stringify(servedUrl)}); await response.body.getReader().read().then(() => { while (true) {} });`,
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a fetched response's text still reaches the script", async () => {
  const result = await runScriptInChild(
    `return await (await fetch(${JSON.stringify(servedUrl)})).text();`,
    5000,
  );
  expect(result.outcome).toBe("served");
});

test("a fetched response's body can be read with for await", async () => {
  const result = await runScriptInChild(
    `const decoder = new TextDecoder(); let text = ""; for await (const chunk of (await fetch(${JSON.stringify(servedUrl)})).body) text += decoder.decode(chunk); return text;`,
    5000,
  );
  expect(result.outcome).toBe("served");
});

test("a loop chained on a response body iterator is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    `const chunks = (await fetch(${JSON.stringify(servedUrl)})).body[Symbol.asyncIterator](); await chunks.next().then(() => { while (true) {} });`,
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a fetched response's body can be sent as another fetch's body", async () => {
  const result = await runScriptInChild(
    `const first = await fetch(${JSON.stringify(servedUrl)}); return await (await fetch(${JSON.stringify(servedUrl)}, { method: "POST", body: first.body, duplex: "half" })).text();`,
    5000,
  );
  expect(result.outcome).toBe("served");
});

test("a loop in a listener on the script's signal is stopped", async () => {
  const result = await runScriptInChild(
    'signal.addEventListener("abort", () => { while (true) {} }); await sleep(5000);',
    500,
  );
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a listener on the script's signal still runs when the script is stopped", async () => {
  const result = await runScriptInChild(
    'signal.addEventListener("abort", () => log("cleaned up")); await sleep(5000);',
    500,
  );
  expect(result.outcome).toMatch(/Logs so far:\ncleaned up/);
});

test("a returned value whose serialization loops is stopped", async () => {
  const result = await runScriptInChild("return { toJSON() { while (true) {} } };", 500);
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});
