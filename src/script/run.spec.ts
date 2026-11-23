import { spawn } from "node:child_process";
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import { VALUE_CASES } from "../../tests/valueCases.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { CLOSED_HINT } from "../shared/errors.ts";

const HUNG_AFTER_MS = 4000;

const server = Bun.serve({
  port: 0,
  fetch: (request) => new Response(request.method === "POST" ? request.body : "served"),
});
const servedUrl = `http://127.0.0.1:${server.port}/`;

afterAll(() => server.stop(true));

const outcomeOf = z.object({
  outcome: z.string(),
  elapsed: z.number(),
  lag: z.number(),
  listeners: z.number(),
  value: z.unknown().optional(),
  undefined: z.literal(true).optional(),
  logs: z.array(z.string()).optional(),
  error: z.unknown().optional(),
  streamed: z.array(z.string()).optional(),
  faults: z.array(z.string()),
});

async function runScriptInChild(code: string, timeoutMs: number, cancelAfterMs = 0, lingerMs = 0) {
  const scriptModule = new URL("./run.ts", import.meta.url).href;
  const errorsModule = new URL("../shared/errors.ts", import.meta.url).href;
  const faultsModule = new URL("../log/faults.ts", import.meta.url).href;
  const source = `
    const { EventEmitter } = await import("node:events");
    const { runScript } = await import(${JSON.stringify(scriptModule)});
    const { ToolError } = await import(${JSON.stringify(errorsModule)});
    const { recentFaults } = await import(${JSON.stringify(faultsModule)});
    class Page extends EventEmitter {
      goto() { return new Promise((resolve) => setTimeout(() => resolve(null), 10)); }
      url() { return "about:fake"; }
      ping(value) { setTimeout(() => this.emit("ping", value), 10); return Promise.resolve(); }
      fail() { return Promise.reject(new Error("page.fail: the page refused")); }
      shut() { return Promise.reject(new Error("click: Target page, context or browser has been closed")); }
      refuse() { return Promise.reject("the page refused in plain text"); }
      lose() { return Promise.reject(new ToolError("Tab t9 is not open.", "List tabs with tabs.")); }
      expire() { const error = new Error("click: Timeout 500ms exceeded.\\nCall log:\\n\\u001b[2m  - waiting for locator('#missing')\\u001b[22m\\n"); error.name = "TimeoutError"; return Promise.reject(error); }
      expireLater() { return new Promise((resolve) => setTimeout(resolve, 100)).then(() => this.expire()); }
      poison() { setTimeout(() => this.emit("ping", { get broken() { throw new Error("unreadable event"); } }), 10); return Promise.resolve(); }
    }
    const page = new Page();
    const started = Date.now();
    let lag = 0;
    let last = Date.now();
    const probe = setInterval(() => { lag = Math.max(lag, Date.now() - last - 20); last = Date.now(); }, 20);
    const controller = new AbortController();
    if (${cancelAfterMs}) setTimeout(() => controller.abort(), ${cancelAfterMs});
    const deps = {
      manager: { config: { engine: "patchright" }, ensureContext: async () => ({}), holdRendering: () => () => undefined, tabOf: (candidate) => (candidate === page ? { id: "t1" } : undefined) },
      secrets: { list: async () => [] },
    };
    let value;
    let returnedUndefined;
    let logs;
    let error;
    const streamed = [];
    const outcome = await runScript(deps, "owner", { page }, ${JSON.stringify(code)}, { timeoutMs: ${timeoutMs}, signal: controller.signal, onLog: (line) => streamed.push(line) })
      .then((result) => { value = result.value; returnedUndefined = result.undefined; logs = result.logs; return result.returned; }, (failure) => { error = failure.data?.error; return failure.message; });
    await new Promise((resolve) => setTimeout(resolve, ${lingerMs}));
    clearInterval(probe);
    lag = Math.max(lag, Date.now() - last - 20);
    process.stdout.write(JSON.stringify({ outcome, elapsed: Date.now() - started, lag, listeners: page.listenerCount("ping"), value, undefined: returnedUndefined, logs, error, streamed, faults: recentFaults(20).map((fault) => fault.source) }));
    process.exit(0);
  `;
  const out = await new Promise<string>((resolve) => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), HUNG_AFTER_MS);
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => (text += chunk.toString()));
    child.once("exit", () => {
      clearTimeout(killer);
      resolve(
        text ||
          JSON.stringify({
            outcome: "hung",
            elapsed: HUNG_AFTER_MS,
            lag: 0,
            listeners: 0,
            faults: [],
          }),
      );
    });
  });
  return parseJsonOrThrow(out, outcomeOf);
}

