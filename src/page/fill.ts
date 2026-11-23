import { stat } from "node:fs/promises";
import type { Locator } from "playwright-core";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tab.ts";
import { inSequence } from "../shared/async.ts";
import { checkpoint, recordAction, recordStep } from "../shared/call-scope.ts";
import { describeError, ToolError } from "../shared/errors.ts";
import type { Redactor } from "../shared/output.ts";
import { registerSecret, type SecretField, type SecretStore } from "../shared/secrets.ts";
import {
  explainIntercept,
  humanClick,
  humanHover,
  humanReplaceText,
  mayClosePage,
  plainClick,
} from "./human.ts";
import { targetName } from "./page.ts";

type FillDeps = { manager: BrowserManager; secrets: SecretStore; redactor: Redactor };

export function clicker(tab: Tab, human: boolean | undefined) {
  return (locator: Locator, timeout?: number) =>
    human ? humanClick(tab, locator, { timeout }) : plainClick(tab, locator, { timeout });
}

async function pickOption(
  click: ReturnType<typeof clicker>,
  locator: Locator,
  target: string,
  value: string,
  control: string,
  timeout?: number,
) {
  await click(locator, timeout);
  const handle = await locator.elementHandle({ timeout });
  const frame = (await handle?.ownerFrame()) ?? null;
  await handle?.dispose();
  const options = (frame ?? locator.page().mainFrame()).getByRole("option");
  await options
    .first()
    .waitFor({ state: "visible", timeout: 2000 })
    .catch(() => undefined);
  const names = await options.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        name: (element.getAttribute("aria-label") || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        visible: box.width > 0 && box.height > 0,
      };
    }),
  );
  const wanted = value.trim().toLowerCase();
  const visible = names.flatMap((entry, index) =>
    entry.visible ? [{ name: entry.name, index }] : [],
  );
  const match =
    visible.find((entry) => entry.name.toLowerCase() === wanted) ??
    visible.find((entry) => entry.name.toLowerCase().includes(wanted));
  if (match) {
    await click(options.nth(match.index), timeout);
    return `Picked option ${JSON.stringify(match.name)} in ${target} (a ${control}, opened with a click).`;
  }
  await locator
    .page()
    .keyboard.press("Escape")
    .catch(() => undefined);
  if (visible.length) {
    throw new ToolError(
      `${target} is a ${control} with no option named ${JSON.stringify(value)}. Options: ${visible
        .slice(0, 40)
        .map((entry) => entry.name)
        .join(", ")}.`,
      "Fill again with one of these names, or type into the control's search box if it has one.",
    );
  }
  throw new ToolError(
    `${target} is a ${control}, not a text field, and showed no option named ${JSON.stringify(value)} after a click.`,
    "Click the control, take a snapshot, then click the option (or the date in the calendar) by its ref.",
  );
}

export type FieldInput = {
  target: string;
  value?: string;
  secret?: string;
  secret_field?: string;
  slowly?: boolean;
  human?: boolean;
  timeout_ms?: number;
};

