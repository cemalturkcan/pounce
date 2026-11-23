import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Locator } from "playwright-core";
import { z } from "zod";
import type { Tab } from "../browser/tab.ts";
import { ACTION_TIMEOUT_MS, type BrowserManager } from "../browser/manager.ts";
import {
  attachFiles,
  checkFiles,
  clicker,
  type FieldInput,
  fillField,
  fillForm,
} from "../page/fill.ts";
import { timedOutWithin, ToolError } from "../shared/errors.ts";
import {
  humanClick,
  humanClickAt,
  humanPress,
  mayClosePage,
  plainClick,
  plainClickAt,
} from "../page/human.ts";
import { answerDialog } from "../browser/dialogs.ts";
import { checkpoint, recordAction, recordStep } from "../shared/call-scope.ts";
import { elementAt, runAction, runAnswer, targetName } from "../page/page.ts";
import { inWidgetCheckbox, widgetCheckboxAt } from "../page/checks.ts";
import {
  chosenAim,
  defineTool,
  humanParam,
  includeDiffParam,
  includeSnapshotParam,
  NO_DOM_CHANGE,
  pointParams,
  tabParam,
  targetParam,
  timeoutParam,
  type ToolDeps,
} from "./common.ts";

async function pressKey(
  tab: Tab,
  locator: Locator | undefined,
  key: string,
  human: boolean | undefined,
) {
  if (!human) {
    await mayClosePage(tab.page, (sending) => {
      if (locator) return locator.press(key, { noWaitAfter: true });
      sending();
      return tab.page.keyboard.press(key);
    });
    return;
  }
  await locator?.focus();
  await humanPress(tab, key);
}

const valueParam = z.string().optional();
const secretParam = z
  .string()
  .optional()
  .describe("Name of a password-store entry, entered instead of value without being shown to you.");
const secretFieldParam = z
  .string()
  .optional()
  .describe(
    "Which part of the secret to enter: password (default), username, otp for a current one-time code, or any other field stored in the entry.",
  );

type FillChoice = {
  target?: string;
  value?: string;
  secret?: string;
  secret_field?: string;
  files?: string[];
  fields?: FieldInput[];
  submit?: boolean | string;
  slowly?: boolean;
  timeout_ms?: number;
  human?: boolean;
};

type FillMode =
  | { kind: "field"; field: FieldInput }
  | { kind: "files"; target: string; files: string[] }
  | { kind: "fields"; fields: FieldInput[] };

function checkEntry(entry: FieldInput, where: string) {
  if ((entry.value === undefined) === (entry.secret === undefined))
    throw new ToolError(`Give exactly one of value or secret${where}.`);
  if (entry.secret_field !== undefined && entry.secret === undefined)
    throw new ToolError(`secret_field needs secret${where ? ` (${entry.target})` : ""}.`);
}

export function fillMode(input: FillChoice): FillMode {
  const { target, fields } = input;
  if ((target === undefined) === (fields === undefined))
    throw new ToolError("Give either target or fields.");
  if (input.submit !== undefined && !String(input.submit).trim())
    throw new ToolError(
      "submit needs a ref or selector of the element to click, or true to press Enter.",
    );
  if (fields !== undefined) {
    if ([input.value, input.secret, input.secret_field].some((given) => given !== undefined))
      throw new ToolError(
        "With fields, give value, secret and secret_field inside each field entry.",
      );
    if (input.files !== undefined)
      throw new ToolError("files work with target only: attach them in a call of their own.");
    if (input.slowly !== undefined)
      throw new ToolError(
        "slowly works with target only: fill a control that needs key-by-key typing in a call of its own.",
      );
    if (input.timeout_ms !== undefined) throw new ToolError("timeout_ms works with target only.");
    for (const entry of fields) checkEntry(entry, ` for ${entry.target}`);
    return { kind: "fields", fields };
  }
  const chosen = target ?? "";
  const given = [input.value, input.secret, input.files].filter((value) => value !== undefined);
  if (given.length !== 1)
    throw new ToolError("Give exactly one of value, secret or files with target.");
  if (input.files === undefined) {
    const field = {
      target: chosen,
      value: input.value,
      secret: input.secret,
      secret_field: input.secret_field,
    };
    checkEntry(field, "");
    return { kind: "field", field };
  }
  if (input.secret_field !== undefined)
    throw new ToolError("secret_field does not apply to files.");
  if (input.slowly !== undefined) throw new ToolError("slowly does not apply to files.");
  if (input.human !== undefined) throw new ToolError("human does not apply to files.");
  if (input.submit === true)
    throw new ToolError(
      "submit: true presses Enter, which a file input ignores; give the submit button as submit instead.",
    );
  return { kind: "files", target: chosen, files: input.files };
}

