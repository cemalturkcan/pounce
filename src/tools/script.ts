import path from "node:path";
import vm from "node:vm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withTimeout } from "../async.ts";
import type { Tab } from "../browser.ts";
import { ToolError } from "../errors.ts";
import { describeJob } from "../jobs.ts";
import { untrusted } from "../output.ts";
import { runScript, serializeValue } from "../script.ts";
import { cancelled, clipToFile, defineTool, tabParam, timeoutParam, type ToolDeps } from "./common.ts";

function compiles(source: string) {
  try {
    new vm.Script(source);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function evaluationSource(expression: string) {
  const asExpression = `(async () => { const value = (${expression}\n); return typeof value === "function" ? value() : value; })()`;
  if (compiles(asExpression) === undefined) return asExpression;
  const asStatements = `(async () => {\n${expression}\n})()`;
  const problem = compiles(asStatements);
  if (problem === undefined) return asStatements;
  throw new ToolError(`The code does not parse as an expression or as statements: ${problem}`, "Fix the syntax; nothing was run.");
}

export function registerScriptTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, jobs } = deps;

  defineTool(server, deps, {
    name: "evaluate",
    title: "Evaluate JavaScript in page",
    description:
      "Run JavaScript inside the page once and return the result as JSON. Accepts an expression (document.title), a function (() => window.appState), or statements with an explicit return (const x = 1; return x); which form applies is decided by parsing the code before it runs, and errors thrown by the code are reported as errors. Async code is awaited. Runs in the page's own JavaScript world by default, so page globals are visible. For work that spans several elements, pages or tabs use run_script, which runs on the server with the full Playwright API.",
    input: {
      tab: tabParam,
      expression: z.string().min(1).max(100_000).describe("JavaScript to run in the page."),
      world: z.enum(["main", "isolated"]).optional().describe("main sees the page's own globals; isolated shares only the DOM and cannot be observed or broken by page scripts. Default main."),
      timeout_ms: timeoutParam(15_000),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the result; longer results are saved to a file. Default 8000."),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 15_000;
      const run = (source: string) =>
        input.world === "isolated" ? (tab.page.evaluate(source) as Promise<unknown>) : manager.evaluateMain<unknown>(tab.page, source);
      const value = await withTimeout(
        run(evaluationSource(input.expression)),
        timeout,
        () =>
          new ToolError(
            `evaluate timed out after ${timeout} ms.`,
            "The page script may still be running. If later calls on this tab hang, close the tab and open a new one.",
          ),
      );
      const text = await clipToFile(store, "evaluate", `${tab.id}-evaluate`, serializeValue(value), input.max_chars ?? 8000);
      return untrusted(tab.page.url(), text);
    },
  });

  defineTool(server, deps, {
    name: "run_script",
    title: "Run Playwright script",
    description: [
      "Run an async JavaScript function body on the server with the Playwright API, to do many steps in one call: loops over pages or rows, multi-tab flows, scraping, form batches. Use `return` to send back a value (returned as JSON) and log() for progress lines.",
      "In scope: page (Playwright Page of `tab`), context (BrowserContext; context.request makes HTTP calls with the browser's cookies), tab(id), tabId(page), openTab(url?) -> Page, closeTab(pageOrId), ref(ref, page?) -> Locator, snapshot(page?, {interactive, target, depth}), text(page?, scope), links(page?), extract(page?) -> {jsonld, meta, tables}, save(name, content) -> file path, secrets.fill(targetOrLocator, name, field?), secrets.list(query?), sleep(ms), log(...), signal (aborted when a background job is cancelled), fetch, URL, Buffer.",
      "The script runs in the server process without require or process. When it hits timeout_ms, is cancelled, or the client cancels the call, it is stopped: page, context and the objects they return refuse further browser calls, sleep() and its timers end, and tabs it opened are closed; a browser call already in flight may still finish. Save bulky results with save() (a name without an extension gets .txt) and return the paths rather than returning large data.",
    ].join("\n"),
    input: {
      code: z.string().min(1).max(200_000).describe("Body of an async function, for example: const rows = await page.locator('tr').allInnerTexts(); return rows.length;"),
      tab: tabParam.optional().describe("Tab bound to `page` in the script. Omit when the script opens its own tabs."),
      timeout_ms: z.number().int().min(1000).max(900_000).optional().describe("Time limit in milliseconds. Default 120000."),
      background: z.boolean().optional().describe("Start the script as a background job and return its id at once, for long runs. No time limit applies; follow it with jobs, or read its log file. Default false."),
      label: z.string().optional().describe("Short description shown in the jobs list, for background runs."),
      max_chars: z.number().int().min(200).max(200_000).optional().describe("Character budget for the returned value and logs; the rest is saved to a file. Default 10000."),
    },
    handler: async (input, owner, signal) => {
      const tab = input.tab ? manager.getTab(input.tab) : undefined;
      const startedAt = Date.now();
      if (input.background) {
        const job = await jobs.start(deps, owner, tab, input.code, input.label ?? "");
        return `Started background job ${job.id}. Log: ${job.logFile}\nCheck it with jobs (action status, id ${job.id}); the result is written to ${job.resultFile} when it ends.`;
      }
      const result = await runScript(deps, owner, tab, input.code, { timeoutMs: input.timeout_ms ?? 120_000, signal });
      const sections = [`Returned: ${serializeValue(result.value)}`];
      if (result.logs.length) sections.push(`Logs:\n${result.logs.join("\n")}`);
      if (tab && !tab.page.isClosed()) sections.push(...manager.drainEvents(tab, startedAt));
      return clipToFile(store, "scripts", "run-script-result", sections.join("\n"), input.max_chars ?? 10_000);
    },
  });

  defineTool(server, deps, {
    name: "jobs",
    title: "Background jobs",
    description:
      "List, inspect or cancel background jobs started by run_script with background: true. status shows the state, the most recent log lines and the log and result file paths. Jobs are kept in memory, so they end if the server restarts. Cancelling stops the script: its page, context and the objects they return refuse further browser calls, sleep() and its timers end, and the tabs it opened are closed; a browser call already in flight may still finish.",
    input: {
      action: z.enum(["list", "status", "cancel"]).describe("list shows all jobs; status and cancel need id."),
      id: z.string().optional().describe("Job id such as j1."),
    },
    handler: async (input) => {
      if (input.action === "list") {
        const all = jobs.list();
        return all.length ? all.map((job) => describeJob(job, false)).join("\n") : "No background jobs.";
      }
      if (!input.id) throw new ToolError(`${input.action} needs id.`);
      if (input.action === "cancel") {
        const job = jobs.cancel(input.id);
        await Promise.race([job.finished, new Promise((resolve) => setTimeout(resolve, 3000))]);
        return describeJob(job, true);
      }
      return describeJob(jobs.get(input.id), true);
    },
  });
}
