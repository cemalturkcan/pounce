import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { repeatUntil } from "../src/shared/async.ts";
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab } = useToolsHarness("dialogs");

async function openDialogs() {
  return openedTab(await ok("navigate", { url: `${fixture().url}/dialogs` }));
}

const signUpFields = [
  { target: "#name", value: "Ada" },
  { target: "#email", value: "ada@example.com" },
  { target: "#city", value: "Paris" },
];

async function stateOf(tab: string) {
  return ok("read_page", { tab, target: "#state" });
}

describe("dialogs wait for the agent", () => {
  test("a click that opens a confirm reports the open dialog with its message", async () => {
    const tab = await openDialogs();
    expect(await ok("click", { tab, target: "#confirm" })).toMatch(
      /A confirm dialog is open: "Delete the draft\?"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("the dialog is not answered before the agent answers it", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#confirm" });
    await ok("dialog", { tab, action: "dismiss" });
    expect(await stateOf(tab)).toMatch(/kept/);
    await ok("tabs", { close: [tab] });
  });

  test("accept answers a confirm with yes", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#confirm" });
    await ok("dialog", { tab, action: "accept" });
    expect(await stateOf(tab)).toMatch(/deleted/);
    await ok("tabs", { close: [tab] });
  });

  test("accept with text answers a prompt with that text", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#prompt" });
    await ok("dialog", { tab, action: "accept", text: "Ada" });
    expect(await stateOf(tab)).toMatch(/name: Ada/);
    await ok("tabs", { close: [tab] });
  });

  test("accept without text answers a prompt with its default value", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#prompt" });
    await ok("dialog", { tab, action: "accept" });
    expect(await stateOf(tab)).toMatch(/name: guest/);
    await ok("tabs", { close: [tab] });
  });

  test("another call on the tab reports the open dialog instead of waiting", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#alert" });
    const blocked = await call("snapshot", { tab });
    expect(blocked.text).toMatch(/An alert dialog is open: "Careful now"[\s\S]*dialog/);
    await ok("tabs", { close: [tab] });
  });

  test("a call blocked by an open dialog is an error", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#alert" });
    expect((await call("read_page", { tab })).isError).toBe(true);
    await ok("tabs", { close: [tab] });
  });

  test("the result of answering says which dialog was answered", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#alert" });
    expect(await ok("dialog", { tab, action: "accept" })).toMatch(
      /Accepted the alert dialog "Careful now"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("answering one dialog reports the next one the page opens", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#chain" });
    expect(await ok("dialog", { tab, action: "accept" })).toMatch(
      /An alert dialog is open: "Second notice"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("answering one dialog that opens the next says which dialog it answered", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#chain" });
    expect(await ok("dialog", { tab, action: "accept" })).toMatch(
      /Done before the dialog:\nAccepted the alert dialog "First notice"\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a dialog that opens shortly after the action is reported by it", async () => {
    const tab = await openDialogs();
    expect(await ok("click", { tab, target: "#later" })).toMatch(
      /An alert dialog is open: "Saved later"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a click that opens a dialog names the element it clicked", async () => {
    const tab = await openDialogs();
    expect(await ok("click", { tab, target: "#confirm" })).toMatch(
      /It opened after the click on button "Confirm" \(e\d+, from #confirm\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a click whose dialog opens shortly after names the element it clicked", async () => {
    const tab = await openDialogs();
    expect(await ok("click", { tab, target: "#later" })).toMatch(
      /It opened after the click on button "Later" \(e\d+, from #later\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a hover that opens a dialog names the element it hovered", async () => {
    const tab = await openDialogs();
    expect(await ok("hover", { tab, target: "#hover-alert" })).toMatch(
      /It opened after hovering button "Hover alert" \(e\d+, from #hover-alert\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a key press that opens a dialog names the key and the element", async () => {
    const tab = await openDialogs();
    expect(await ok("press", { tab, target: "#key-alert", key: "a" })).toMatch(
      /It opened after pressing a on textbox "Key alert" \(e\d+, from #key-alert\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a fill that opens a dialog names the field it filled", async () => {
    const tab = await openDialogs();
    expect(await ok("fill", { tab, target: "#input-alert", value: "x" })).toMatch(
      /It opened after filling textbox "Input alert" \(e\d+, from #input-alert\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a fill of a select that opens a dialog names the select", async () => {
    const tab = await openDialogs();
    expect(await ok("fill", { tab, target: "#select-alert", value: "Two" })).toMatch(
      /It opened after selecting Two in combobox "Select alert" \(e\d+, from #select-alert\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a fill whose field opens a dialog names that field", async () => {
    const tab = await openDialogs();
    expect(await ok("fill", { tab, fields: [{ target: "#input-alert", value: "x" }] })).toMatch(
      /It opened after filling textbox "Input alert" \(e\d+, from #input-alert\)\./,
    );
    await ok("tabs", { close: [tab] });
  });

  test("a fill whose submit click opens a dialog names the submit element", async () => {
    const tab = await openDialogs();
    expect(
      await ok("fill", {
        tab,
        fields: [{ target: "#plain-field", value: "x" }],
        submit: "#submit-alert",
      }),
    ).toMatch(/It opened after the click on button "Submit alert" \(e\d+, from #submit-alert\)\./);
    await ok("tabs", { close: [tab] });
  });

  test("evaluate that opens a dialog reports it instead of hanging", async () => {
    const tab = await openDialogs();
    expect(await ok("evaluate", { tab, expression: "confirm('From script?')" })).toMatch(
      /A confirm dialog is open: "From script\?"/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("dialog fails when the tab has no open dialog", async () => {
    const tab = await openDialogs();
    expect(await call("dialog", { tab, action: "accept" })).toMatchObject({
      isError: true,
      text: expect.stringMatching(/no open dialog/),
    });
    await ok("tabs", { close: [tab] });
  });

  test("text on a dialog that is not a prompt is refused", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#confirm" });
    expect((await call("dialog", { tab, action: "accept", text: "yes" })).text).toMatch(
      /only a prompt/,
    );
    await ok("tabs", { close: [tab] });
  });

  test("tabs closes a tab whose dialog is open", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#alert" });
    await ok("tabs", { close: [tab] });
    expect(await ok("tabs")).not.toMatch(new RegExp(`\\b${tab}\\b`));
  });

  test("tabs shows a tab whose dialog is open", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#confirm" });
    expect(await ok("tabs")).toMatch(/confirm dialog open/);
    await ok("tabs", { close: [tab] });
  });

  test("tabs' structured tabs carry every fact of each tab line, a dialog included", async () => {
    const tab = await openDialogs();
    await ok("click", { tab, target: "#confirm" });
    const listed = await call("tabs");
    await ok("tabs", { close: [tab] });
    const entries = z
      .array(
        z.object({
          id: z.string(),
          ownership: z.string(),
          url: z.string(),
          title: z.string().optional(),
          dialog: z.string().optional(),
          unresponsive: z.boolean().optional(),
        }),
      )
      .parse(listed.structured?.tabs);
    const rebuilt = entries.map(
      (entry) =>
        `${entry.id} [${entry.ownership}] ${entry.url} ${entry.dialog ? `(${entry.dialog})` : entry.unresponsive ? "(unresponsive)" : JSON.stringify(entry.title)}`,
    );
    expect(rebuilt).toStrictEqual(listed.text.split("\nTabs:\n")[1]?.split("\n") ?? []);
  });

  test("navigate on a page that opens an alert while loading reports it", async () => {
    const opened = await ok("navigate", { url: `${fixture().url}/dialogs/on-load` });
    expect(opened).toMatch(/An alert dialog is open: "Welcome back"/);
    await ok("tabs", { close: [openedTab(opened)] });
  });

  test("fill stopped by an alert says which fields it filled before the dialog", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/dialogs/form` }));
    const result = await ok("fill", { tab, fields: signUpFields, submit: "#send" });
    expect(result).toMatch(/Done before the dialog:\nFilled .*#name.* with 3 chars\./);
    await ok("tabs", { close: [tab] });
  });

  test("fill stopped by an alert does not submit after the alert is accepted", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/dialogs/form` }));
    await ok("fill", { tab, fields: signUpFields, submit: "#send" });
    await ok("dialog", { tab, action: "accept" });
    await Bun.sleep(1000);
    expect(await ok("read_page", { tab, target: "#submits" })).toMatch(/0 submits/);
    await ok("tabs", { close: [tab] });
  });

  test("fill stopped by an alert fills no further field after the alert is accepted", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/dialogs/form` }));
    await ok("fill", { tab, fields: signUpFields, submit: "#send" });
    await ok("dialog", { tab, action: "accept" });
    await Bun.sleep(1000);
    expect(
      await ok("evaluate", { tab, expression: "document.getElementById('city').value" }),
    ).not.toMatch(/Paris/);
    await ok("tabs", { close: [tab] });
  });

  test("a screenshot interrupted by an alert reports the open dialog", async () => {
    const tab = await openDialogs();
    await ok("evaluate", {
      tab,
      expression:
        "setTimeout(() => { const until = Date.now() + 1500; while (Date.now() < until); alert('Shot'); }, 100)",
    });
    await Bun.sleep(300);
    const result = await call("screenshot", { tab, full_page: true });
    expect(result.text).toMatch(/An alert dialog is open: "Shot"/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script whose own listener answers a confirm returns its value", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'page.on("dialog", (dialog) => dialog.dismiss()); await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: kept/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script without a dialog listener has a confirm accepted for it", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: deleted/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script without a dialog listener logs which dialog was accepted for it", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'await page.click("#prompt"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/Logs:\n.*prompt dialog "Your name\?" was accepted with "guest"/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script has a confirm on a tab it opened accepted for it", async () => {
    const result = await call("run_script", {
      code: `const opened = await openTab(${JSON.stringify(`${fixture().url}/dialogs`)}); await opened.click("#confirm"); return await opened.textContent("#state");`,
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: deleted/);
  });

  test("a background job whose page opens a confirm finishes", async () => {
    const started = await ok("run_script", {
      code: `const opened = await openTab(${JSON.stringify(`${fixture().url}/dialogs`)}); await opened.click("#confirm"); return await opened.textContent("#state");`,
      background: true,
    });
    const id = /background job (j\d+)/.exec(started)?.[1] ?? "";
    const deadline = Date.now() + 10_000;
    const finished = await repeatUntil(
      async () => {
        const status = await ok("run_script", { job: id });
        return / running /.test(status) ? undefined : status;
      },
      { delayMs: () => 200, giveUp: () => Date.now() >= deadline },
    );
    expect(finished).toMatch(new RegExp(`^${id} done `));
  });

  test("run_script that times out with a dialog its listener left open names the dialog", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'page.on("dialog", () => undefined); await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 2000,
    });
    expect(result.text).toMatch(/confirm dialog open: "Delete the draft\?"/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script waiting for a dialog on its page answers the prompt itself", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'const waiting = page.waitForEvent("dialog"); const clicking = page.click("#prompt"); const dialog = await waiting; await dialog.accept("Ada"); await clicking; return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: name: Ada/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script waiting for a dialog on its context answers the prompt itself", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'const waiting = context.waitForEvent("dialog"); const clicking = page.click("#prompt"); const dialog = await waiting; await dialog.accept("Ada"); await clicking; return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: name: Ada/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script whose context once listener answers a confirm returns its value", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'context.once("dialog", (dialog) => dialog.dismiss()); await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: kept/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script has the next confirm accepted for it after its once listener answered one", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'page.once("dialog", (dialog) => dialog.dismiss()); await page.click("#confirm"); await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: deleted/);
    await ok("tabs", { close: [tab] });
  });

  test("run_script listening for dialogs on another tab has a confirm on its own tab accepted for it", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: `const other = await openTab(${JSON.stringify(`${fixture().url}/dialogs`)}); other.on("dialog", (dialog) => dialog.dismiss()); await page.click("#confirm"); return await page.textContent("#state");`,
      timeout_ms: 8000,
    });
    expect(result.text).toMatch(/^Returned: deleted/);
    await ok("tabs", { close: [tab] });
  });

  test("a click from the agent on a tab a background script drives reports the confirm it opens", async () => {
    const tab = await openDialogs();
    const started = await ok("run_script", { tab, code: "await sleep(8000);", background: true });
    const id = /background job (j\d+)/.exec(started)?.[1] ?? "";
    expect(await ok("click", { tab, target: "#confirm" })).toMatch(
      /A confirm dialog is open: "Delete the draft\?"/,
    );
    await ok("dialog", { tab, action: "dismiss" });
    await ok("run_script", { job: id, cancel: true });
    await ok("tabs", { close: [tab] });
  });

  test("a confirm a background script's auto-accept answers after the agent's click shows in the tab's next result", async () => {
    const tab = await openDialogs();
    const started = await ok("run_script", { tab, code: "await sleep(8000);", background: true });
    const id = /background job (j\d+)/.exec(started)?.[1] ?? "";
    await ok("click", { tab, target: "#later-confirm" });
    await Bun.sleep(2500);
    expect(await ok("hover", { tab, target: "#state" })).toMatch(
      /event.*: confirm dialog "Delete the draft\?" was accepted/,
    );
    await ok("run_script", { job: id, cancel: true });
    await ok("tabs", { close: [tab] });
  });

  test("run_script reports a confirm it auto-accepted once", async () => {
    const tab = await openDialogs();
    const result = await call("run_script", {
      tab,
      code: 'await page.click("#confirm"); return await page.textContent("#state");',
      timeout_ms: 8000,
    });
    expect(result.text.match(/was accepted/g)).toHaveLength(1);
    await ok("tabs", { close: [tab] });
  });

  test("run_script leaves a confirm on another session's tab to that session", async () => {
    const other = await mcp.deps.manager.openTab("other-session");
    await other.page.goto(`${fixture().url}/dialogs`);
    const result = await call("run_script", {
      code: `const theirs = tab(${JSON.stringify(other.id)}); await theirs.click("#confirm"); return await theirs.textContent("#state");`,
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(/confirm dialog open: "Delete the draft\?"/);
    await mcp.deps.manager.closeTab(other.id);
  });

  test("run_script leaves a confirm on a user tab it reaches to the user", async () => {
    const context = await mcp.deps.manager.ensureContext();
    const page = await context.newPage();
    await page.goto(`${fixture().url}/dialogs`);
    const id = mcp.deps.manager.tabOf(page)?.id ?? "";
    const result = await call("run_script", {
      code: `const user = tab(${JSON.stringify(id)}); await user.click("#confirm"); return await user.textContent("#state");`,
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(/confirm dialog open: "Delete the draft\?"/);
    await page.close();
  });

  test("save_pages saves a page that opens an alert while loading", async () => {
    const index = await ok("save_pages", { urls: [`${fixture().url}/dialogs/on-load`] });
    expect(index).toMatch(/Collected 1 of 1 pages/);
  });
});

describe("a dialog that opens while a call waits for the tab to draw", () => {
  for (const delay of [0, 5, 10])
    test(`an alert ${delay} ms after the previous call is reported as an open dialog`, async () => {
      const tab = await openDialogs();
      await ok("evaluate", { tab, expression: `setTimeout(() => alert("soon"), ${delay}); 1` });
      const read = await call("read_page", { tab });
      await call("dialog", { tab, action: "accept" });
      await ok("tabs", { close: [tab] });
      expect(read.text).toMatch(/An alert dialog is open: "soon"/);
    });
});

describe("a dialog that wins the race against the draw wait", () => {
  test("leaves no warning that the tab did not draw", async () => {
    const tab = await mcp.deps.manager.openTab("stdio");
    await tab.page.goto(`${fixture().url}/dialogs`);
    await tab.page.evaluate(() => {
      setTimeout(() => alert("early"), 0);
    });
    await call("read_page", { tab: tab.id });
    await Bun.sleep(1200);
    await call("dialog", { tab: tab.id, action: "accept" });
    await ok("tabs", { close: [tab.id] });
    expect(
      await ok("logs", { source: "server", level: "warn", contains: `"tab":"${tab.id}","ms"` }),
    ).toMatch(/No matching entries\./);
  });
});
