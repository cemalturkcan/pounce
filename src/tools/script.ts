import vm from "node:vm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withDeadline, withTimeout } from "../shared/async.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import {
  describeJob,
  type Job,
  jobActive,
  JOB_STATES,
  JOB_VALUE_CHARS,
  jobElapsedMs,
  jobValueClipped,
  jobOrphaned,
  listedJob,
  queuedBehind,
} from "../script/jobs.ts";
import {
  clipEnds,
  clipHeadTail,
  fieldPointer,
  returnedSentence,
  untrusted,
  valueKind,
} from "../shared/output.ts";
import { runScript, scriptError } from "../script/run.ts";
import { convertedSource, structuredJson, structuredValue, valueText } from "../script/text.ts";
import { clipToFile, defineTool, tabParam, timeoutParam, type ToolDeps } from "./common.ts";
import { evaluateIsolated, evaluateMainValue } from "../browser/evaluate.ts";
import { drainEvents } from "../browser/tab.ts";

function compile(source: string) {
  try {
    return { script: new vm.Script(source) };
  } catch (cause) {
    return { problem: messageOf(cause) };
  }
}

export function evaluationSource(expression: string) {
  const asExpression = `(async () => { const value = (${expression}\n); return typeof value === "function" ? value() : value; })()`;
  if ("script" in compile(asExpression)) return asExpression;
  const asStatements = `(async () => {\n${expression}\n})()`;
  const statements = compile(asStatements);
  if ("script" in statements) return asStatements;
  throw new ToolError(
    `The code does not parse as an expression or as statements: ${statements.problem}`,
    "Fix the syntax; nothing was run.",
  );
}

const VALUE_FORMS =
  'Values that JSON cannot hold arrive in one form in evaluate, run_script and job results and in run_script log lines: a Map as a list of [key, value] pairs, a Set as a list, an Error or DOMException as {name, message, stack} with stack its first "at" line, NaN, Infinity, -Infinity, -0 and BigInt as their text, a RegExp as its source text, a Date as its ISO time, a page element, document or window as "ref: <Node>", "ref: <Document>" or "ref: <Window>", a Playwright ElementHandle a script returns as "ref: <Node>" and another Playwright object as its kind, such as "ref: <JSHandle>" or "ref: <Page>", an undefined, function or Symbol inside an object, list, Map or Set as "[undefined]", "[Function]" or "[Symbol(<description>)]", a reference that loops back as "[Circular]", a part nested more than 64 levels deep as "[Too deep]", and a part that throws when read (a throwing getter or toJSON, a revoked Proxy) as "[Unconvertible: <error>]".';

function spokenList(items: string[]) {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");
}

function replacedNote(replaced: string[], plain: boolean) {
  const named = replaced.length ? spokenList(replaced) : "built-ins";
  if (plain)
    return `Note: the page replaced ${named}, which the conversion needs, so the value is plain JSON: a Map, Set, Error, NaN or the like is not in the forms the tool describes.`;
  if (replaced.length === 0) return undefined;
  return `Note: the page replaced ${named}, so values that need ${replaced.length > 1 ? "them" : "it"} may arrive as plain JSON instead of in the forms the tool describes.`;
}

const UNCHECKED_TO_JSON_NOTE =
  "Note: the page replaced Function.prototype.toString, so it could not be checked whether a toJSON the value inherits was added by the page to a built-in prototype; it was applied.";

const CLIPPED_FIELDS = {
  clipped: z.literal(true).optional(),
  totalChars: z.number().int().optional(),
  file: z.string().optional(),
};

const CODE_ONLY = ["tab", "timeout_ms", "background", "label"] as const;

function jobValue(job: Job, maxChars: number) {
  if (job.returned === undefined || !jobValueClipped(job, maxChars)) return { value: job.value };
  return {
    value: clipEnds(job.returned, Math.min(maxChars, JOB_VALUE_CHARS)).text,
    clipped: true as const,
    totalChars: job.returned.totalChars,
    file: job.resultError ? undefined : job.resultFile,
  };
}