test("a synchronous loop leaves the server's thread free", async () => {
  const result = await runScriptInChild("while (true) {}", 1000);
  expect(result.lag).toBeLessThan(200);
});

test("a synchronous loop is ended by timeout_ms", async () => {
  const result = await runScriptInChild("while (true) {}", 500);
  expect(result.outcome).toMatch(/timed out after 500 ms/);
});

test("a synchronous loop is ended when the caller cancels", async () => {
  const result = await runScriptInChild("while (true) {}", 5000, 300);
  expect(result.outcome).toBe("The script was cancelled.");
});

test("a synchronous page method returns its value at once", async () => {
  const result = await runScriptInChild("return page.url();", 5000);
  expect(result.outcome).toBe("about:fake");
});

test("a page listener of the script receives the event", async () => {
  const result = await runScriptInChild(
    'let seen = "none"; page.on("ping", (value) => { seen = value; }); await page.ping("pong"); await sleep(100); return seen;',
    5000,
  );
  expect(result.outcome).toBe("pong");
});

test("a page listener of the script is removed when the script returns", async () => {
  const result = await runScriptInChild('page.on("ping", () => undefined); return 1;', 5000);
  expect(result.listeners).toBe(0);
});

test("a page handle keeps its identity across calls", async () => {
  const result = await runScriptInChild(
    'const emitter = page.on("ping", () => undefined); return emitter === page;',
    5000,
  );
  expect(result.outcome).toBe("true");
});

test("a page passed to a scope helper reaches it as the page", async () => {
  const result = await runScriptInChild("return tabId(page);", 5000);
  expect(result.outcome).toBe("t1");
});

test("code after an await is stopped at timeout_ms", async () => {
  const result = await runScriptInChild("await sleep(10); while (true) {}", 500);
  expect(result.outcome).toMatch(/timed out after 500 ms/);
  expect(result.elapsed).toBeLessThan(2000);
});

