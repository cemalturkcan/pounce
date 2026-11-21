import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fillField, fillForm } from "../page/fill.ts";
import { runAction } from "../page/page.ts";
import {
  defineTool,
  includeDiffParam,
  includeSnapshotParam,
  NO_DOM_CHANGE,
  tabParam,
  targetParam,
  timeoutParam,
  type ToolDeps,
} from "./common.ts";

export function registerInputTools(server: McpServer, deps: ToolDeps) {
  const { manager, store } = deps;

  defineTool(server, deps, {
    name: "click",
    title: "Click",
    description:
      "Click an element. Waits for it to be visible, enabled and not covered, scrolls it into view, then clicks. The result says whether the page navigated, changed (in any frame), did not react, or could not be checked, and reports dialogs, downloads and new tabs triggered by the click, as well as a CAPTCHA or a sign-in page it led to. Use it for buttons, links, tabs, menu items and options; include_diff returns only the snapshot lines the click changed. When the click fails because another element intercepts it, a banner or modal is usually in the way, which dismiss_overlays clears. For many clicks in a row, such as pressing a button repeatedly or paging through results, run_script does them in one call.",
    input: {
      tab: tabParam,
      target: targetParam,
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
      'Set the value of one form control: types into text inputs and textareas, picks an option in a <select> by label or value, and checks or unchecks checkboxes and radios (text "true" or "false"). Replaces the existing value, and says when the page reformatted or rejected it. Rich-text editors (contenteditable, or an iframe whose body is editable) are filled with line breaks kept. A custom control that is not a text field (a role=combobox or listbox button, a read-only date or option picker) is clicked open and the visible option whose name matches text is picked; if none matches, the error lists the options or says to click, snapshot and click the option yourself.',
      "To enter a stored credential, pass secret, a name from secrets_list, instead of text: the server reads the value from the password store and types it without returning it. Passwords and other secret fields are then masked, also in JSON- and URL-encoded form and one-time codes for 2 minutes, in later tool results, in the text files the server writes (collect_pages files, overflow files, reports, script and job output), in page text sent to the ask_pages model and in the server log. They are not masked in usernames, raw exports (cookies export, network_export, storage export), downloads, binary files and screenshots.",
      "For several fields of one form, fill_form fills them in one call and reports invalid fields; for file inputs use upload.",
    ].join("\n"),
    input: {
      tab: tabParam,
      target: targetParam,
      text: z.string().optional().describe("Value to enter. Give either text or secret."),
      secret: z
        .string()
        .optional()
        .describe("Name of a password-store entry from secrets_list, used instead of text."),
      secret_field: z
        .string()
        .optional()
        .describe(
          "Which part of the secret to enter: password (default), username, otp for a current one-time code, or any other field name stored in the entry.",
        ),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter in the field afterwards. Default false."),
      slowly: z
        .boolean()
        .optional()
        .describe(
          "Type key by key instead of setting the value at once, for fields that react to individual keystrokes such as autocomplete. Default false.",
        ),
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
          const { locator, summary } = await fillField(deps, tab, input);
          if (input.submit) await locator.press("Enter");
          return summary;
        },
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: input.submit ? "No DOM change after pressing Enter." : "",
        },
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
            secret: z
              .string()
              .optional()
              .describe("Name of a password-store entry, used instead of text."),
            secret_field: z
              .string()
              .optional()
              .describe("password (default), username, otp, or another field of the entry."),
          }),
        )
        .min(1)
        .max(60)
        .describe("Fields to fill, in order."),
      submit: targetParam
        .optional()
        .describe(
          "Element to click after all fields are filled, usually the submit button (ref or selector).",
        ),
      include_snapshot: includeSnapshotParam,
      include_diff: includeDiffParam,
    },
    handler: async (input) => {
      const tab = manager.getTab(input.tab);
      return runAction(
        manager,
        store,
        tab,
        async () => fillForm(deps, tab, input.fields, input.submit),
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: input.submit ? "No DOM change after the submit click." : "",
        },
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
        {
          includeSnapshot: input.include_snapshot,
          includeDiff: input.include_diff,
          noChangeText: NO_DOM_CHANGE,
        },
      );
    },
  });
}
