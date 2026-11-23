import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Page } from "playwright-core";
import { z } from "zod";
import { TIMED_OUT, untilAborted, withDeadline } from "../shared/async.ts";
import { cancelled, ToolError } from "../shared/errors.ts";
import { shownUrl } from "../shared/output.ts";
import { describePage, runAction } from "../page/page.ts";
import { describeOverlayClicks, dismissOverlays } from "../overlays/dismiss.ts";
import { urlPattern } from "../browser/network.ts";
import {
  defineTool,
  includeSnapshotParam,
  tabParam,
  targetParam,
  timeoutParam,
  type ToolDeps,
} from "./common.ts";

export function urlContains(expected: string) {
  return (url: URL) => url.href.includes(expected);
}

export function urlCondition(expected: string) {
  return expected.includes("*") ? expected : urlContains(expected);
}

type HandoffCondition =
  | { kind: "text"; text: string }
  | { kind: "gone"; text: string }
  | { kind: "url"; url: string }
  | { kind: "navigation" };

export function handoffCondition(input: {
  until_text?: string;
  until_gone?: string;
  until_url?: string;
}): HandoffCondition {
  const given = [input.until_text, input.until_gone, input.until_url].filter(
    (value) => value !== undefined,
  ).length;
  if (given > 1) throw new ToolError("Give at most one of until_text, until_gone, until_url.");
  if (input.until_text !== undefined) return { kind: "text", text: input.until_text };
  if (input.until_gone !== undefined) return { kind: "gone", text: input.until_gone };
  if (input.until_url !== undefined) return { kind: "url", url: input.until_url };
  return { kind: "navigation" };
}

async function conditionMet(page: Page, condition: HandoffCondition, timeout: number) {
  switch (condition.kind) {
    case "text":
      return visibleText(page, condition.text).waitFor({ state: "visible", timeout });
    case "gone":
      return visibleText(page, condition.text).waitFor({ state: "hidden", timeout });
    case "url":
      return page.waitForURL(urlCondition(condition.url), { timeout });
    case "navigation":
      await page.waitForEvent("framenavigated", {
        predicate: (frame) => frame === page.mainFrame(),
        timeout,
      });
  }
}

function visibleText(page: Page, text: string) {
  return page.getByText(text).filter({ visible: true }).first();
}