test("a loop in a timer callback is stopped at timeout_ms", async () => {
  const result = await runScriptInChild(
    "setTimeout(() => { while (true) {} }, 10); await sleep(5000);",
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

for (const { name, code, value } of VALUE_CASES) {
  test(`run_script: ${name}`, async () => {
    const result = await runScriptInChild(code, 5000);
    expect(result.value).toStrictEqual(value);
  });
}

test("run_script: undefined is marked as undefined", async () => {
  const result = await runScriptInChild("return undefined;", 5000);
  expect(result.undefined).toBe(true);
});

test("run_script: a revoked Proxy in the returned value is marked as unconvertible", async () => {
  const result = await runScriptInChild(
    "const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return { broken: proxy };",
    3000,
  );
  expect(result.value).toStrictEqual({
    broken: expect.stringMatching(/^\[Unconvertible: TypeError: .+\]$/),
  });
});

test("run_script: a DOMException keeps its name like an Error", async () => {
  const result = await runScriptInChild(
    "const controller = new AbortController(); controller.abort(); return controller.signal.reason;",
    5000,
  );
  expect(result.value).toMatchObject({ name: "AbortError" });
});

test("run_script: a returned Symbol is marked as undefined", async () => {
  const result = await runScriptInChild('return Symbol("s");', 5000);
  expect(result.undefined).toBe(true);
});

test("run_script: a logged Map is the list of its entries", async () => {
  const result = await runScriptInChild("log(new Map([[1, 2]]));", 5000);
  expect(result.logs).toStrictEqual(["[[1,2]]"]);
});

test("run_script: a logged Set is the list of its values", async () => {
  const result = await runScriptInChild("log(new Set([1]));", 5000);
  expect(result.logs).toStrictEqual(["[1]"]);
});

test("run_script: a logged NaN is the text NaN", async () => {
  const result = await runScriptInChild("log(NaN);", 5000);
  expect(result.logs).toStrictEqual(["NaN"]);
});

test("run_script: a logged Error keeps its name and message", async () => {
  const result = await runScriptInChild(
    'const error = new Error("le"); error.stack = ""; log(error);',
    5000,
  );
  expect(result.logs).toStrictEqual(['{"name":"Error","message":"le"}']);
});

const thrownTypeError = "const ready = 1;\nthrow new TypeError('bad');";

test("run_script: a thrown TypeError keeps its name in the structured error", async () => {
  const result = await runScriptInChild(thrownTypeError, 5000);
  expect(result.error).toMatchObject({ name: "TypeError", message: "bad" });
});

test("run_script: a thrown error's stack names the script line it was thrown on", async () => {
  const result = await runScriptInChild(thrownTypeError, 5000);
  expect(result.error).toMatchObject({
    stack: expect.stringMatching(/^at .*run_script\.js:2:\d+/),
  });
});

test("run_script: a thrown error's stack leaves out the server's own frames", async () => {
  const result = await runScriptInChild(thrownTypeError, 5000);
  expect(result.error).toMatchObject({
    stack: expect.not.stringMatching(/worker\.ts|runInContext/),
  });
});

test("run_script: a thrown error after a log line keeps its name in the structured error", async () => {
  const result = await runScriptInChild(`log("first");\n${thrownTypeError}`, 5000);
  expect(result.error).toMatchObject({ name: "TypeError", message: "bad" });
});

test("run_script: a thrown error's text starts with its name and message", async () => {
  const result = await runScriptInChild(thrownTypeError, 5000);
  expect(result.outcome).toMatch(/^TypeError: bad\n/);
});

test("run_script: a thrown error's text shows the script line it was thrown on", async () => {
  const result = await runScriptInChild(thrownTypeError, 5000);
  expect(result.outcome).toMatch(/\n {4}at .*run_script\.js:2:\d+/);
});

test("run_script: a thrown string is the structured error's message", async () => {
  const result = await runScriptInChild('throw "plain";', 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: "plain" });
});

test("run_script: a timed-out script carries its stop message in the structured error", async () => {
  const result = await runScriptInChild("await sleep(5000);", 500);
  expect(result.error).toStrictEqual({
    name: "Error",
    message: "run_script timed out after 500 ms.",
  });
});

test("run_script: an error from a browser call keeps its text without a name in front", async () => {
  const result = await runScriptInChild("await page.fail();", 5000);
  expect(result.outcome).toBe("page.fail: the page refused");
});

const malformedErrors = [
  {
    name: "a thrown error with a number for its name",
    code: "const error = new Error('x'); error.name = 42; throw error;",
    error: { name: "42", message: "x" },
  },
  {
    name: "a thrown error with an object for its message",
    code: "const error = new Error('x'); error.message = { a: 1 }; throw error;",
    error: { name: "Error", message: "[object Object]" },
  },
  {
    name: "a thrown error whose name getter gives undefined",
    code: "class Odd extends Error { get name() { return undefined; } }\nthrow new Odd('z');",
    error: { name: "Error", message: "z" },
  },
  {
    name: "a thrown error whose name getter throws",
    code: "class Odd extends Error { get name() { throw new Error('no name'); } }\nthrow new Odd('n');",
    error: { name: "[Unconvertible: Error: no name]", message: "n" },
  },
  {
    name: "a thrown error whose stack is the list of frames",
    code: "Error.prepareStackTrace = (error, frames) => frames;\nthrow new Error('pst');",
    error: { name: "Error", message: "pst" },
  },
  {
    name: "a thrown error whose stack getter throws",
    code: "const error = new Error('y'); Object.defineProperty(error, 'stack', { get() { throw new Error('nope'); } }); throw error;",
    error: { name: "Error", message: "y" },
  },
  {
    name: "a thrown error whose hint getter throws",
    code: "const error = new Error('h'); Object.defineProperty(error, 'hint', { get() { throw new Error('nope'); } }); throw error;",
    error: { name: "Error", message: "h" },
  },
  {
    name: "a thrown object without a prototype",
    code: "throw Object.create(null);",
    error: { name: "Error", message: "{}" },
  },
  {
    name: "a thrown revoked Proxy",
    code: "const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); throw proxy;",
    error: { name: "Error", message: expect.stringMatching(/^\[Unconvertible: TypeError: .+\]$/) },
  },
];

for (const { name, code, error } of malformedErrors) {
  test(`run_script: ${name} still fails the script with its error`, async () => {
    const result = await runScriptInChild(code, 3000);
    expect(result.error).toMatchObject(error);
  });
}

test("run_script: a failed browser call is the structured error's message as the text describes it", async () => {
  const result = await runScriptInChild("await page.expire();", 5000);
  expect(result.error).toMatchObject({ message: result.outcome });
});

test("run_script: a failed browser call's structured error has no name of its own", async () => {
  const result = await runScriptInChild("await page.expire();", 5000);
  expect(result.error).toMatchObject({ name: "Error" });
});

test("run_script: a failed browser call's text is its described form", async () => {
  const result = await runScriptInChild("await page.expire();", 5000);
  expect(result.outcome).toStartWith("Nothing matched #missing within 0.5 s.\n");
});

test("run_script: a failed helper call's structured error does not name the server's error class", async () => {
  const result = await runScriptInChild("await compareDesign(undefined, 'x.png');", 5000);
  expect(result.error).toStrictEqual({
    name: "Error",
    message: "compareDesign is not available in this script context.",
  });
});

const expiredText =
  "Nothing matched #missing within 0.5 s.\nTake a snapshot to see the current page, then retry with a ref or selector from it.";
const wrappedExpire =
  "try { await page.expire(); } catch (error) { throw new Error('step 2: ' + error.message); }";

test("run_script: a script error wrapping a failed browser call keeps the script's words in its text", async () => {
  const result = await runScriptInChild(wrappedExpire, 5000);
  expect(result.outcome).toStartWith(`Error: step 2: ${expiredText}\n    at `);
});

test("run_script: a script error wrapping a failed browser call gives the described call in its structured message", async () => {
  const result = await runScriptInChild(wrappedExpire, 5000);
  expect(result.error).toMatchObject({ name: "Error", message: `step 2: ${expiredText}` });
});

test("run_script: a script error wrapping a failed browser call keeps its script line", async () => {
  const result = await runScriptInChild(wrappedExpire, 5000);
  expect(result.error).toMatchObject({
    stack: expect.stringMatching(/^at .*run_script\.js:1:\d+/),
  });
});

test("run_script: a script error appending to a failed browser call's message keeps the appended words", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { throw new Error(error.message + ' (login)'); }",
    5000,
  );
  expect(result.error).toMatchObject({
    message: `Nothing matched #missing within 0.5 s. (login)\nTake a snapshot to see the current page, then retry with a ref or selector from it.`,
  });
});