type Filled = { locator: Locator; label: string };

async function attachedTarget(
  manager: BrowserManager,
  tab: Tab,
  target: string,
  timeout = ACTION_TIMEOUT_MS,
) {
  const startedAt = Date.now();
  const locator = await manager.resolve(tab, target, timeout);
  await locator.waitFor({ state: "attached", timeout });
  const remaining = Math.max(timeout - (Date.now() - startedAt), 1);
  const withinTimeout = (act: (remaining: number) => Promise<void>) =>
    act(remaining).catch((cause: unknown) => {
      throw timedOutWithin(cause, timeout);
    });
  return { locator, withinTimeout };
}

async function submitForm(
  manager: BrowserManager,
  tab: Tab,
  submit: true | string,
  last: Filled,
  human: boolean | undefined,
  timeout: number | undefined,
) {
  checkpoint();
  if (submit === true) {
    recordAction(`pressing Enter in ${last.label}`);
    await pressKey(tab, last.locator, "Enter", human);
    const pressed = `Pressed Enter in ${last.label}.`;
    recordStep(pressed);
    return pressed;
  }
  const { locator, withinTimeout } = await attachedTarget(manager, tab, submit, timeout);
  const label = await targetName(tab, locator, submit);
  checkpoint();
  recordAction(`the click on ${label}`);
  await withinTimeout((remaining) => clicker(tab, human)(locator, remaining));
  const clicked = `Clicked ${label}.`;
  recordStep(clicked);
  return clicked;
}