export function registerWaitTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "wait_for",
    title: "Wait for condition",
    description:
      "Wait until one condition holds: text becomes visible, an element reaches a state, the URL matches, or a network response arrives. Give exactly one of text, target, url, request. Use it when a page finishes its work after the action returns, such as search results loading, a payment redirecting back, or an export showing Done. Response waits only see responses that arrive after this call starts, so for a request a click triggered, check network afterwards instead. To wait for the user to do something, use handoff.",
    input: {
      tab: tabParam,
      text: z
        .string()
        .optional()
        .describe("Wait until a visible element contains this text (case-insensitive substring)."),
      target: targetParam
        .optional()
        .describe("Wait for this element (ref or selector) to reach `state`."),
      state: z
        .enum(["visible", "hidden", "attached", "detached"])
        .optional()
        .describe("State for target. Default visible."),
      url: z
        .string()
        .optional()
        .describe(
          "Wait until the tab's URL contains this text. Text with * is a Playwright glob that must match the whole URL: * matches any characters except /, ** matches any characters including /, such as **/checkout*.",
        ),
      request: z
        .string()
        .optional()
        .describe(
          "Wait for a network response whose URL contains this text, ignoring case; * stands for any characters, / included, for example **/api/*.",
        ),
      timeout_ms: timeoutParam(10_000),
    },
    readOnly: true,
    handler: async (input, _owner, signal) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 10_000;
      const given = [input.text, input.target, input.url, input.request].filter(
        (value) => value !== undefined,
      ).length;
      if (given !== 1) throw new ToolError("Give exactly one of text, target, url, request.");
      const wait = async <T>(promise: Promise<T>, missed: string) => {
        try {
          return await untilAborted(promise, signal, cancelled);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          throw new ToolError(
            `${missed} within ${timeout / 1000} s.`,
            "Take a snapshot to see the page now, then wait again with a longer timeout_ms or for another condition.",
          );
        }
      };

      if (input.text !== undefined) {
        await wait(
          visibleText(tab.page, input.text).waitFor({ state: "visible", timeout }),
          `Text ${JSON.stringify(input.text)} did not become visible`,
        );
        return `Text ${JSON.stringify(input.text)} is visible.`;
      }
      if (input.target !== undefined) {
        const state = input.state ?? "visible";
        const absence = state === "hidden" || state === "detached";
        const reached = absence
          ? manager.waitForAbsence(tab, input.target, state, timeout)
          : manager
              .resolve(tab, input.target, timeout)
              .then((locator) => locator.waitFor({ state, timeout }));
        await wait(reached, `${input.target} did not become ${state}`);
        return `${input.target} is ${state}.`;
      }
      if (input.url !== undefined) {
        await wait(
          tab.page.waitForURL(urlCondition(input.url), { timeout }),
          `The URL did not match ${input.url}`,
        );
        return `URL is now ${shownUrl(tab.page.url())}`;
      }
      const expected = input.request ?? "";
      const pattern = urlPattern(expected);
      const response = await wait(
        tab.page.waitForResponse((candidate) => pattern.test(candidate.url()), { timeout }),
        `No response with ${JSON.stringify(expected)} in its URL arrived`,
      );
      return `${response.request().method()} ${response.status()} ${response.url()}`;
    },
  });

  defineTool(server, deps, {
    name: "dismiss_overlays",
    title: "Dismiss cookie banners and modals",
    description: [
      "Make one pass over the page and its iframes and close cookie and consent banners, newsletter pop-ups and other modals. In a consent banner it clicks accept all by default, falling back to close or cancel; with consent: reject it prefers reject all, then only necessary, then close or cancel, and accepts only when nothing else is offered and allow_accept is not false. In any other modal it clicks only a close or cancel control (a button, link or plain clickable text such as Close or ×), never accept, confirm, continue, order or pay, and nothing whose name contains an order or payment word is ever clicked. When a modal has no such control or stays open, it presses Escape, then clicks the backdrop outside it. Labels are recognised in English, Turkish, German, French and Spanish. Reports each modal as closed (and by what) or not closed, what it clicked in banners, what it left alone, or that nothing was found.",
      "navigate and save_pages already handle cookie banners on the agent's own tabs by the server's consent setting, so call this when a banner or pop-up still covers the page, or a click reports that another element intercepts pointer events. It does not install anything that runs later. A dialog that confirms an order or payment the task wants is answered with click.",
    ].join("\n"),
    input: {
      tab: tabParam,
      consent: z
        .enum(["accept", "reject"])
        .optional()
        .describe("What to click in a consent banner: accept (default) or reject."),
      allow_accept: z
        .boolean()
        .optional()
        .describe(
          "With consent: reject, click accept in a consent banner that offers no reject, close or cancel control. Default true.",
        ),
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const options = {
        consent: input.consent ?? ("accept" as const),
        allowAccept: input.allow_accept ?? true,
      };
      return runAction(
        manager,
        store,
        tab,
        async () => describeOverlayClicks(await dismissOverlays(tab.page, options)),
        {
          includeSnapshot: input.include_snapshot,
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "handoff",
    title: "Hand a step to the user",
    description: [
      "Hand a step that only the user can do to them, and wait until it is done: a CAPTCHA or bot check you could not get past yourself, a code sent to their phone or email, a passkey or security-key prompt, or a bank's approval screen. Brings the tab to the front, shows a desktop notification with your message (the result says if it could not be shown), and returns when the condition holds: until_text becomes visible, until_gone disappears, the URL matches until_url, or, with none of them, the tab navigates; default wait 5 minutes. A Challenge: line in a navigate or action result means a bot check is showing: try it first (click its checkbox or follow its prompt with human: true, then wait_for it to go) and hand it over when it does not clear. An event saying the page requested a passkey means such a step is showing; a Blocked: line does not, since the site refused the visit and handing it over does not help.",
      "Everything else the user asked for, including signing in with stored credentials, signing up, placing an order and paying, is done with the other tools without a handoff. If the time runs out the user has not finished; ask them in the conversation rather than calling it again.",
    ].join("\n"),
    input: {
      tab: tabParam,
      message: z
        .string()
        .min(1)
        .max(300)
        .describe("What the user needs to do, in one sentence, shown in the notification."),
      until_text: z
        .string()
        .optional()
        .describe(
          "Done when a visible element contains this text (case-insensitive substring). Give at most one of until_text, until_gone, until_url.",
        ),
      until_gone: z
        .string()
        .optional()
        .describe(
          "Done when no visible element contains this text any more, for example the challenge prompt.",
        ),
      until_url: z
        .string()
        .optional()
        .describe(
          "Done when the tab's URL contains this text. Text with * is a Playwright glob that must match the whole URL: * matches any characters except /, ** matches any characters including /.",
        ),
      timeout_ms: z
        .number()
        .int()
        .min(5000)
        .max(1_800_000)
        .optional()
        .describe("How long to wait for the user. Default 300000 (5 minutes)."),
    },
    handler: async (input, _owner, signal) => {
      const condition = handoffCondition(input);
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 300_000;
      await tab.page.bringToFront().catch(() => undefined);
      const notified = deps.notify(
        "The browser agent needs you",
        `${input.message} (tab ${tab.id})`,
      );
      const notifyResult = await withDeadline(notified, 2000);
      const notifyNote =
        notifyResult !== undefined && notifyResult !== TIMED_OUT
          ? `\nThe desktop notification could not be shown (${notifyResult}); tell the user in the conversation as well.`
          : "";

      const waiting = conditionMet(tab.page, condition, timeout);
      try {
        await untilAborted(waiting, signal, cancelled);
      } catch (error) {
        if (/Timeout/i.test(String(error))) {
          throw new ToolError(
            `The user has not completed the step within ${Math.round(timeout / 1000)} s: ${input.message}`,
            `Tab ${tab.id} is still at ${shownUrl(tab.page.url())}. Tell the user what is waiting and continue when they confirm.${notifyNote}`,
          );
        }
        throw error;
      }
      return `The user completed the step. Tab ${tab.id} is at ${await describePage(tab.page)}${notifyNote}`;
    },
  });
}