function jobOutput(job: Job, givenChars?: number) {
  const maxChars = givenChars ?? job.maxChars ?? JOB_VALUE_CHARS;
  return {
    text: describeJob(job, true, { maxChars }),
    structuredText: describeJob(job, true, { maxChars, pointed: true }),
    data: {
      ...jobValue(job, maxChars),
      undefined: job.undefined,
      error: job.error,
      jobId: job.id,
      state: job.state,
      queuedBehind: queuedBehind(job),
      orphaned: jobOrphaned(job) || undefined,
      elapsedMs: jobElapsedMs(job),
      logFile: job.logFile,
      resultFile: job.resultFile,
      recentLogs: job.recentLogs.length ? [...job.recentLogs] : undefined,
    },
  };
}

export async function waitForJob(
  job: Job,
  timeoutMs: number,
  signal: AbortSignal,
  maxChars?: number,
) {
  let stopWaiting: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    stopWaiting = () => resolve();
    if (signal.aborted) resolve();
    signal.addEventListener("abort", stopWaiting, { once: true });
  });
  try {
    await withDeadline(Promise.race([job.finished, aborted]), timeoutMs);
  } finally {
    if (stopWaiting) signal.removeEventListener("abort", stopWaiting);
  }
  const output = jobOutput(job, maxChars);
  if (!jobActive(job)) return output;
  const behind = queuedBehind(job);
  const still = `Still ${behind ? `queued behind ${behind}` : job.state} after waiting ${timeoutMs} ms.`;
  return {
    ...output,
    text: `${output.text}\n${still}`,
    structuredText: `${output.structuredText}\n${still}`,
  };
}

function startedLine(job: Job, logFile: string) {
  const behind = queuedBehind(job);
  if (!behind) return `Started background job ${job.id}. Log: ${logFile}`;
  return `Queued background job ${job.id} behind ${behind} on ${job.tabId}; it starts when ${behind} ends. To run in parallel, use another tab or combine the work in one script. Log: ${logFile}`;
}