export function registerInputTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "click",
    title: "Click",
    description:
      "Click an element, or a point given as x and y viewport coordinates for a canvas, map, chart or widget without refs. Waits for the element to be visible, enabled and not covered, scrolls it into view, then clicks. The result names what was clicked (role, name and ref, or the element at the point), says whether the page navigated (with the HTTP status, a redirect, or Chrome's error page and the network error), changed (in any frame), did not react, or could not be checked, and reports dialogs, downloads and new tabs triggered by the click, as well as a CAPTCHA or a sign-in page it led to. When the navigation a click started has no answer from the server within 10 s (or timeout_ms when set), the result says Still loading with the URL: the click happened, so do not click again. Use it for buttons, links, tabs, menu items and options; include_diff returns only the snapshot lines the click changed. When the click fails because another element intercepts it, a banner or modal is usually in the way, which dismiss_overlays clears. For many clicks in a row, such as pressing a button repeatedly or paging through results, run_script does them in one call.",
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe(
          "Element to click: a ref or a selector as for other actions. Omit it and give x and y to click at a point.",
        ),
      ...pointParams,
      button: z
        .enum(["left", "right", "middle"])
        .optional()
        .describe("Mouse button. Default left."),
      click_count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("2 for a double click, 3 to select a paragraph. Default 1."),
      modifiers: z
        .array(z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"]))
        .optional()
        .describe("Modifier keys held during the click."),
      timeout_ms: timeoutParam(8000).describe(
        "How long to wait for the element to become clickable, in milliseconds (default 8000); when the click starts a navigation, also how long to wait for the server's first answer (default 10000).",
      ),
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const aim = await chosenAim(tab, input);
      const options = {
        button: input.button ?? "left",
        clickCount: input.click_count ?? 1,
        modifiers: input.modifiers,
        timeout: input.timeout_ms,
      };
      const settings = {
        includeSnapshot: input.include_snapshot,
        includeDiff: input.include_diff,
        navigationTimeoutMs: input.timeout_ms,
      };
      if ("point" in aim) {
        const { point } = aim;
        const [hit, widgetClicked] = await Promise.all([
          elementAt(tab.page, point),
          widgetCheckboxAt(tab.page, point),
        ]);
        recordAction(`the click at (${point.x}, ${point.y})${hit ? ` on ${hit}` : ""}`);
        return runAction(
          manager,
          store,
          tab,
          async () => {
            if (input.human) await humanClickAt(tab, point, options);
            else await plainClickAt(tab, point, options);
            return `Clicked at (${point.x}, ${point.y})${hit ? ` on ${hit}` : ""}.`;
          },
          { ...settings, widgetClicked },
        );
      }
      const { locator, withinTimeout } = await attachedTarget(
        manager,
        tab,
        aim.target,
        input.timeout_ms,
      );
      const [label, widgetClicked] = await Promise.all([
        targetName(tab, locator, aim.target),
        inWidgetCheckbox(locator),
      ]);
      recordAction(`the click on ${label}`);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await withinTimeout((remaining) =>
            input.human
              ? humanClick(tab, locator, { ...options, timeout: remaining })
              : plainClick(tab, locator, { ...options, timeout: remaining }),
          );
          return `Clicked ${label}.`;
        },
        { ...settings, widgetClicked },
      );
    },
  });

  defineTool(server, deps, {
    name: "fill",
    title: "Fill form",
    description: [
      "Fill one form control (target with value or secret), several controls of a form in order (fields), or attach files to a file input or upload button (target with files), then optionally submit: submit true presses Enter in the (last) field, and a ref or selector clicks that element.",
      'value types into text inputs and textareas, picks a <select> option by label or value, and checks or unchecks checkboxes and radios ("true" or "false"); it replaces the existing value and says when the page reformatted or rejected it. Rich-text editors (contenteditable, or an iframe whose body is editable) keep line breaks. A custom control that is not a text field (a role=combobox or listbox button, a read-only date or option picker) is clicked open and the visible option whose name matches value is picked; if none matches, the error lists the options.',
      "secret names a password-store entry: the server types its value without returning it, and masks it in later results, saved files, text sent to the ask_pages model and the server log (one-time codes for 2 minutes), but not in usernames, raw exports, downloads or screenshots.",
      "fields stops at the first control that cannot be filled and says which were done, then reports controls the browser marks invalid with its message. Fields are set at once; a control that needs key-by-key typing, such as an autocomplete, is filled with target and slowly.",
    ].join("\n"),
    input: {
      tab: tabParam,
      target: targetParam
        .optional()
        .describe(
          "The control to fill, or for files the file input or the button that opens the file chooser (ref or selector). Give target or fields.",
        ),
      value: valueParam.describe(
        "Value to enter. With target, give exactly one of value, secret or files.",
      ),
      secret: secretParam,
      secret_field: secretFieldParam,
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Files to attach with target: paths on the machine running this server, absolute is safest.",
        ),
      fields: z
        .array(
          z.strictObject({
            target: targetParam,
            value: valueParam.describe("Value to enter. Give either value or secret."),
            secret: secretParam,
            secret_field: secretFieldParam,
          }),
        )
        .min(1)
        .max(60)
        .optional()
        .describe("Controls to fill in order, each with value or secret, instead of target."),
      submit: z
        .union([z.boolean(), z.string()])
        .optional()
        .describe(
          "After filling, true presses Enter in the (last) field, and a ref or selector clicks that element, usually the submit button. Default: no submit.",
        ),
      slowly: z
        .boolean()
        .optional()
        .describe(
          "With target: type key by key instead of setting the value at once, for controls that react to each keystroke such as autocomplete. Default false.",
        ),
      timeout_ms: timeoutParam(8000).describe(
        "With target: how long to wait for the control and for a submit element, in milliseconds (default 8000); when the fill or submit starts a navigation, also how long to wait for the server's first answer (default 10000).",
      ),
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const mode = fillMode(input);
      const tab = manager.getTab(input.tab);
      const settings = {
        includeSnapshot: input.include_snapshot,
        includeDiff: input.include_diff,
        navigationTimeoutMs: input.timeout_ms,
        noChangeText:
          input.submit === true
            ? "No DOM change after pressing Enter."
            : input.submit !== undefined && input.submit !== false
              ? "No DOM change after the submit click."
              : mode.kind === "files"
                ? NO_DOM_CHANGE
                : "",
      };
      const submitted = async (last: Filled | undefined) =>
        input.submit === undefined || input.submit === false || !last
          ? []
          : [await submitForm(manager, tab, input.submit, last, input.human, input.timeout_ms)];
      if (mode.kind === "files") {
        await checkFiles(mode.files);
        const locator = await manager.resolve(tab, mode.target);
        const label = await targetName(tab, locator, mode.target);
        const attached = `Attached ${mode.files.length} file(s) to ${label}.`;
        recordAction(`attaching ${mode.files.length} file(s) to ${label}`);
        return runAction(
          manager,
          store,
          tab,
          async () => {
            await attachFiles(tab, locator, mode.files);
            recordStep(attached);
            return [attached, ...(await submitted({ locator, label }))].join("\n");
          },
          settings,
        );
      }
      if (mode.kind === "fields") {
        return runAction(
          manager,
          store,
          tab,
          async () => {
            const { summary, last } = await fillForm(deps, tab, mode.fields, input.human);
            return [summary, ...(await submitted(last))].join("\n");
          },
          settings,
        );
      }
      return runAction(
        manager,
        store,
        tab,
        async () => {
          const filled = await fillField(deps, tab, {
            ...mode.field,
            slowly: input.slowly,
            human: input.human,
            timeout_ms: input.timeout_ms,
          });
          recordStep(filled.summary);
          return [filled.summary, ...(await submitted(filled))].join("\n");
        },
        settings,
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
      target: targetParam
        .optional()
        .describe(
          "Focus this element first (ref or selector). Omit to send the key to the focused element.",
        ),
      human: humanParam,
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      const locator = input.target ? await manager.resolve(tab, input.target) : undefined;
      const label =
        locator && input.target ? await targetName(tab, locator, input.target) : undefined;
      recordAction(`pressing ${input.key}${label ? ` on ${label}` : ""}`);
      return runAction(
        manager,
        store,
        tab,
        async () => {
          await pressKey(tab, locator, input.key, input.human);
          return `Pressed ${input.key}${label ? ` on ${label}` : ""}.`;
        },
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });

  defineTool(server, deps, {
    name: "dialog",
    title: "Answer dialog",
    description:
      "Answer the browser's own alert, confirm or prompt box a page opened; an HTML modal drawn by the page is closed with click or dismiss_overlays instead. accept presses OK (with text, it types that answer into a prompt; without it, the prompt's default is used) and dismiss presses Cancel. The call that made the page open one (a click, a key press, evaluate, a navigation, or a timer that fired during a call) says a dialog is open, with its type and message, and until it is answered the page is paused, so other calls on the tab fail with the same message instead of waiting. Read the message before accepting: a confirm can delete something or leave a checkout. The result says whether the page navigated and reports the next dialog when the page opens another. A page asking to confirm leaving with unsaved changes is not answered here: navigate and tabs (close) take force for that.",
    input: {
      tab: tabParam,
      action: z.enum(["accept", "dismiss"]).describe("accept presses OK, dismiss presses Cancel."),
      text: z
        .string()
        .optional()
        .describe("The answer to type into a prompt dialog, with accept. Only for prompt."),
    },
    runsWithDialog: true,
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAnswer(tab, () => answerDialog(tab, input.action === "accept", input.text));
    },
  });
}
