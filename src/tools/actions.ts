import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { untilAborted, withDeadline } from "../async.ts";
import type { Locator } from "playwright-core";
import type { Tab } from "../browser.ts";
import { describeError, ToolError } from "../errors.ts";
import { describePage, runAction } from "../page.ts";
import { registerSecret } from "../script.ts";
import type { SecretField } from "../secrets.ts";
import { describeOverlayClicks, dismissOverlays } from "../overlays.ts";
import { cancelled, defineTool, includeDiffParam, includeSnapshotParam, NO_DOM_CHANGE, pageBound, tabParam, targetParam, timeoutParam, type ToolDeps } from "./common.ts";

export function registerActionTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, secrets, redactor } = deps;

  type FieldInput = { target: string; text?: string; secret?: string; secret_field?: string; slowly?: boolean; timeout_ms?: number };

  async function pickOption(locator: Locator, target: string, value: string, control: string, timeout?: number) {
    await locator.click({ timeout });
    const handle = await locator.elementHandle({ timeout });
    const frame = (await handle?.ownerFrame()) ?? null;
    await handle?.dispose();
    const options = (frame ?? locator.page().mainFrame()).getByRole("option");
    await options.first().waitFor({ state: "visible", timeout: 2000 }).catch(() => undefined);
    const names = await options.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { name: (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim(), visible: box.width > 0 && box.height > 0 };
      }),
    );
    const wanted = value.trim().toLowerCase();
    const visible = names.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.visible);
    const match = visible.find((entry) => entry.name.toLowerCase() === wanted) ?? visible.find((entry) => entry.name.toLowerCase().includes(wanted));
    if (match) {
      await options.nth(match.index).click({ timeout });
      return `Picked option ${JSON.stringify(match.name)} in ${target} (a ${control}, opened with a click).`;
    }
    await locator.page().keyboard.press("Escape").catch(() => undefined);
    if (visible.length) {
      throw new ToolError(
        `${target} is a ${control} with no option named ${JSON.stringify(value)}. Options: ${visible.slice(0, 40).map((entry) => entry.name).join(", ")}.`,
        "Fill again with one of these names, or type into the control's search box if it has one.",
      );
    }
    throw new ToolError(
      `${target} is a ${control}, not a text field, and showed no option named ${JSON.stringify(value)} after a click.`,
      "Click the control, take a snapshot, then click the option (or the date in the calendar) by its ref.",
    );
  }

  async function fillField(tab: Tab, field: FieldInput) {
    if ((field.text === undefined) === (field.secret === undefined)) {
      throw new ToolError(`Give exactly one of text or secret for ${field.target}.`);
    }
    const locator = await manager.resolve(tab, field.target);
    const secretField: SecretField = field.secret_field ?? "password";
    const value = field.secret === undefined ? (field.text ?? "") : await secrets.get(field.secret, secretField);
    if (field.secret !== undefined) registerSecret(redactor, field.secret, secretField, value);

    const kind = await locator.evaluate(
      (element) => ({
        tag: element.tagName.toLowerCase(),
        type: (element.getAttribute("type") ?? "").toLowerCase(),
        editable: (element as HTMLElement).isContentEditable,
        readOnly: (element as HTMLInputElement).readOnly === true,
        role: element.getAttribute("role") ?? "",
      }),
      undefined,
      { timeout: field.timeout_ms },
    );
    if (kind.tag === "input" && kind.type === "file") {
      throw new ToolError(`${field.target} is a file input.`, "Use upload with the file paths.");
    }
    if (kind.tag === "iframe" && field.secret === undefined) {
      const body = locator.contentFrame().locator("body");
      if (!(await body.evaluate((element) => (element as HTMLElement).isContentEditable || element.ownerDocument.designMode === "on", undefined, { timeout: field.timeout_ms }))) {
        throw new ToolError(`${field.target} is an iframe without an editable body.`, "Take a snapshot and target the field inside the frame by its ref.");
      }
      if (field.slowly) {
        await body.click({ timeout: field.timeout_ms });
        await body.fill("", { timeout: field.timeout_ms });
        await body.pressSequentially(value, { delay: 45 });
      } else {
        await body.fill(value, { timeout: field.timeout_ms });
      }
      return { locator: body, summary: `Filled the editor in ${field.target} (${value.length} chars).` };
    }
    const native = kind.editable || ((kind.tag === "input" || kind.tag === "textarea") && !kind.readOnly) || kind.tag === "select";
    if (!native && field.secret === undefined) {
      const control = kind.tag === "input" ? "read-only input (probably a date or option picker)" : `custom ${kind.role || kind.tag} control`;
      return { locator, summary: await pickOption(locator, field.target, value, control, field.timeout_ms) };
    }
    const choice = kind.tag === "select" || kind.type === "checkbox" || kind.type === "radio";
    if (kind.tag === "select") {
      await locator.selectOption(value, { timeout: field.timeout_ms });
    } else if (choice) {
      await locator.setChecked(/^(true|1|on|yes|checked)$/i.test(value), { timeout: field.timeout_ms });
    } else if (field.slowly) {
      await locator.click({ timeout: field.timeout_ms });
      await locator.fill("", { timeout: field.timeout_ms });
      await locator.pressSequentially(value, { delay: 45 });
    } else {
      await locator.fill(value, { timeout: field.timeout_ms });
    }

    if (field.secret !== undefined) return { locator, summary: `Filled ${field.target} with secret ${field.secret} (${secretField}).` };
    const current = choice || kind.editable ? undefined : await locator.inputValue().catch(() => undefined);
    const mismatch =
      current !== undefined && current !== value
        ? ` The field now reads ${JSON.stringify(current.slice(0, 80))}; the page reformatted or rejected the input.`
        : "";
    return { locator, summary: `Filled ${field.target} (${value.length} chars).${mismatch}` };
  }

  defineTool(server, deps, {
    name: "click",
    title: "Click",
    description:
      "Click an element. Waits for it to be visible, enabled and not covered, scrolls it into view, then clicks. The result says whether the page navigated, changed (in any frame), did not react, or could not be checked, and reports dialogs, downloads and new tabs triggered by the click, as well as a CAPTCHA or a sign-in page it led to. Use it for buttons, links, tabs, menu items and options; include_diff returns only the snapshot lines the click changed. When the click fails because another element intercepts it, a banner or modal is usually in the way, which dismiss_overlays clears. For many clicks in a row, such as pressing a button repeatedly or paging through results, run_script does them in one call.",
    input: {
      tab: tabParam,
      target: targetParam,
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button. Default left."),
      click_count: z.number().int().min(1).max(3).optional().describe("2 for a double click, 3 to select a paragraph. Default 1."),
      modifiers: z.array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])).optional().describe("Modifier keys held during the click."),
      timeout_ms: timeoutParam(8000),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await locator.click({
            button: input.button ?? "left",
            clickCount: input.click_count ?? 1,
            modifiers: input.modifiers,
            timeout: input.timeout_ms,
          });
          return `Clicked ${input.target}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff },
      );
    },
  });

  defineTool(server, deps, {
    name: "fill",
    title: "Fill field",
    description: [
      "Set the value of one form control: types into text inputs and textareas, picks an option in a <select> by label or value, and checks or unchecks checkboxes and radios (text \"true\" or \"false\"). Replaces the existing value, and says when the page reformatted or rejected it. Rich-text editors (contenteditable, or an iframe whose body is editable) are filled with line breaks kept. A custom control that is not a text field (a role=combobox or listbox button, a read-only date or option picker) is clicked open and the visible option whose name matches text is picked; if none matches, the error lists the options or says to click, snapshot and click the option yourself.",
      "To enter a stored credential, pass secret, a name from secrets_list, instead of text: the server reads the value from the password store and types it without returning it. Passwords and other secret fields are then masked, also in JSON- and URL-encoded form and one-time codes for 2 minutes, in later tool results, in the text files the server writes (collect_pages files, overflow files, reports, script and job output), in page text sent to the ask_pages model and in the server log. They are not masked in usernames, raw exports (cookies export, network_export, storage export), downloads, binary files and screenshots.",
      "For several fields of one form, fill_form fills them in one call and reports invalid fields; for file inputs use upload.",
    ].join("\n"),
    input: {
      tab: tabParam,
      target: targetParam,
      text: z.string().optional().describe("Value to enter. Give either text or secret."),
      secret: z.string().optional().describe("Name of a password-store entry from secrets_list, used instead of text."),
      secret_field: z.string().optional().describe("Which part of the secret to enter: password (default), username, otp for a current one-time code, or any other field name stored in the entry."),
      submit: z.boolean().optional().describe("Press Enter in the field afterwards. Default false."),
      slowly: z.boolean().optional().describe("Type key by key instead of setting the value at once, for fields that react to individual keystrokes such as autocomplete. Default false."),
      timeout_ms: timeoutParam(8000),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const { locator, summary } = await fillField(tab, input);
          if (input.submit) await locator.press("Enter");
          return summary;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: input.submit ? "No DOM change after pressing Enter." : "" },
      );
    },
  });

  defineTool(server, deps, {
    name: "fill_form",
    title: "Fill several fields",
    description:
      "Fill several form controls in one call, in order, with the same rules as fill (text inputs, selects by label or value, checkboxes and radios with true or false, custom pickers, stored secrets by name), then optionally click a submit element. Use it for sign-up, sign-in, checkout, address, payment and search forms. It stops at the first field that cannot be filled and reports which fields were done. Afterwards it reports any field the browser marks invalid, with the browser's validation message. fill suits a single field, or a field that has to react before the next one appears.",
    input: {
      tab: tabParam,
      fields: z
        .array(
          z.object({
            target: targetParam,
            text: z.string().optional().describe("Value to enter. Give either text or secret."),
            secret: z.string().optional().describe("Name of a password-store entry, used instead of text."),
            secret_field: z.string().optional().describe("password (default), username, otp, or another field of the entry."),
          }),
        )
        .min(1)
        .max(60)
        .describe("Fields to fill, in order."),
      submit: targetParam.optional().describe("Element to click after all fields are filled, usually the submit button (ref or selector)."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const lines: string[] = [];
          const filled: { target: string; locator: Awaited<ReturnType<typeof fillField>>["locator"] }[] = [];
          for (const field of input.fields) {
            try {
              const result = await fillField(tab, field);
              filled.push({ target: field.target, locator: result.locator });
              lines.push(result.summary);
            } catch (error) {
              throw new ToolError(
                `Filled ${filled.length} of ${input.fields.length} fields, then ${field.target} failed: ${describeError(error).split("\n")[0]}`,
                lines.length ? `Done before the failure:\n${lines.join("\n")}` : undefined,
              );
            }
          }
          for (const entry of filled) {
            const message = await entry.locator
              .evaluate((element) => {
                const control = element as HTMLInputElement;
                return control.validity && !control.validity.valid ? control.validationMessage || "invalid" : "";
              })
              .catch(() => "");
            if (message) lines.push(`Invalid: ${entry.target} — ${message}`);
          }
          if (input.submit) {
            await (await manager.resolve(tab, input.submit)).click();
            lines.push(`Clicked ${input.submit}.`);
          }
          return lines.join("\n");
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: input.submit ? "No DOM change after the submit click." : "" },
      );
    },
  });

  defineTool(server, deps, {
    name: "press",
    title: "Press key",
    description:
      "Press a key or key combination, on a specific element or on whatever has focus. Uses Playwright key names: Enter, Escape, Tab, ArrowDown, Backspace, a, Control+a, Shift+Tab. Use it to submit with Enter, close a menu or dialog with Escape, move through a list, menu or date picker with the arrow keys, or trigger a keyboard shortcut. The result says whether the page navigated or changed, as for click. To enter text into a field, fill is faster.",
    input: {
      tab: tabParam,
      key: z.string().min(1).describe("Key or combination, for example Enter or Control+a."),
      target: targetParam.optional().describe("Focus this element first (ref or selector). Omit to send the key to the focused element."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      return runAction(
        manager,
        store,
        tab,
        async () => {
          if (locator) await locator.press(input.key);
          else await tab.page.keyboard.press(input.key);
          return `Pressed ${input.key}${input.target ? ` on ${input.target}` : ""}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: NO_DOM_CHANGE },
      );
    },
  });

  defineTool(server, deps, {
    name: "hover",
    title: "Hover",
    description:
      "Move the mouse over an element and leave it there, to reveal menus, tooltips or controls that only appear on hover. The result says whether the page changed; take a snapshot afterwards (or pass include_snapshot) to get refs for what appeared.",
    input: { tab: tabParam, target: targetParam, include_snapshot: includeSnapshotParam, include_diff: includeDiffParam },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await locator.hover();
          return `Hovering ${input.target}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: NO_DOM_CHANGE },
      );
    },
  });

  defineTool(server, deps, {
    name: "drag",
    title: "Drag and drop",
    description:
      "Drag one element onto another with real mouse events: press on the source, move to the target, release. Works for sortable lists, kanban boards, sliders with a drop target, and HTML5 drag and drop. For dragging by pixel offsets, such as a slider without a drop target or drawing on a canvas, use run_script with page.mouse.",
    input: {
      tab: tabParam,
      from: targetParam.describe("Element to drag (ref or selector)."),
      to: targetParam.describe("Element to drop onto (ref or selector)."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const source = await manager.resolve(tab, input.from);
      const destination = await manager.resolve(tab, input.to);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await source.dragTo(destination);
          return `Dragged ${input.from} onto ${input.to}.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: NO_DOM_CHANGE },
      );
    },
  });

  defineTool(server, deps, {
    name: "scroll",
    title: "Scroll",
    description:
      "Scroll an element into view, or scroll the page by a number of pixels or to the top or bottom. Use it on pages that load more content as you scroll, such as feeds and lazy-loaded lists, or to bring something into view before a screenshot; action tools already scroll their own target into view. To gather everything from a long infinite-scroll list, collect_pages with scroll or a loop in run_script does it in one call.",
    input: {
      tab: tabParam,
      target: targetParam.optional().describe("Scroll this element into view (ref or selector). When set, direction and amount are ignored."),
      direction: z.enum(["down", "up", "left", "right", "top", "bottom"]).optional().describe("Direction to scroll the page; top and bottom jump to the ends. Default down."),
      amount: z.number().int().min(1).max(100_000).optional().describe("Distance in pixels for down, up, left and right. Default 800."),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      const direction = input.direction ?? "down";
      const amount = input.amount ?? 800;
      return runAction(
        manager,
        store,
        tab,
        async () => {
          if (locator) {
            await locator.scrollIntoViewIfNeeded();
            return `Scrolled ${input.target} into view.`;
          }
          if (direction === "top" || direction === "bottom") {
            await pageBound(tab.page.evaluate((toBottom) => window.scrollTo(0, toBottom ? document.documentElement.scrollHeight : 0), direction === "bottom"), "scroll");
            return `Scrolled to the ${direction}.`;
          }
          const horizontal = direction === "left" ? -amount : direction === "right" ? amount : 0;
          const vertical = direction === "up" ? -amount : direction === "down" ? amount : 0;
          await tab.page.mouse.wheel(horizontal, vertical);
          return `Scrolled ${direction} ${amount}px.`;
        },
        { includeSnapshot: input.include_snapshot, includeDiff: input.include_diff, noChangeText: NO_DOM_CHANGE },
      );
    },
  });

  defineTool(server, deps, {
    name: "upload",
    title: "Upload files",
    description:
      "Attach local files to a file input, or to a button that opens a file chooser. Use it for avatars, documents, attachments and imports; fill refuses file inputs. Paths are on the machine running this server and must exist. The result says whether the page changed, as for click.",
    input: {
      tab: tabParam,
      target: targetParam.describe("The file input, or the button that opens the file chooser (ref or selector)."),
      paths: z.array(z.string().min(1)).min(1).max(20).describe("Absolute paths of the files to attach."),
    },
    handler: async (input) => {
      for (const filePath of input.paths) {
        const info = await stat(filePath).catch(() => undefined);
        if (!info?.isFile()) throw new ToolError(`No file at ${filePath}.`);
      }
      const tab = manager.getTab(input.tab);
      const locator = await manager.resolve(tab, input.target);
      return runAction(manager, store, tab, async () => {
        const isFileInput = await locator.evaluate((element) => element instanceof HTMLInputElement && element.type === "file");
        if (isFileInput) {
          await locator.setInputFiles(input.paths);
        } else {
          const [chooser] = await Promise.all([tab.page.waitForEvent("filechooser"), locator.click()]);
          await chooser.setFiles(input.paths);
        }
        return `Attached ${input.paths.length} file(s) to ${input.target}.`;
      }, { noChangeText: NO_DOM_CHANGE });
    },
  });

  defineTool(server, deps, {
    name: "wait_for",
    title: "Wait for condition",
    description:
      "Wait until one condition holds: text becomes visible, an element reaches a state, the URL matches, or a network response arrives. Give exactly one of text, target, url, request. Use it when a page finishes its work after the action returns, such as search results loading, a payment redirecting back, or an export showing Done. Response waits only see responses that arrive after this call starts, so for a request triggered by a click, check network_requests afterwards instead. To wait for the user to do something, use handoff.",
    input: {
      tab: tabParam,
      text: z.string().optional().describe("Wait until this text is visible on the page."),
      target: targetParam.optional().describe("Wait for this element (ref or selector) to reach `state`."),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional().describe("State for target. Default visible."),
      url: z.string().optional().describe("Wait until the tab's URL contains this text, or matches it as a glob when it contains *."),
      request: z.string().optional().describe("Wait for a network response whose URL contains this text."),
      timeout_ms: timeoutParam(10_000),
    },
    readOnly: true,
    handler: async (input, _owner, signal) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 10_000;
      const given = [input.text, input.target, input.url, input.request].filter((value) => value !== undefined).length;
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
        await wait(tab.page.waitForURL(expected.includes("*") ? expected : (url) => url.href.includes(expected), { timeout }));
        return `URL is now ${tab.page.url()}`;
      }
      const expected = input.request ?? "";
      const response = await wait(tab.page.waitForResponse((candidate) => candidate.url().includes(expected), { timeout }));
      return `${response.request().method()} ${response.status()} ${response.url()}`;
    },
  });

  defineTool(server, deps, {
    name: "dismiss_overlays",
    title: "Dismiss cookie banners and modals",
    description: [
      "Make one pass over the page and its iframes, find cookie and consent banners, newsletter pop-ups and other modals, and click the control that closes each one. In consent banners (marked as cookie, consent, GDPR, privacy, KVKK, Datenschutz or a known consent platform, or mentioning cookies) it prefers reject all, then only necessary, then close or cancel, and clicks accept only with allow_accept and when nothing else is offered. In any other dialog or pop-up it clicks only a close or cancel control (close, ×, no thanks, cancel, vazgeç, iptal and the like), never a confirm, continue, order or pay button. Buttons are recognised by their accessible name in English, Turkish, German, French and Spanish. Reports what it clicked, what it left alone, or that nothing was found.",
      "Use it when a banner or pop-up covers the page, or a click reports that another element intercepts pointer events. It does not install anything that runs later, so call it again after a navigation if a new banner appears. A dialog that asks to confirm an order or payment the task wants is answered with click.",
    ].join("\n"),
    input: {
      tab: tabParam,
      allow_accept: z.boolean().optional().describe("In a consent banner that offers no reject, close or cancel control, click its accept or OK button. Default false."),
      include_snapshot: includeSnapshotParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const allowAccept = input.allow_accept ?? false;
      return runAction(manager, store, tab, async () => describeOverlayClicks(await dismissOverlays(tab.page, allowAccept), allowAccept), {
        includeSnapshot: input.include_snapshot,
      });
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
      message: z.string().min(1).max(300).describe("What the user needs to do, in one sentence, shown in the notification."),
      until_text: z.string().optional().describe("Done when this text is visible on the page."),
      until_gone: z.string().optional().describe("Done when this text is no longer visible, for example the challenge prompt."),
      until_url: z.string().optional().describe("Done when the tab's URL contains this."),
      timeout_ms: z.number().int().min(5000).max(1_800_000).optional().describe("How long to wait for the user. Default 300000 (5 minutes)."),
    },
    handler: async (input, _owner, signal) => {
      const tab = manager.getTab(input.tab);
      const timeout = input.timeout_ms ?? 300_000;
      await tab.page.bringToFront().catch(() => undefined);
      const notified = new Promise<string | undefined>((resolve) => {
        execFile("notify-send", ["-a", "web-agent", "-u", "critical", "--", "The browser agent needs you", `${input.message} (tab ${tab.id})`], (error, _stdout, stderr) =>
          resolve(error ? `${String(stderr).trim().split("\n")[0] || error.message}` : undefined),
        );
      });
      const notifyResult = await withDeadline(notified, 2000);
      const notifyNote =
        typeof notifyResult === "string" ? `\nThe desktop notification could not be shown (${notifyResult}); tell the user in the conversation as well.` : "";

      const waiting: Promise<unknown> = input.until_text
        ? tab.page.getByText(input.until_text).first().waitFor({ state: "visible", timeout })
        : input.until_gone
          ? tab.page.getByText(input.until_gone).first().waitFor({ state: "hidden", timeout })
          : input.until_url
            ? tab.page.waitForURL((url) => url.href.includes(input.until_url ?? ""), { timeout })
            : tab.page.waitForEvent("framenavigated", { predicate: (frame) => frame === tab.page.mainFrame(), timeout });
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