export function registerScriptTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, jobs } = deps;

  defineTool(server, deps, {
    name: "evaluate",
    title: "Evaluate JavaScript in page",
    description: [
      "Run JavaScript inside the page once and return the result as JSON. Use it to read a value the page holds in JavaScript (an app state object, a framework store, a computed style, the number of elements matching a selector), to check a condition, or to change something in the page directly, such as localStorage. The value is always in the value field (undefined: true when it is undefined), and the structured text only says what kind of value came back. Accepts an expression (document.title), a function (() => window.appState), or statements with an explicit return (const x = 1; return x); errors thrown by the code are reported as errors. Async code is awaited. Runs in the page's own JavaScript world by default, so page globals are visible. For work that spans several actions, pages or tabs, such as clicking many times or looping over results, use run_script, which runs on the server with the full Playwright API; the action tools report what each step changed.",
      VALUE_FORMS,
    ].join("\n"),
    input: {
      tab: tabParam,
      expression: z.string().min(1).max(100_000).describe("JavaScript to run in the page."),
      world: z
        .enum(["main", "isolated"])
        .optional()
        .describe(
          "main sees the page's own globals; isolated shares only the DOM and cannot be observed or broken by page scripts. Default main.",
        ),
      timeout_ms: timeoutParam(15_000),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .optional()
        .describe(
          "Character budget for the result. A longer value is saved to a file: value then holds a preview, clipped is true, totalChars its full size and file the path. Default 8000.",
        ),
    },
    output: {
      value: structuredJson.optional(),
      undefined: z.literal(true).optional(),
      ...CLIPPED_FIELDS,
      replacedBuiltins: z.array(z.string()).optional(),
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 15_000;
      const source = evaluationSource(input.expression);
      const run = async () =>
        input.world === "isolated"
          ? {
              value: await evaluateIsolated(
                manager.config.engine,
                tab.page,
                convertedSource(source),
                z.unknown(),
              ),
              replaced: [],
              plain: false,
              uncheckedToJSON: false,
            }
          : evaluateMainValue(tab.page, source, z.unknown());
      const {
        value: raw,
        replaced,
        plain,
        uncheckedToJSON,
      } = await withTimeout(
        run(),
        timeout,
        () =>
          new ToolError(
            `evaluate timed out after ${timeout} ms.`,
            "The page script may still be running. If later calls on this tab hang, close the tab and open a new one.",
          ),
      );
      const value = structuredValue(raw);
      const clipped = await clipToFile(
        store,
        "evaluate",
        `${tab.id}-evaluate`,
        valueText(value),
        input.max_chars ?? 8000,
      );
      const notes = [replacedNote(replaced, plain), uncheckedToJSON ? UNCHECKED_TO_JSON_NOTE : ""];
      const frame = (shown: string) =>
        [untrusted(tab.page.url(), shown), ...notes].filter(Boolean).join("\n");
      const replacedBuiltins = replaced.length ? replaced : undefined;
      const kind = raw === undefined ? "undefined" : valueKind(value);
      return {
        text: frame(clipped.text),
        structuredText: frame(
          returnedSentence(kind, clipped.file === undefined ? undefined : clipped.totalChars),
        ),
        data: clipped.file
          ? {
              value: clipped.preview,
              clipped: true as const,
              totalChars: clipped.totalChars,
              file: clipped.file,
              replacedBuiltins,
            }
          : { value, undefined: raw === undefined || undefined, replacedBuiltins },
      };
    },
  });

  defineTool(server, deps, {
    name: "run_script",
    title: "Run Playwright script",
    description: [
      "Run an async JavaScript function body on the server with the Playwright API to do many steps in one call, or with job (and cancel) check, cancel or, with neither code nor job, list background jobs, or with job and wait wait for one to end. Use it when a task is a sequence you can already describe: pressing a button many times, paging through a list and collecting rows, filling the same form for many entries, working across several tabs, or calling a site's API in a loop. `return` sends back a value as JSON; log() writes progress lines. The code runs on the server, not in the page, so the page's own globals (window, document, an app's state) are not in scope: read them with `await page.evaluate(() => window.appState)`: evaluate, evaluateHandle, $$eval and a locator's evaluateAll run in the page's own script world, as the evaluate tool does, except that with the default patchright engine evaluateAll on a locator chain holding a ref sees the page's elements but not its globals. For a single action the action tools report what changed; for reading one value in the page, evaluate is simpler.",
      "In scope:",
      "page: the Playwright Page of tab; context: the BrowserContext (context.request makes HTTP calls with the browser's cookies)",
      "tab(id) -> Page; tabId(page) -> string; openTab(url?) -> Page; closeTab(pageOrId)",
      "ref(ref, page?) -> Locator for a ref from snapshot",
      "snapshot(page?, {interactive?, target?, depth?}) -> string, the snapshot text",
      "text(page?, scope: 'main' | 'page' = 'main') -> string",
      "links(page?, limit = 300) -> {text, url}[]",
      "extract(page?) -> {jsonld, meta, tables}",
      "compareDesign(page?, referencePath, {fullPage, target, deviceScaleFactor, tolerance, minRegionArea, maxRegions, model}) -> the compare_design report (regions, files, summary)",
      "save(name, content) -> file path (a name without an extension gets .txt)",
      "secrets.fill(targetOrLocator, name, field = 'password') types a stored secret without returning it; secrets.list(query?) -> string[] of names",
      "sleep(ms), log(...), signal (aborted on timeout or cancel), fetch, URL, Buffer",
      "A page argument is a Page or a tab id. Tabs the script opens are closed, and its routes, listeners, exposed functions and init scripts are removed, when it ends, times out or is cancelled; a long synchronous loop does not block other calls. It runs with the server's own rights and is not a security sandbox: run only code you would run on the server yourself. Save bulky results with save() and return the paths instead of the data.",
      VALUE_FORMS,
      "timeout_ms (default 120000) ends the run. background: true starts it as a job and returns its id at once, with no time limit; a job bound to a tab where another job, of any session, is running or queued waits in line and starts when the jobs ahead of it on that tab end (state queued, queuedBehind names the job it waits behind; cancel removes it from the queue without running it, and a job whose tab is closed while queued fails instead of starting). Jobs on other tabs or with no tab start at once. Follow a job with run_script and job (state, recent log lines, log and result file paths, and once it ended its returned value or its error), or add wait: true to wait until the job ends, queue time included (up to timeout_ms, default 120000) and get its final state and returned value in one call instead of polling; stop it with job and cancel: true, or list jobs with no arguments (the jobs field lists each with id, state, label, tab, orphaned and queuedBehind). A job's result file is JSON with value, undefined: true when it returned undefined, or error. A script that throws, in the foreground or as a job, reports the error as {name, message, stack} in the error field, with stack the frames in the script's own code, numbered by its lines (left out when it has none) and a failed browser call's text in message in the form the tools report it; an error from a failed browser call that the script let through unchanged is {name: \"Error\", message} with message the text the error is reported with. Jobs of all sessions are listed, a job whose session has ended marked orphaned (orphaned: true); cancel only your own unless you know its session is gone. Jobs live in memory and end if the server restarts.",
      'An alert, confirm or prompt on a tab the script uses is accepted for it (a prompt with its default value) and the log says which, unless the script listens for "dialog" events itself; dialogs on a user tab or another session\'s tab are left to them. If the script ends on timeout_ms with a dialog still open, the error names it.',
    ].join("\n"),
    input: {
      code: z
        .string()
        .min(1)
        .max(200_000)
        .optional()
        .describe("Body of an async function; `return` a value to get it back as JSON."),
      tab: tabParam
        .optional()
        .describe(
          "With code: tab bound to `page` in the script. Omit when the script opens its own tabs.",
        ),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(900_000)
        .optional()
        .describe(
          "With code: time limit in milliseconds. With job and wait: how long to wait. Default 120000.",
        ),
      background: z
        .boolean()
        .optional()
        .describe(
          "With code: start the script as a background job and return its id at once. timeout_ms does not apply. Default false.",
        ),
      label: z
        .string()
        .optional()
        .describe("With code: short description shown in the job list, for background runs."),
      max_chars: z
        .number()
        .int()
        .min(200)
        .max(200_000)
        .optional()
        .describe(
          "Character budget for the returned value. With code it covers the value and logs: a value over it is saved to a file with the logs, and value holds a preview with clipped true, totalChars its full size and file the path; logs over it while the value fits are saved to a file and the value stays whole in value, while logs holds a preview of the first and last lines with clipped true, totalChars the size of the saved logs and file the path. With background: true it is kept with the job and applies to its later status and wait calls unless they pass their own. With job: a value over it, or over 10000 chars, is clipped to a preview in value with clipped true, totalChars its full size and file the job's result file. Default 10000.",
        ),
      job: z
        .string()
        .optional()
        .describe("Job id such as j1: show its state, recent log lines and file paths."),
      cancel: z.boolean().optional().describe("With job: stop that job."),
      wait: z
        .boolean()
        .optional()
        .describe(
          "With job: wait until the job ends, up to timeout_ms, then return its final state and returned value. Default false.",
        ),
    },
    output: {
      value: structuredJson.optional(),
      undefined: z.literal(true).optional(),
      error: scriptError.optional(),
      jobId: z.string().optional(),
      state: z.enum(JOB_STATES).optional(),
      elapsedMs: z.number().optional(),
      logFile: z.string().optional(),
      resultFile: z.string().optional(),
      ...CLIPPED_FIELDS,
      logs: z.array(z.string()).optional(),
      recentLogs: z.array(z.string()).optional(),
      queuedBehind: z.string().optional(),
      orphaned: z.literal(true).optional(),
      jobs: z
        .array(
          z.object({
            id: z.string(),
            state: z.enum(JOB_STATES),
            label: z.string().optional(),
            tab: z.string().optional(),
            orphaned: z.literal(true).optional(),
            queuedBehind: z.string().optional(),
          }),
        )
        .optional(),
    },
    racesDialogs: false,
    handler: async (input, owner, signal) => {
      if (input.code !== undefined && input.job !== undefined)
        throw new ToolError(
          "code and job cannot be combined.",
          "Pass code to run a script, or job to look at one.",
        );
      if (input.cancel !== undefined && input.job === undefined)
        throw new ToolError(
          "cancel needs job.",
          "Pass the job id from the list or the start message.",
        );
      if (input.wait !== undefined && input.job === undefined)
        throw new ToolError(
          "wait needs job.",
          "Pass the job id from the list or the start message.",
        );
      if (input.code === undefined) {
        for (const name of CODE_ONLY) {
          if (input[name] === undefined) continue;
          if (name === "timeout_ms" && input.wait === true) continue;
          throw new ToolError(`${name} needs code.`);
        }
        if (input.max_chars !== undefined && input.job === undefined)
          throw new ToolError("max_chars needs code or job.");
        if (input.job === undefined) {
          const all = jobs.list();
          return {
            text: all.length
              ? all.map((job) => describeJob(job, false)).join("\n")
              : "No background jobs.",
            data: { jobs: all.map(listedJob) },
          };
        }
        if (input.cancel === true) {
          const job = jobs.cancel(input.job);
          if (input.wait === true)
            return waitForJob(job, input.timeout_ms ?? 120_000, signal, input.max_chars);
          await withDeadline(job.finished, 3000);
          return jobOutput(job, input.max_chars);
        }
        if (input.wait === true)
          return waitForJob(
            jobs.get(input.job),
            input.timeout_ms ?? 120_000,
            signal,
            input.max_chars,
          );
        return jobOutput(jobs.get(input.job), input.max_chars);
      }
      const tab = input.tab ? manager.getTab(input.tab) : undefined;
      const startedAt = Date.now();
      if (input.background) {
        const job = await jobs.start(
          deps,
          owner,
          tab,
          input.code,
          input.label ?? "",
          input.max_chars,
        );
        const output = jobOutput(job);
        const started = (logFile: string, resultFile: string) =>
          [
            startedLine(job, logFile),
            `Check it with run_script with job ${job.id}, or with job ${job.id} and wait: true to wait for it to end; the result is written to ${resultFile} when it ends.`,
          ].join("\n");
        return {
          data: output.data,
          text: started(job.logFile, job.resultFile),
          structuredText: started(fieldPointer("logFile"), fieldPointer("resultFile")),
        };
      }
      const result = await runScript(deps, owner, tab, input.code, {
        timeoutMs: input.timeout_ms ?? 120_000,
        signal,
      });
      const events = tab && !tab.page.isClosed() ? drainEvents(tab, startedAt, result.logs) : [];
      const rest = [...(result.logs.length ? [`Logs:\n${result.logs.join("\n")}`] : []), ...events];
      const maxChars = input.max_chars ?? 10_000;
      const returned = `Returned: ${result.returned}`;
      const kind = result.undefined
        ? "undefined"
        : result.value === undefined
          ? undefined
          : valueKind(result.value);
      if (result.returned.length > maxChars) {
        const clipped = await clipToFile(
          store,
          "scripts",
          "run-script-result",
          [returned, ...rest].join("\n"),
          maxChars,
        );
        const value = clipHeadTail(result.returned, maxChars);
        return {
          text: clipped.text,
          structuredText: returnedSentence(kind, value.totalChars),
          data: {
            value: value.text,
            clipped: true as const,
            totalChars: value.totalChars,
            file: clipped.file,
          },
        };
      }
      const logs = await clipToFile(
        store,
        "scripts",
        "run-script-logs",
        rest.join("\n"),
        Math.max(maxChars - returned.length, 0),
      );

      const pointedRest = logs.file
        ? [`Logs: ${logs.totalChars} chars; a preview in logs, all in file.`]
        : [...(result.logs.length ? [`Logs: ${fieldPointer("logs")}`] : []), ...events];
      const logsClipped = logs.file
        ? {
            logs: logs.preview.replace(/^Logs:\n/, "").split("\n"),
            clipped: true as const,
            totalChars: logs.totalChars,
          }
        : { logs: result.logs.length ? result.logs : undefined };
      return {
        text: [returned, ...(rest.length ? [logs.text] : [])].join("\n"),
        structuredText: [returnedSentence(kind), ...pointedRest].join("\n"),
        data: {
          value: result.value,
          undefined: result.undefined,
          file: logs.file,
          ...logsClipped,
        },
      };
    },
  });
}
