import type { Locator } from "playwright-core";
import type { BrowserManager } from "../browser/manager.ts";
import type { Tab } from "../browser/tab.ts";
import { inSequence } from "../shared/async.ts";
import { describeError, ToolError } from "../shared/errors.ts";
import type { Redactor } from "../shared/output.ts";
import { registerSecret, type SecretField, type SecretStore } from "../shared/secrets.ts";

type FillDeps = { manager: BrowserManager; secrets: SecretStore; redactor: Redactor };

async function pickOption(
  locator: Locator,
  target: string,
  value: string,
  control: string,
  timeout?: number,
) {
  await locator.click({ timeout });
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
    await options.nth(match.index).click({ timeout });
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

type FieldInput = {
  target: string;
  text?: string;
  secret?: string;
  secret_field?: string;
  slowly?: boolean;
  timeout_ms?: number;
};

export async function fillField(deps: FillDeps, tab: Tab, field: FieldInput) {
  const { manager, secrets, redactor } = deps;
  if ((field.text === undefined) === (field.secret === undefined)) {
    throw new ToolError(`Give exactly one of text or secret for ${field.target}.`);
  }
  const locator = await manager.resolve(tab, field.target);
  const secretField: SecretField = field.secret_field ?? "password";
  const value =
    field.secret === undefined ? (field.text ?? "") : await secrets.get(field.secret, secretField);
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
  if (kind.tag === "input" && kind.type === "file") {
    throw new ToolError(`${field.target} is a file input.`, "Use upload with the file paths.");
  }
  if (kind.tag === "iframe" && field.secret === undefined) {
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
    if (field.slowly) {
      await body.click({ timeout: field.timeout_ms });
      await body.fill("", { timeout: field.timeout_ms });
      await body.pressSequentially(value, { delay: 45 });
    } else {
      await body.fill(value, { timeout: field.timeout_ms });
    }
    return {
      locator: body,
      summary: `Filled the editor in ${field.target} (${value.length} chars).`,
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
      summary: await pickOption(locator, field.target, value, control, field.timeout_ms),
    };
  }
  const choice = kind.tag === "select" || kind.type === "checkbox" || kind.type === "radio";
  if (kind.tag === "select") {
    await locator.selectOption(value, { timeout: field.timeout_ms });
  } else if (choice) {
    await locator.setChecked(/^(true|1|on|yes|checked)$/i.test(value), {
      timeout: field.timeout_ms,
    });
  } else if (field.slowly) {
    await locator.click({ timeout: field.timeout_ms });
    await locator.fill("", { timeout: field.timeout_ms });
    await locator.pressSequentially(value, { delay: 45 });
  } else {
    await locator.fill(value, { timeout: field.timeout_ms });
  }

  if (field.secret !== undefined)
    return {
      locator,
      summary: `Filled ${field.target} with secret ${field.secret} (${secretField}).`,
    };
  const current =
    choice || kind.editable ? undefined : await locator.inputValue().catch(() => undefined);
  const mismatch =
    current !== undefined && current !== value
      ? ` The field now reads ${JSON.stringify(current.slice(0, 80))}; the page reformatted or rejected the input.`
      : "";
  return { locator, summary: `Filled ${field.target} (${value.length} chars).${mismatch}` };
}

export async function fillForm(
  deps: FillDeps,
  tab: Tab,
  fields: FieldInput[],
  submit: string | undefined,
) {
  const { manager } = deps;
  const lines: string[] = [];
  const filled: {
    target: string;
    locator: Awaited<ReturnType<typeof fillField>>["locator"];
  }[] = [];
  await inSequence(fields, async (field) => {
    try {
      const result = await fillField(deps, tab, field);
      filled.push({ target: field.target, locator: result.locator });
      lines.push(result.summary);
    } catch (cause) {
      throw new ToolError(
        `Filled ${filled.length} of ${fields.length} fields, then ${field.target} failed: ${describeError(cause).split("\n")[0]}`,
        lines.length ? `Done before the failure:\n${lines.join("\n")}` : undefined,
      );
    }
  });
  await inSequence(filled, async (entry) => {
    const message = await entry.locator
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
  if (submit) {
    await (await manager.resolve(tab, submit)).click();
    lines.push(`Clicked ${submit}.`);
  }
  return lines.join("\n");
}