export async function fillField(deps: FillDeps, tab: Tab, field: FieldInput) {
  const { manager, secrets, redactor } = deps;
  const locator = await manager.resolve(tab, field.target);
  const label = await targetName(tab, locator, field.target);
  const secretField: SecretField = field.secret_field ?? "password";
  const value =
    field.secret === undefined ? (field.value ?? "") : await secrets.get(field.secret, secretField);
  if (field.secret !== undefined) registerSecret(redactor, field.secret, secretField, value);

  const kind = await locator.evaluate(
    (element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") ?? "").toLowerCase(),
      editable: element instanceof HTMLElement && element.isContentEditable,
      readOnly: "readOnly" in element && element.readOnly === true,
      role: element.getAttribute("role") ?? "",
    }),
    undefined,
    { timeout: field.timeout_ms },
  );
  const shown = field.secret === undefined ? value : `secret ${field.secret}`;
  recordAction(kind.tag === "select" ? `selecting ${shown} in ${label}` : `filling ${label}`);
  if (kind.tag === "input" && kind.type === "file") {
    throw new ToolError(
      `${field.target} is a file input.`,
      "Fill it with files and the file paths instead of value.",
    );
  }
  if (kind.tag === "iframe" && field.secret === undefined) {
    await manager.checkInside(tab, field.target);
    const body = locator.contentFrame().locator("body");
    if (
      !(await body.evaluate(
        (element) =>
          (element instanceof HTMLElement && element.isContentEditable) ||
          element.ownerDocument.designMode === "on",
        undefined,
        { timeout: field.timeout_ms },
      ))
    ) {
      throw new ToolError(
        `${field.target} is an iframe without an editable body.`,
        "Take a snapshot and target the field inside the frame by its ref.",
      );
    }
    if (field.human) {
      await humanReplaceText(tab, body, value, field.timeout_ms);
    } else if (field.slowly) {
      await plainClick(tab, body, { timeout: field.timeout_ms });
      await body.fill("", { timeout: field.timeout_ms });
      await mayClosePage(tab.page, () => body.pressSequentially(value, { delay: 45 }));
    } else {
      await body.fill(value, { timeout: field.timeout_ms });
    }
    return {
      locator: body,
      label,
      summary: `Filled the editor in ${label} with ${value.length} chars.`,
    };
  }
  const native =
    kind.editable ||
    ((kind.tag === "input" || kind.tag === "textarea") && !kind.readOnly) ||
    kind.tag === "select";
  if (!native && field.secret === undefined) {
    const control =
      kind.tag === "input"
        ? "read-only input (probably a date or option picker)"
        : `custom ${kind.role || kind.tag} control`;
    return {
      locator,
      label,
      summary: await pickOption(
        clicker(tab, field.human),
        locator,
        label,
        value,
        control,
        field.timeout_ms,
      ),
    };
  }
  const choice = kind.tag === "select" || kind.type === "checkbox" || kind.type === "radio";
  const checked = /^(true|1|on|yes|checked)$/i.test(value);
  if (kind.tag === "select") {
    if (field.human) await humanHover(tab, locator, field.timeout_ms);
    await locator.selectOption(value, { timeout: field.timeout_ms });
  } else if (choice && field.human) {
    if ((await locator.isChecked({ timeout: field.timeout_ms })) !== checked)
      await humanClick(tab, locator, { timeout: field.timeout_ms });
  } else if (choice) {
    await mayClosePage(tab.page, () =>
      locator.setChecked(checked, { timeout: field.timeout_ms }).catch(async (cause: unknown) => {
        throw await explainIntercept(locator, cause);
      }),
    );
  } else if (field.human) {
    await humanReplaceText(tab, locator, value, field.timeout_ms);
  } else if (field.slowly) {
    await plainClick(tab, locator, { timeout: field.timeout_ms });
    await locator.fill("", { timeout: field.timeout_ms });
    await mayClosePage(tab.page, () => locator.pressSequentially(value, { delay: 45 }));
  } else {
    await locator.fill(value, { timeout: field.timeout_ms });
  }

  if (field.secret !== undefined)
    return {
      locator,
      label,
      summary: `Filled ${label} with secret ${field.secret} (${secretField}).`,
    };
  const current =
    choice || kind.editable ? undefined : await locator.inputValue().catch(() => undefined);
  const mismatch =
    current !== undefined && current !== value
      ? ` The field now reads ${JSON.stringify(current.slice(0, 80))}; the page reformatted or rejected the input.`
      : "";
  return { locator, label, summary: `Filled ${label} with ${value.length} chars.${mismatch}` };
}

export async function fillForm(deps: FillDeps, tab: Tab, fields: FieldInput[], human?: boolean) {
  const lines: string[] = [];
  const filled: { target: string; result: Awaited<ReturnType<typeof fillField>> }[] = [];
  await inSequence(fields, async (field) => {
    checkpoint();
    try {
      const result = await fillField(deps, tab, { ...field, human });
      filled.push({ target: field.target, result });
      lines.push(result.summary);
      recordStep(result.summary);
    } catch (cause) {
      throw new ToolError(
        `Filled ${filled.length} of ${fields.length} fields, then ${field.target} failed: ${describeError(cause).split("\n")[0]}`,
        lines.length ? `Done before the failure:\n${lines.join("\n")}` : undefined,
      );
    }
  });
  await inSequence(filled, async (entry) => {
    const message = await entry.result.locator
      .evaluate((element) => {
        const control =
          element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement
            ? element
            : undefined;
        return control && !control.validity.valid ? control.validationMessage || "invalid" : "";
      })
      .catch(() => "");
    if (message) lines.push(`Invalid: ${entry.target} — ${message}`);
  });
  return { summary: lines.join("\n"), last: filled.at(-1)?.result };
}

export async function checkFiles(files: string[]) {
  const infos = await Promise.all(files.map((file) => stat(file).catch(() => undefined)));
  const missingIndex = infos.findIndex((info) => !info?.isFile());
  if (missingIndex !== -1) throw new ToolError(`No file at ${files[missingIndex]}.`);
}

export async function attachFiles(tab: Tab, locator: Locator, files: string[]) {
  const isFileInput = await locator.evaluate(
    (element) => element instanceof HTMLInputElement && element.type === "file",
  );
  if (isFileInput) {
    await locator.setInputFiles(files);
    return;
  }
  const [chooser] = await Promise.all([
    tab.page.waitForEvent("filechooser"),
    plainClick(tab, locator),
  ]);
  await chooser.setFiles(files);
}