test("run_script: a script error with a trimmed failed browser call's message gives the described call", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { throw new Error('step 2: ' + error.message.trim()); }",
    5000,
  );
  expect(result.error).toMatchObject({ message: `step 2: ${expiredText}` });
});

test("run_script: a failed browser call whose message the script changed keeps its name and the script's words", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { error.message = 'step 2: ' + error.message; throw error; }",
    5000,
  );
  expect(result.error).toStrictEqual({ name: "TimeoutError", message: `step 2: ${expiredText}` });
});

test("run_script: a script error carrying a call log of its own gives it in readable form", async () => {
  const result = await runScriptInChild(
    "throw new Error(\"step 3: click: Timeout 500ms exceeded.\\nCall log:\\n\\u001b[2m  - waiting for locator('#other')\\u001b[22m\\n\");",
    5000,
  );
  expect(result.error).toMatchObject({
    message:
      "step 3: Nothing matched #other within 0.5 s.\nTake a snapshot to see the current page, then retry with a ref or selector from it.",
  });
});

test("run_script: a rethrown failed browser call stays its described text", async () => {
  const result = await runScriptInChild(
    "try { await page.fail(); } catch (error) { throw error; }",
    5000,
  );
  expect(result.outcome).toBe("page.fail: the page refused");
});

