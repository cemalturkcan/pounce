import type { Locator, Page } from "playwright-core";
import { type BrowserManager, DRAW_WAIT_MS } from "../browser/manager.ts";
import { recordedSelectors } from "../shared/call-scope.ts";
import { logEvent } from "../log/logger.ts";
import { describeError, describeScriptMessage, messageOf, ToolError } from "../shared/errors.ts";
import { extractPage } from "../page/extract.ts";
import type { OutputStore, Redactor } from "../shared/output.ts";
import { issuingSnapshot, pageLinks, pageText, shownTitle } from "../page/page.ts";
import { registerSecret, type SecretField, type SecretStore } from "../shared/secrets.ts";
import { interactiveOnly } from "../page/snapshot.ts";
import { type CompareOptions, compareDesign } from "../visual/compare.ts";
import type { ScriptWatch, Tab } from "../browser/tab.ts";
import type { AskAdapterSource } from "../ask/adapter-source.ts";
import { CheckedRefs, type GivenRefs } from "./checked-refs.ts";
import { mainWorldMember } from "./main-world.ts";
import { ScriptHost, type ScriptOutcome, ThrownByScript } from "./host.ts";
import { z } from "zod";
import { isText, scriptFrames, wireError } from "./wire.ts";
import { dialogStatus } from "../browser/dialogs.ts";

export type ScriptDeps = {
  manager: BrowserManager;
  store: OutputStore;
  secrets: SecretStore;
  redactor: Redactor;
  ask?: AskAdapterSource;
};

type ScriptOptions = {
  given?: GivenRefs;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
};

type ScriptResult = ScriptOutcome & { logs: string[] };

export const scriptError = wireError.pick({ name: true, message: true, stack: true });

export type ScriptError = z.infer<typeof scriptError>;

export function scriptErrorOf(cause: unknown): ScriptError {
  const carried = scriptError.safeParse(cause instanceof ToolError ? cause.data?.error : undefined);
  return carried.success ? carried.data : { name: "Error", message: describeError(cause) };
}

type Selectors = ReadonlyMap<string, string> | undefined;

const rawMessage = (cause: unknown) =>
  cause instanceof ThrownByScript ? cause.thrown.message : messageOf(cause);

function describedThrow(cause: unknown, selectors: Selectors): ScriptError {
  if (!(cause instanceof ThrownByScript))
    return { name: "Error", message: describeError(cause, selectors) };
  const { name } = cause.thrown;
  const message = describeScriptMessage(cause.thrown.message, cause.quoted, selectors);
  if (!("cause" in cause) || cause.thrown.message.includes(rawMessage(cause.cause).trimEnd()))
    return { name, message };
  const inner = describedThrow(cause.cause, selectors);
  const shown =
    cause.cause instanceof ThrownByScript && inner.name
      ? `${inner.name}: ${inner.message}`
      : inner.message;
  return { name, message: `${message}\nCaused by: ${shown}` };
}

function scriptFailure(cause: unknown, code: string, logs: string[]) {
  const selectors = recordedSelectors();
  const logLines = logs.length ? ["Logs before the error:", ...logs] : [];
  if (cause instanceof ThrownByScript) {
    const { stack } = cause.thrown;
    const { name, message } = describedThrow(cause, selectors);
    const frames = scriptFrames(stack, code);
    const framed = frames ? frames.split("\n").map((frame) => `    ${frame}`) : [];
    return new ToolError(
      [`${name}: ${message}`, ...framed, ...logLines].join("\n"),
      undefined,
      { error: frames ? { name, message, stack: frames } : { name, message } },
      { cause },
    );
  }
  const error = describedThrow(cause, selectors);
  if (cause instanceof ToolError)
    return new ToolError(cause.message, cause.hint, { error }, { cause });
  return new ToolError([error.message, ...logLines].join("\n"), undefined, { error }, { cause });
}

