import path from "node:path";
import type { AskAdapter } from "../ask/adapter.ts";
import { AskSetupError } from "../ask/errors.ts";
import type { BrowseResult, BrowseSelection } from "../ask/run.ts";
import type { AskMode } from "../ask/types.ts";
import type { Tab } from "../browser/tab.ts";
import { normalizeUrl, serializedOpener } from "../page/collect.ts";
import { runPool } from "../shared/async.ts";
import { cancelled } from "../shared/errors.ts";
import { slugify } from "../shared/output.ts";
import { TranscriptWriter } from "./transcript.ts";
import { type BrowseHost, openBrowseExecutor } from "./executor.ts";
import { runBrowse } from "./loop.ts";
import { browseFirstMessage, browseSystem } from "./prompt.ts";

export type PageLocation = { url: string; tab?: Tab };

type BrowseRun = {
  owner: string;
  signal: AbortSignal;
  requestId: string;
  model: string;
  maxTokens: number;
  rawDir: string;
  mode: AskMode;
  question: string;
  locations: Map<string, PageLocation>;
  sites: string[];
  concurrency: number;
  modelTimeoutMs?: number;
  pageTimeoutMs?: number;
};

export async function browsePages(
  browseHost: BrowseHost,
  adapter: AskAdapter,
  chosen: BrowseSelection[],
  run: BrowseRun,
) {
  const controller = new AbortController();
  const browseSignal = AbortSignal.any([run.signal, controller.signal]);
  const openTab = serializedOpener(browseHost.manager, run.owner);
  const { sites } = run;
  let setupError: unknown;
  const results = await runPool(
    chosen,
    run.concurrency,
    async (selection, index): Promise<BrowseResult> => {
      const location = run.locations.get(selection.source);
      const url = location?.url ?? "";
      const startedAt = Date.now();
      try {
        const executor = await openBrowseExecutor(browseHost, {
          owner: run.owner,
          requestId: run.requestId,
          sites,
          start: location?.tab
            ? { kind: "tab", tab: location.tab }
            : { kind: "open", url, openTab },
          signal: browseSignal,
        });
        const host = (() => {
          try {
            return new URL(executor.startUrl).host;
          } catch {
            return executor.startUrl;
          }
        })();
        return await runBrowse(adapter, executor, {
          mode: run.mode,
          source: selection.source,
          url,
          system: browseSystem(run.mode),
          found: selection.found,
          firstMessage: browseFirstMessage({
            mode: run.mode,
            source: selection.source,
            tab: executor.tabId,
            url: executor.startUrl,
            found: selection.found,
            unclear: selection.unclear,
            hint: selection.hint,
            sites: [host, ...sites],
            question: run.question,
          }),
          model: run.model,
          maxTokens: run.maxTokens,
          modelTimeoutMs: run.modelTimeoutMs,
          pageTimeoutMs: run.pageTimeoutMs,
          signal: browseSignal,
          log: {
            requestId: run.requestId,
            page: selection.source,
            tab: executor.tabId,
            reason: selection.reason,
          },
          capture: new TranscriptWriter(
            path.join(run.rawDir, `browse-${index + 1}-${slugify(selection.source, 40)}`),
          ),
        });
      } catch (error) {
        if (error instanceof AskSetupError) {
          setupError ??= error;
          controller.abort();
        }
        const message =
          (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
        return {
          source: selection.source,
          url: normalizeUrl(url),
          outcome: browseSignal.aborted ? "cancelled" : "failed",
          lines: [],
          steps: 0,
          toolCalls: [],
          ms: Date.now() - startedAt,
          error: message,
        };
      }
    },
    browseSignal,
  );
  if (setupError) throw setupError;
  if (run.signal.aborted) throw cancelled();
  return results.filter((result): result is BrowseResult => result !== undefined);
}