test("run_script: a browser call rejecting with plain text stays that text", async () => {
  const result = await runScriptInChild("await page.refuse();", 5000);
  expect(result.outcome).toBe("the page refused in plain text");
});

test("run_script: a thrown plain object gives its message", async () => {
  const result = await runScriptInChild("throw { message: 'login failed', code: 7 };", 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: "login failed" });
});

test("run_script: a thrown plain object without a message gives its JSON", async () => {
  const result = await runScriptInChild("throw { code: 7 };", 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: '{"code":7}' });
});

test("run_script: a thrown plain object's message is the text", async () => {
  const result = await runScriptInChild("throw { message: 'login failed', code: 7 };", 5000);
  expect(result.outcome).toBe("Error: login failed");
});

test("run_script: a thrown number is the structured error's message", async () => {
  const result = await runScriptInChild("throw 42;", 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: "42" });
});

test("run_script: a thrown null is the structured error's message", async () => {
  const result = await runScriptInChild("throw null;", 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: "null" });
});

test("run_script: a thrown undefined is the structured error's message", async () => {
  const result = await runScriptInChild("throw undefined;", 5000);
  expect(result.error).toStrictEqual({ name: "Error", message: "undefined" });
});

const timerThrows = [
  {
    name: "an error whose message getter throws",
    code: "const error = new Error('t'); Object.defineProperty(error, 'message', { get() { throw new Error('m'); } }); throw error;",
    logged: "Error in a timer callback: [Unconvertible: Error: m]",
  },
  {
    name: "a Proxy whose get trap throws",
    code: "throw new Proxy({}, { get() { throw new Error('g'); } });",
    logged: "Error in a timer callback: [Unconvertible: Error: g]",
  },
];

for (const { name, code, logged } of timerThrows) {
  test(`run_script: a timer callback throwing ${name} lets the script finish`, async () => {
    const result = await runScriptInChild(
      `setTimeout(() => { ${code} }, 10); await sleep(200); return 'after';`,
      3000,
    );
    expect(result.value).toBe("after");
  });

  test(`run_script: a timer callback throwing ${name} is logged`, async () => {
    const result = await runScriptInChild(
      `setTimeout(() => { ${code} }, 10); await sleep(200); return 'after';`,
      3000,
    );
    expect(result.logs).toStrictEqual([logged]);
  });
}

test("run_script: an async timer callback throwing an object whose toString throws lets the script finish", async () => {
  const result = await runScriptInChild(
    "setTimeout(async () => { throw { toString() { throw new Error('s'); } }; }, 10); await sleep(200); return 'after';",
    3000,
  );
  expect(result.value).toBe("after");
});

test("run_script: a script error named ToolError keeps its name", async () => {
  const result = await runScriptInChild(
    "const error = new Error('x'); error.name = 'ToolError'; error.hint = 'fake hint'; throw error;",
    5000,
  );
  expect(result.error).toMatchObject({ name: "ToolError", message: "x" });
});

test("run_script: a script error named ToolError shows its script line", async () => {
  const result = await runScriptInChild(
    "const error = new Error('x'); error.name = 'ToolError'; error.hint = 'fake hint'; throw error;",
    5000,
  );
  expect(result.outcome).toMatch(/^ToolError: x\n {4}at .*run_script\.js:1:\d+/);
});

test("run_script: a failed helper call the script renamed ToolError keeps the script's hint out", async () => {
  const result = await runScriptInChild(
    "try { await page.fail(); } catch (error) { error.name = 'ToolError'; error.hint = 'fake hint'; throw error; }",
    5000,
  );
  expect(result.outcome).toBe("ToolError: page.fail: the page refused");
});

