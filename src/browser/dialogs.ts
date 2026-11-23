import type { Dialog } from "playwright-core";
import { messageOf, ToolError } from "../shared/errors.ts";
import { type PendingDialog, pushEvent, type ScriptWatch, type Tab } from "./tab.ts";

const MESSAGE_CHARS = 300;

export const DIALOG_TOOK_OVER =
  "A dialog opened during the action, and its result already reported it.";

const quoted = (dialog: Pick<PendingDialog, "message">) =>
  JSON.stringify(dialog.message.slice(0, MESSAGE_CHARS));

const article = (type: string) => (/^[aeiou]/.test(type) ? "an" : "a");

function named(dialog: Pick<PendingDialog, "type">) {
  const word = article(dialog.type);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${dialog.type} dialog`;
}

const ANSWER_HINT = "call dialog with action accept or dismiss (accept with text answers a prompt)";

export function dialogLine(dialog: PendingDialog) {
  return `${named(dialog)} is open: ${quoted(dialog)}. The page waits for an answer: ${ANSWER_HINT}.`;
}

export function dialogBlocked(tab: Tab, dialog: PendingDialog, tool: string) {
  return new ToolError(
    `${named(dialog)} is open: ${quoted(dialog)}. The page waits for an answer, so ${tool} cannot run on ${tab.id} until then.`,
    `To go on, ${ANSWER_HINT}, or close the tab with tabs (close).`,
  );
}

export function dialogStatus(dialog: PendingDialog) {
  return `${dialog.type} dialog open: ${quoted(dialog)}`;
}

type DialogState = Pick<
  Tab,
  "dialog" | "dialogsOpened" | "dialogsClosed" | "dialogsHeld" | "dialogWatchers"
>;

export function holdDialog(
  tab: DialogState,
  dialog: Pick<Dialog, "type" | "message" | "defaultValue" | "accept" | "dismiss">,
) {
  if (tab.dialogsClosed >= tab.dialogsOpened) return;
  const pending: PendingDialog = {
    type: dialog.type(),
    message: dialog.message(),
    defaultValue: dialog.defaultValue(),
    dialog,
  };
  tab.dialog = pending;
  tab.dialogsHeld += 1;
  for (const watcher of tab.dialogWatchers) watcher(pending);
}

export function dialogClosed(tab: DialogState) {
  tab.dialogsClosed += 1;
  if (tab.dialogsClosed >= tab.dialogsOpened) tab.dialog = undefined;
}

export function answerLookOnly(tab: Tab, dialog: Dialog, reason: string) {
  const confirming = dialog.type() === "confirm" || dialog.type() === "prompt";
  pushEvent(
    tab,
    `${dialog.type()} dialog ${quoted({ message: dialog.message() })} was ${confirming ? "dismissed" : "accepted"}, because ${reason}`,
  );
  void (confirming ? dialog.dismiss() : dialog.accept()).catch(() => undefined);
}

export function answerForScript(tab: Tab, dialog: Dialog, scripts: ScriptWatch[]) {
  const prompt = dialog.type() === "prompt";
  const answer = prompt ? ` with ${JSON.stringify(dialog.defaultValue())}` : "";
  const line = `${dialog.type()} dialog ${quoted({ message: dialog.message() })} was accepted${answer}, because the script has no dialog listener on ${tab.id}`;
  for (const script of scripts) script.log(line);
  pushEvent(tab, line);
  void dialog.accept(prompt ? dialog.defaultValue() : undefined).catch(() => undefined);
}

export async function raceDialog<T>(
  tab: Tab,
  work: Promise<T>,
  onDialog: (dialog: PendingDialog) => T,
): Promise<T> {
  let watcher: ((dialog: PendingDialog) => void) | undefined;
  const opened = new Promise<T>((resolve) => {
    watcher = (dialog) => resolve(onDialog(dialog));
    tab.dialogWatchers.add(watcher);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, opened]);
  } finally {
    if (watcher) tab.dialogWatchers.delete(watcher);
  }
}

const ALREADY_CLOSED = /no dialog is showing|already handled/i;

export async function answerDialog(
  tab: Pick<Tab, "id" | "dialog">,
  accept: boolean,
  text: string | undefined,
) {
  const pending = tab.dialog;
  if (!pending)
    throw new ToolError(
      `Tab ${tab.id} has no open dialog.`,
      "A dialog shows up in the result of the call that opened it; this tab has none waiting.",
    );
  if (text !== undefined && pending.type !== "prompt")
    throw new ToolError(
      `text answers only a prompt dialog, and the open one is ${article(pending.type)} ${pending.type} dialog.`,
      "Call dialog again without text.",
    );
  tab.dialog = undefined;
  try {
    if (accept)
      await pending.dialog.accept(
        pending.type === "prompt" ? (text ?? pending.defaultValue) : undefined,
      );
    else await pending.dialog.dismiss();
  } catch (cause) {
    if (!ALREADY_CLOSED.test(messageOf(cause))) throw cause;
    return `The ${pending.type} dialog ${quoted(pending)} was already closed before the answer.`;
  }
  return `${accept ? "Accepted" : "Dismissed"} the ${pending.type} dialog ${quoted(pending)}${
    accept && pending.type === "prompt"
      ? ` with ${JSON.stringify(text ?? pending.defaultValue)}`
      : ""
  }.`;
}
