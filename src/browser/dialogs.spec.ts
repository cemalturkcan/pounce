import { expect, test } from "bun:test";
import { answerDialog, dialogClosed, dialogLine, holdDialog } from "./dialogs.ts";
import type { PendingDialog, Tab } from "./tab.ts";

type DialogState = Pick<
  Tab,
  "dialog" | "dialogsOpened" | "dialogsClosed" | "dialogsHeld" | "dialogWatchers"
>;

function freshState(): DialogState {
  return {
    dialogsOpened: 0,
    dialogsClosed: 0,
    dialogsHeld: 0,
    dialogWatchers: new Set<(dialog: PendingDialog) => void>(),
  };
}

function pageDialog(type: string, message: string) {
  return {
    type: () => type,
    message: () => message,
    defaultValue: () => "",
    accept: async () => undefined,
    dismiss: async () => undefined,
  };
}

function opened(state: DialogState, type: string, message: string) {
  state.dialogsOpened += 1;
  holdDialog(state, pageDialog(type, message));
}

test("a held dialog is the tab's open dialog", () => {
  const state = freshState();
  opened(state, "confirm", "Delete?");
  expect(state.dialog?.message).toBe("Delete?");
});

test("a held dialog is passed to the calls watching the tab", () => {
  const state = freshState();
  const seen: string[] = [];
  state.dialogWatchers.add((dialog) => seen.push(dialog.message));
  opened(state, "alert", "Saved");
  expect(seen).toEqual(["Saved"]);
});

test("closing the open dialog clears it", () => {
  const state = freshState();
  opened(state, "alert", "Saved");
  dialogClosed(state);
  expect(state.dialog).toBeUndefined();
});

test("the late close of an earlier dialog keeps the next one open", () => {
  const state = freshState();
  opened(state, "alert", "First");
  opened(state, "alert", "Second");
  dialogClosed(state);
  expect(state.dialog?.message).toBe("Second");
});

test("a dialog already closed before it is reported is not held", () => {
  const state = freshState();
  dialogClosed(state);
  opened(state, "alert", "Gone");
  expect(state.dialog).toBeUndefined();
});

test("the dialog line names the type with its article and the message", () => {
  expect(
    dialogLine({ type: "alert", message: "Careful", defaultValue: "", dialog: pageDialog("", "") }),
  ).toMatch(/^An alert dialog is open: "Careful"\. /);
});

test("the dialog line tells how to answer it", () => {
  expect(
    dialogLine({ type: "prompt", message: "Name?", defaultValue: "", dialog: pageDialog("", "") }),
  ).toMatch(/call dialog with action accept or dismiss/);
});

test("answering a dialog the page already closed says it was closed", async () => {
  const tab: Pick<Tab, "id" | "dialog"> = {
    id: "t1",
    dialog: {
      type: "confirm",
      message: "Delete?",
      defaultValue: "",
      dialog: {
        accept: async () => {
          throw new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing");
        },
        dismiss: async () => undefined,
      },
    },
  };
  expect(await answerDialog(tab, true, undefined)).toBe(
    'The confirm dialog "Delete?" was already closed before the answer.',
  );
});
