import { expect, test } from "bun:test";
import { type CallScope, checkpoint, inCallScope, recordAction, recordStep } from "./call-scope.ts";

test("checkpoint throws the reason the call was stopped with", async () => {
  const stop = new AbortController();
  const work = inCallScope({ signal: stop.signal, steps: [] }, async () => {
    await Bun.sleep(1);
    checkpoint();
  });
  stop.abort(new Error("taken over"));
  expect(work).rejects.toThrow("taken over");
});

test("recordStep adds to the steps of the call it runs in", async () => {
  const steps: string[] = [];
  await inCallScope({ signal: new AbortController().signal, steps }, async () => {
    await Bun.sleep(1);
    recordStep("Filled the name.");
  });
  expect(steps).toEqual(["Filled the name."]);
});

test("recordAction keeps the action the call is carrying out", async () => {
  const call: CallScope = { signal: new AbortController().signal, steps: [] };
  await inCallScope(call, async () => {
    await Bun.sleep(1);
    recordAction('the click on button "Save"');
  });
  expect(call.acting).toBe('the click on button "Save"');
});