export async function runScript(
  deps: ScriptDeps,
  owner: string,
  tab: Tab | undefined,
  code: string,
  options: ScriptOptions = {},
): Promise<ScriptResult> {
  const { manager, store, secrets, redactor } = deps;
  const refs = new CheckedRefs(manager, options.given ?? manager.givenRefs());
  const context = await manager.ensureContext();
  const logs: string[] = [];
  const opened = new Set<Tab>();
  const driven = new Set<Tab>();
  const rendering = new Map<Tab, () => void>();
  const log = (line: string) => {
    logs.push(line);
    options.onLog?.(line);
  };
  const watch: ScriptWatch = { owner, log };
  let finished = false;
  const keepRendering = (target: Tab) => {
    if (!finished && !rendering.has(target)) rendering.set(target, manager.holdRendering(target));
  };
  const drawChecks = new Set<Promise<void>>();
  const keepReached = (target: Tab) => {
    if (finished || rendering.has(target)) return;
    keepRendering(target);
    const check = manager.untilDrawn(target).then((drawn) => {
      if (!drawn)
        log(
          `Note: ${target.id} had not drawn a frame within ${DRAW_WAIT_MS / 1000} s after the script reached it, so it may have missed the script's first action there; check that action's effect.`,
        );
    });
    drawChecks.add(check);
  };
  const keepIfScripts = async (target: Tab, method?: string) => {
    if (target.owner === owner || method === "newPage") return keepReached(target);
    const opener = await target.page.opener().catch(() => null);
    const parent = opener ? manager.tabOf(opener) : undefined;
    if (parent && (parent.owner === owner || rendering.has(parent))) keepReached(target);
  };
  const drive = (target: Tab) => {
    (target.scripts ??= new Set()).add(watch);
    driven.add(target);
    keepRendering(target);
    return target;
  };
  if (tab) drive(tab);

  const pageOf = (candidate?: Page | string) => {
    if (isText(candidate)) return drive(manager.getTab(candidate));
    const found = candidate ? manager.tabOf(candidate) : tab;
    if (!found)
      throw new ToolError(
        "This script has no default tab.",
        "Pass tab to run_script, or call openTab(url) inside the script.",
      );
    return drive(found);
  };

  const scope = {
    tab: (id: string) => drive(manager.getTab(id)).page,
    tabId: (page: Page) => manager.tabOf(page)?.id,
    openTab: async (url?: string) => {
      const created = drive(await manager.openTab(owner));
      opened.add(created);
      if (url) await created.page.goto(url, { waitUntil: "domcontentloaded" });
      if (!(await manager.untilDrawn(created)))
        log(
          `Note: ${created.id} had not drawn a frame within ${DRAW_WAIT_MS / 1000} s after openTab, so it may miss the first action; check that action's effect.`,
        );
      return created.page;
    },
    closeTab: (candidate: Page | string) => manager.closeTab(pageOf(candidate).id),
    ref: (ref: string, page?: Page | string) => refs.locate(pageOf(page), ref),
    snapshot: async (
      page?: Page | string,
      snapshotOptions: { interactive?: boolean; target?: string; depth?: number } = {},
    ) => {
      const target = pageOf(page);
      const { text, issued } = await issuingSnapshot(manager, target, snapshotOptions);
      refs.take(target, issued);
      return snapshotOptions.interactive ? interactiveOnly(text) : text;
    },
    text: (page?: Page | string, textScope: "main" | "page" = "main") =>
      pageText(pageOf(page).page, textScope),
    links: (page?: Page | string, limit: number = 300) => pageLinks(pageOf(page).page, limit),
    extract: (page?: Page | string) => extractPage(pageOf(page).page),
    compareDesign: async (
      page: Page | string | undefined,
      referencePath: string,
      compareOptions: Omit<CompareOptions, "signal"> = {},
    ) => {
      const { ask } = deps;
      if (!ask) throw new ToolError("compareDesign is not available in this script context.");
      const compared = pageOf(page);
      const { target } = compareOptions;
      const { text, ...report } = await compareDesign(
        { manager, store, ask },
        compared,
        referencePath,
        {
          ...compareOptions,
          target: isText(target) ? await refs.resolve(compared, target) : target,
          signal: host.controller.signal,
        },
      );
      return { ...report, summary: text };
    },
    save: (name: string, content: string | Buffer) =>
      store.write(
        "scripts",
        store.uniqueName(
          name,
          /\.[a-z0-9]{1,8}$/i.test(name) ? (name.split(".").pop() ?? "txt") : "txt",
        ),
        content,
      ),
    secretsList: (query?: string) => secrets.list(query),
    secretsFill: async (
      target: Locator | string,
      name: string,
      field: SecretField = "password",
    ) => {
      const value = await secrets.get(name, field);
      registerSecret(redactor, name, field, value);
      const locator = isText(target) ? await refs.resolve(pageOf(), target) : target;
      const fill = refs.replacement(locator, "fill");
      await (fill ? fill(value) : locator.fill(value));
    },
  };

  const host = new ScriptHost(
    code,
    { page: tab?.page, context, scope },
    {
      onLog: log,
      onCallbackError: (label, cause) =>
        log(`Error in a ${label} callback: ${describedThrow(cause, recordedSelectors()).message}`),
      onUnhandledRejection: (cause) =>
        log(`Unhandled rejection: ${describedThrow(cause, recordedSelectors()).message}`),
      onCallFailedAfterEnd: (cause) => {
        const { message } = describedThrow(cause, recordedSelectors());
        log(`A browser call the script did not await failed after it ended: ${message}`);
        logEvent("script_call_after_end", { session: owner, error: message });
      },
      onExport: (object, method) => {
        const reached = manager.tabOf(object);
        if (reached) void keepIfScripts(reached, method);
      },
      replacement: (object, method) => {
        const checked = refs.replacement(object, method);
        if (checked) return checked;
        const main =
          manager.config.engine === "patchright" ? mainWorldMember(object, method) : undefined;
        if (main) return main;
        const reached = method === "title" ? manager.tabOf(object) : undefined;
        return reached && (() => shownTitle(reached.page));
      },
    },
  );
  let timer: NodeJS.Timeout | undefined;
  if (options.timeoutMs !== undefined) {
    const { timeoutMs } = options;
    timer = setTimeout(
      () =>
        void host.halt({
          reason: "timeout",
          message: `run_script timed out after ${timeoutMs} ms.`,
        }),
      timeoutMs,
    );
  }
  const onCancel = () =>
    void host.halt({ reason: "cancelled", message: "The script was cancelled." });
  if (options.signal?.aborted) onCancel();
  options.signal?.addEventListener("abort", onCancel, { once: true });

  try {
    const outcome = await host.outcome;
    await Promise.all(drawChecks);
    return { ...outcome, logs };
  } catch (cause) {
    const stop = host.stop;
    if (stop) {
      const leftOpen = [...driven]
        .flatMap((candidate) =>
          candidate.dialog && !candidate.page.isClosed()
            ? [`\n${candidate.id} has a ${dialogStatus(candidate.dialog)}.`]
            : [],
        )
        .join("");
      await Promise.allSettled(
        [...opened]
          .filter((candidate) => !candidate.page.isClosed())
          .map((candidate) => manager.closeTab(candidate.id)),
      );
      const closed = opened.size ? ` Closed ${opened.size} tab(s) it opened.` : "";
      const hint = "Browser calls already in flight were left to finish.";
      const advice =
        stop.reason === "timeout"
          ? `${hint} Raise timeout_ms, split the work, or run it with background: true.`
          : hint;
      throw new ToolError(
        `${stop.message}${closed}${leftOpen}${logs.length ? `\nLogs so far:\n${logs.join("\n")}` : ""}`,
        advice,
        { error: { name: "Error", message: stop.message } },
      );
    }
    throw scriptFailure(cause, code, logs);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCancel);
    for (const target of driven) target.scripts?.delete(watch);
    finished = true;
    for (const releaseRendering of rendering.values()) releaseRendering();
    await host.halt({
      reason: "ended",
      message: "The script has already ended; browser objects from it can no longer be used.",
    });
    await host.release();
  }
}