test("run_script: the script's own failed fetch keeps its name", async () => {
  const result = await runScriptInChild("await fetch('http://127.0.0.1:1/');", 5000);
  expect(result.error).toMatchObject({ name: "TypeError" });
});

test("run_script: the script's own abort reason keeps its name", async () => {
  const result = await runScriptInChild(
    "const controller = new AbortController(); controller.abort(); throw controller.signal.reason;",
    5000,
  );
  expect(result.error).toMatchObject({ name: "AbortError" });
});

test("run_script: the script's own aborted fetch keeps its name", async () => {
  const result = await runScriptInChild(
    `const controller = new AbortController(); controller.abort(); await fetch(${JSON.stringify(servedUrl)}, { signal: controller.signal });`,
    5000,
  );
  expect(result.error).toMatchObject({ name: "AbortError" });
});

test("run_script: a script error quoting a failed browser call twice gives its hint once per quote", async () => {
  const result = await runScriptInChild(
    "let first; try { await page.shut(); } catch (error) { first = error; } try { await page.shut(); } catch (error) { throw new Error('step 4: ' + first.message); }",
    5000,
  );
  expect(result.error).toMatchObject({
    message: `step 4: click: Target page, context or browser has been closed\n${CLOSED_HINT}`,
  });
});

test("run_script: a listener error wrapping a failed browser call is logged in its described form", async () => {
  const result = await runScriptInChild(
    "page.on('ping', async () => { try { await page.expire(); } catch (error) { throw new Error('cb: ' + error.message); } }); await page.ping(1); await sleep(200); return 1;",
    5000,
  );
  expect(result.logs).toStrictEqual([`Error in a ping callback: cb: ${expiredText}`]);
});

test("run_script: a failed browser call in a listener is logged in its described form", async () => {
  const result = await runScriptInChild(
    "page.on('ping', async () => { await page.expire(); }); await page.ping(1); await sleep(200); return 1;",
    5000,
  );
  expect(result.logs).toStrictEqual([`Error in a ping callback: ${expiredText}`]);
});

test("run_script: a failed browser call in an async timer callback is logged in its described form", async () => {
  const result = await runScriptInChild(
    "setTimeout(async () => { await page.expire(); }, 10); await sleep(200); return 1;",
    5000,
  );
  expect(result.logs).toStrictEqual([`Error in a timer callback: ${expiredText}`]);
});

test("run_script: a timer callback rethrowing a failed browser call is logged in its described form", async () => {
  const result = await runScriptInChild(
    "let failed; try { await page.expire(); } catch (error) { failed = error; } setTimeout(() => { throw failed; }, 10); await sleep(200); return 1;",
    5000,
  );
  expect(result.logs).toStrictEqual([`Error in a timer callback: ${expiredText}`]);
});

test("run_script: a script error quoting a failed helper call gives its hint after the script's sentence", async () => {
  const result = await runScriptInChild(
    "try { await page.lose(); } catch (error) { throw new Error('step 2: ' + error.message + ' (gave up)'); }",
    5000,
  );
  expect(result.error).toMatchObject({
    message: "step 2: Tab t9 is not open. (gave up)\nList tabs with tabs.",
  });
});

test("run_script: a script error caused by a failed browser call gives the described call in its structured message", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { throw new Error('wrap', { cause: error }); }",
    5000,
  );
  expect(result.error).toMatchObject({ message: `wrap\nCaused by: ${expiredText}` });
});

test("run_script: a script error caused by a failed browser call gives the described call in its text", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { throw new Error('wrap', { cause: error }); }",
    5000,
  );
  expect(result.outcome).toStartWith(`Error: wrap\nCaused by: ${expiredText}\n    at `);
});

test("run_script: a script error already quoting its cause gives the cause once", async () => {
  const result = await runScriptInChild(
    "try { await page.expire(); } catch (error) { throw new Error('step 2: ' + error.message, { cause: error }); }",
    5000,
  );
  expect(result.error).toMatchObject({ message: `step 2: ${expiredText}` });
});

