import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TIMED_OUT, untilAborted, withDeadline } from "../shared/async.ts";
import { cancelled, ToolError } from "../shared/errors.ts";
import { describePage, runAction } from "../page/page.ts";
import { describeOverlayClicks, dismissOverlays } from "../overlays/dismiss.ts";
import {
  defineTool,
  includeSnapshotParam,
  tabParam,
  targetParam,
  timeoutParam,
  type ToolDeps,
} from "./common.ts";

export function registerWaitTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "wait_for",
    title: "Wait for condition",
    description:
      "Wait until one condition holds: text becomes visible, an element reaches a state, the URL matches, or a network response arrives. Give exactly one of text, target, url, request. Use it when a page finishes its work after the action returns, such as search results loading, a payment redirecting back, or an export showing Done. Response waits only see responses that arrive after this call starts, so for a request triggered by a click, check network_requests afterwards instead. To wait for the user to do something, use handoff.",
    input: {
      tab: tabParam,
      text: z.string().optional().describe("Wait until this text is visible on the page."),
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
          "Wait until the tab's URL contains this text, or matches it as a glob when it contains *.",
        ),
      request: z
        .string()
        .optional()
        .describe("Wait for a network response whose URL contains this text."),
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
      const wait = <T>(promise: Promise<T>) => untilAborted(promise, signal, cancelled);

      if (input.text !== undefined) {
        await wait(tab.page.getByText(input.text).first().waitFor({ state: "visible", timeout }));
        return `Text ${JSON.stringify(input.text)} is visible.`;
      }
      if (input.target !== undefined) {
        const state = input.state ?? "visible";
        await wait(manager.locate(tab, input.target).waitFor({ state, timeout }));
        return `${input.target} is ${state}.`;
      }
      if (input.url !== undefined) {
        const expected = input.url;
        await wait(
          tab.page.waitForURL(
            expected.includes("*") ? expected : (url) => url.href.includes(expected),
            { timeout },
          ),
        );
        return `URL is now ${tab.page.url()}`;
      }
      const expected = input.request ?? "";
      const response = await wait(
        tab.page.waitForResponse((candidate) => candidate.url().includes(expected), { timeout }),
      );
      return `${response.request().method()} ${response.status()} ${response.url()}`;
    },
  });

  defineTool(server, deps, {
    name: "dismiss_overlays",
    title: "Dismiss cookie banners and modals",
    description: [
      'Make one pass over the page and its iframes, find cookie and consent banners, newsletter pop-ups and other modals, and click the control that dismisses each one. In consent banners (marked as cookie, consent, GDPR, privacy, KVKK, Datenschutz or a known consent platform, or mentioning cookies) it clicks accept all (accept all, allow all, agree, OK, tümünü kabul et, alle akzeptieren, tout accepter, aceptar todo and the like), falling back to close or cancel; with consent: reject it prefers reject all, then only necessary, then close or cancel, and accepts only when nothing else is offered and allow_accept is not false. In any other dialog or pop-up it clicks only a close or cancel control (close, ×, ✕, dismiss, no thanks, cancel, kapat, vazgeç, iptal and the like), which may be a button, a link or any clickable element or text such as a plain "Close" line, never an accept, confirm, continue, order or pay button, and a button whose name contains an order or payment word is never clicked anywhere. When a modal has no such control or stays open after the click, it presses Escape and then clicks the backdrop outside the modal, never a control there. Controls are recognised by their accessible name or text in English, Turkish, German, French and Spanish. Reports each modal as closed by what closed it, or found but not closed by anything tried, what it clicked in banners, what it left alone, or that nothing was found.',
      "tab_open, navigate and collect_pages already accept cookie banners on the agent's own tabs by themselves (WEB_AGENT_AUTO_CONSENT=accept, reject or off on the server), so call this when a banner or pop-up still covers the page, or a click reports that another element intercepts pointer events. It does not install anything that runs later. A dialog that asks to confirm an order or payment the task wants is answered with click.",
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
      "Hand a step that only the user can do to them, and wait until it is done: a CAPTCHA or bot check, a code sent to their phone or email, a passkey or security-key prompt, or a bank's approval screen. Brings the tab to the front, shows a desktop notification with your message (the result says if the notification could not be shown), and returns when the condition holds: until_text becomes visible, until_gone disappears, the URL contains until_url, or, with none of them, the tab navigates. A Challenge: line in a tab_open, navigate or action result, or an event saying the page requested a passkey, means such a step is showing.",
      "Everything else the user asked for, including signing in with stored credentials, signing up, placing an order and paying, is done with the other tools without a handoff. If the time runs out the user has not finished; ask them in the conversation rather than calling it again.",
    ].join("\n"),
    input: {
      tab: tabParam,
      message: z
        .string()
        .min(1)
        .max(300)
        .describe("What the user needs to do, in one sentence, shown in the notification."),
      until_text: z.string().optional().describe("Done when this text is visible on the page."),
      until_gone: z
        .string()
        .optional()
        .describe("Done when this text is no longer visible, for example the challenge prompt."),
      until_url: z.string().optional().describe("Done when the tab's URL contains this."),
      timeout_ms: z
        .number()
        .int()
        .min(5000)
        .max(1_800_000)
        .optional()
        .describe("How long to wait for the user. Default 300000 (5 minutes)."),
    },
    handler: async (input, _owner, signal) => {
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

      const waiting: Promise<unknown> = input.until_text
        ? tab.page.getByText(input.until_text).first().waitFor({ state: "visible", timeout })
        : input.until_gone
          ? tab.page.getByText(input.until_gone).first().waitFor({ state: "hidden", timeout })
          : input.until_url
            ? tab.page.waitForURL((url) => url.href.includes(input.until_url ?? ""), { timeout })
            : tab.page.waitForEvent("framenavigated", {
                predicate: (frame) => frame === tab.page.mainFrame(),
                timeout,
              });
      try {
        await untilAborted(waiting, signal, cancelled);
      } catch (error) {
        if (/Timeout/i.test(String(error))) {
          throw new ToolError(
            `The user has not completed the step within ${Math.round(timeout / 1000)} s: ${input.message}`,
            `Tab ${tab.id} is still at ${tab.page.url()}. Tell the user what is waiting and continue when they confirm.${notifyNote}`,
          );
        }
        throw error;
      }
      return `The user completed the step. Tab ${tab.id} is at ${await describePage(tab.page)}${notifyNote}`;
    },
  });
}