test("run_script: a script error caused by a script error gives the cause's name and message", async () => {
  const result = await runScriptInChild(
    "throw new Error('wrap', { cause: new TypeError('bad input') });",
    5000,
  );
  expect(result.error).toMatchObject({ message: "wrap\nCaused by: TypeError: bad input" });
});

test("run_script: a script error that is its own cause gives its message", async () => {
  const result = await runScriptInChild(
    "const error = new Error('loop'); error.cause = error; throw error;",
    5000,
  );
  expect(result.error).toMatchObject({ message: "loop" });
});

test("run_script: a script error whose cause getter throws gives its message", async () => {
  const result = await runScriptInChild(
    "const error = new Error('guarded'); Object.defineProperty(error, 'cause', { get() { throw new Error('c'); } }); throw error;",
    5000,
  );
  expect(result.error).toMatchObject({ message: "guarded" });
});

test("run_script: a timer callback error stays out of the server's background errors", async () => {
  const result = await runScriptInChild(
    "setTimeout(async () => { await page.expire(); }, 10); await sleep(200); return 1;",
    5000,
  );
  expect(result.faults).toStrictEqual([]);
});

test("run_script: a listener error stays out of the server's background errors", async () => {
  const result = await runScriptInChild(
    "page.on('ping', async () => { await page.expire(); }); await page.ping(1); await sleep(200); return 1;",
    5000,
  );
  expect(result.faults).toStrictEqual([]);
});

const plainCauses = [
  { name: "null", cause: "null", shown: "null" },
  { name: "a string", cause: "'plain text'", shown: "plain text" },
  { name: "a plain object", cause: "{ code: 7 }", shown: '{"code":7}' },
  {
    name: "a plain error-like object",
    cause: "{ name: 'HttpError', message: '404' }",
    shown: "HttpError: 404",
  },
];

for (const { name, cause, shown } of plainCauses) {
  test(`run_script: a script error caused by ${name} gives the cause as it is`, async () => {
    const result = await runScriptInChild(`throw new Error('outer', { cause: ${cause} });`, 5000);
    expect(result.error).toMatchObject({ message: `outer\nCaused by: ${shown}` });
  });
}

test("run_script: an unhandled rejection of a failed browser call is logged in its described form", async () => {
  const result = await runScriptInChild("page.expire(); await sleep(200); return 1;", 5000);
  expect(result.logs).toStrictEqual([`Unhandled rejection: ${expiredText}`]);
});

test("run_script: an unhandled rejection stays out of the server's background errors", async () => {
  const result = await runScriptInChild(
    "Promise.reject(new Error('lost')); await sleep(200); return 1;",
    5000,
  );
  expect(result.faults).toStrictEqual([]);
});

test("run_script: an unhandled rejection right after the script's result is logged", async () => {
  const result = await runScriptInChild("Promise.reject(new Error('same tick')); return 1;", 5000);
  expect(result.logs).toStrictEqual(["Unhandled rejection: same tick"]);
});

test("run_script: a script that keeps the microtask queue busy after returning still returns its value", async () => {
  const result = await runScriptInChild(
    "(function spin() { Promise.resolve().then(spin); })(); return 1;",
    3000,
  );
  expect(result.outcome).toBe("1");
});

test("run_script: a browser call failing after the script ended stays out of the server's background errors", async () => {
  const result = await runScriptInChild("page.expireLater(); return 1;", 5000, 0, 400);
  expect(result.faults).toStrictEqual([]);
});

test("run_script: a browser call failing after the script ended is logged in its described form", async () => {
  const result = await runScriptInChild("page.expireLater(); return 1;", 5000, 0, 400);
  expect(result.streamed).toStrictEqual([
    `A browser call the script did not await failed after it ended: ${expiredText}`,
  ]);
});

test("run_script: a listener event the server cannot pass to the script is a server fault", async () => {
  const result = await runScriptInChild(
    "page.on('ping', () => undefined); await page.poison(); await sleep(200); return 1;",
    5000,
  );
  expect(result.faults).toContain("run_script callback");
});
