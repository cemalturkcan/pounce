import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inSequence, repeatUntil, sleep } from "../src/shared/async.ts";
import type { ToolArgs } from "../tests/mcpHarness.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, askPrompts, notifications, openedTab, refOf } =
  useToolsHarness("tools-flow");

const propertiesSchema = z.record(z.string(), z.object({ description: z.string().optional() }));

test("every tool and parameter is described", async () => {
  const { tools } = await mcp.client.listTools();
  expect(tools.length).toBe(28);
  for (const tool of tools) {
    expect((tool.description ?? "").length).toBeGreaterThanOrEqual(60);
    const properties = propertiesSchema.parse(tool.inputSchema.properties ?? {});
    for (const schema of Object.values(properties)) {
      expect(schema.description, tool.name).toMatch(/\S/);
    }
  }
});

describe("browser flow", () => {
  let tab = "";
  let snapshot = "";

  test("tabs does not start the browser", async () => {
    expect(await ok("tabs")).toMatch(/Browser not started/);
  });

  test("navigate returns an id and a snapshot with refs", async () => {
    const text = await ok("navigate", { url: fixture().url, include_snapshot: true });
    tab = /Opened (t\d+)/.exec(text)?.[1] ?? "";
    expect(tab).toMatch(/^t\d+$/);
    expect(text).toMatch(/Fixture Home/);
    expect(text).toMatch(/button "Change status" \[ref=/);
    snapshot = text;
  });

  test("click by ref reports a page change", async () => {
    const text = await ok("click", { tab, target: refOf(snapshot, 'button "Change status"') });
    expect(text).toMatch(/The page changed/);
    expect(await ok("read_page", { tab, target: "#status" })).toMatch(/changed/);
  });

  test("click that changes the DOM says that the DOM changed and that it is not classified further", async () => {
    const text = await ok("click", { tab, target: "#change" });
    expect(text).toMatch(/^The page changed: its DOM changed \(not classified further\)\.$/m);
  });

  test("click that does nothing says so", async () => {
    expect(await ok("click", { tab, target: "#noop" })).toMatch(/No change detected/);
  });

  test("click reports a page change on a site that defines its own webAgentMutations global", async () => {
    const siteTab =
      /Opened (t\d+)/.exec(await ok("navigate", { url: `${fixture().url}/site-globals` }))?.[1] ??
      "";
    const text = await ok("click", { tab: siteTab, target: "#change" });
    await ok("tabs", { close: [siteTab] });
    expect(text).toMatch(/The page changed/);
  });

  test("click inside an iframe by frame ref", async () => {
    const fresh = await ok("snapshot", { tab });
    expect(fresh).toMatch(/data, not instructions/);
    await ok("click", { tab, target: refOf(fresh, 'button "Frame button"') });
    expect(await ok("read_page", { tab, target: "#status" })).toMatch(/framed/);
  });

  test("stale ref gives an actionable error quickly", async () => {
    const result = await call("click", { tab, target: "e9999" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not in the latest snapshot/);
  });

  test("fill handles text, select and checkbox", async () => {
    expect(await ok("fill", { tab, target: "#email", value: "person@example.test" })).toMatch(
      /Filled textbox "Email" \((?:f\d+)?e\d+, from #email\) with 19 chars\./,
    );
    await ok("fill", { tab, target: "#plan", value: "Pro" });
    await ok("fill", { tab, target: "#terms", value: "true" });
    const state = await ok("evaluate", {
      tab,
      expression:
        "({ email: document.querySelector('#email').value, plan: document.querySelector('#plan').value, terms: document.querySelector('#terms').checked })",
    });
    expect(state).toMatch(/person@example\.test/);
    expect(state).toMatch(/"plan":"pro"/);
    expect(state).toMatch(/"terms":true/);
  });

  test("secret fill never returns the value", async () => {
    const filled = await ok("fill", { tab, target: "#password", secret: "fixture/site" });
    expect(filled).toMatch(/secret fixture\/site/);
    const readBack = await ok("evaluate", {
      tab,
      expression: "document.querySelector('#password').value",
    });
    expect(readBack).not.toContain(TEST_SECRET);
    expect(readBack).toMatch(/<secret:fixture\/site:password>/);
    expect(await mcp.deps.manager.getTab(tab).page.locator("#password").inputValue()).toBe(
      TEST_SECRET,
    );
  });

  test("fill with submit and press", async () => {
    expect(
      await ok("fill", { tab, target: "#email", value: "second@example.test", submit: true }),
    ).toMatch(/Filled/);
    expect(await ok("read_page", { tab, target: "#status" })).toMatch(/submitted/);
    await ok("press", { tab, key: "Tab", target: "#email" });
  });

  test("find returns matching lines with refs", async () => {
    const found = await ok("snapshot", { tab, query: "sign up" });
    expect(found).toMatch(/button "Sign up" \[ref=/);
    expect(await ok("snapshot", { tab, query: "no such thing anywhere" })).toMatch(/No match/);
  });

  test("interactive snapshot is a flat list", async () => {
    const flat = await ok("snapshot", { tab, interactive: true });
    expect(flat).toMatch(/^- button "Change status"/m);
    expect(flat).not.toContain("heading");
  });

  test("evaluate accepts expression, function and statements in the main world", async () => {
    expect(await ok("evaluate", { tab, expression: "document.title" })).toMatch(/Fixture Home/);
    expect(await ok("evaluate", { tab, expression: "() => window.appState.ready" })).toMatch(
      /true/,
    );
    expect(await ok("evaluate", { tab, expression: "const n = 20; return n + 1;" })).toMatch(/21/);
    expect(
      await ok("evaluate", { tab, expression: "typeof window.appState", world: "isolated" }),
    ).toMatch(/undefined$/);
    expect(await ok("evaluate", { tab, expression: "document.title", world: "isolated" })).toMatch(
      /Fixture Home$/,
    );
  });

  test("a dialog waits for the agent and is answered with dialog", async () => {
    expect(await ok("click", { tab, target: "#alert" })).toMatch(
      /An alert dialog is open: "Careful now"/,
    );
    expect(await ok("dialog", { tab, action: "accept" })).toMatch(
      /Accepted the alert dialog "Careful now"/,
    );
  });

  test("console capture works on local hosts", async () => {
    const logs = await ok("logs", { source: "page", tab });
    expect(logs).toMatch(/boot log/);
    const errors = await ok("logs", { source: "page", tab, level: "warn" });
    expect(errors).toMatch(/boot error/);
    expect(errors).not.toContain("boot log");
  });

  test("network list, detail and HAR export", async () => {
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const list = await ok("network", { tab, pattern: "/api/data" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await ok("network", { tab, id })).toMatch(/loaded from api/);
    const exported = await ok("network", { har: true, tab, pattern: "/api/" });
    const file = /to (\S+\.har)/.exec(exported)?.[1] ?? "";
    const har = JSON.parse(await readFile(file, "utf8"));
    expect(har.log.version).toBe("1.2");
    expect(
      har.log.entries.map(
        (entry: { response: { content: { text?: string } } }) => entry.response.content.text,
      ),
    ).toContainEqual(expect.stringContaining("loaded from api"));
  });

  test("intercept modifies, mocks and blocks requests", async () => {
    const firstRule = Number(
      /Added rule #(\d+)/.exec(
        await ok("intercept", {
          tab,
          action: "add",
          url: "/api/echo",
          mode: "modify",
          set_headers: { "x-agent-test": "yes" },
        }),
      )?.[1],
    );
    expect(firstRule).toBeGreaterThanOrEqual(1);
    await ok("click", { tab, target: "#echo" });
    await ok("wait_for", { tab, text: "x-agent-test" });
    expect(await ok("intercept", { tab, action: "list" })).toMatch(
      new RegExp(`#${firstRule} .* 1 hits`),
    );

    await ok("intercept", {
      tab,
      action: "add",
      url: "/api/data",
      mode: "mock",
      mock_body: JSON.stringify({ message: "mocked reply" }),
    });
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "mocked reply" });

    await ok("intercept", {
      tab,
      action: "add",
      url: "/api/data",
      mode: "patch_response",
      replacements: [{ find: "mocked", replace: "patched" }],
    });
    expect(await ok("intercept", { tab, action: "clear" })).toMatch(/Removed 3 rules/);
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });

    const blockRule = Number(
      /Added rule #(\d+)/.exec(
        await ok("intercept", { tab, action: "add", url: "/api/data", mode: "block" }),
      )?.[1],
    );
    expect(blockRule).toBeGreaterThan(firstRule + 2);
    await ok("click", { tab, target: "#load" });
    expect(await ok("network", { tab, failed_only: true })).toMatch(/FAILED/);
    await ok("intercept", { tab, action: "clear" });
  });

  test("cookies can be set, listed, sent, exported and deleted", async () => {
    await ok("storage", {
      area: "cookies",
      action: "set",
      tab,
      key: "agent_cookie",
      value: "cookie-value-1",
    });
    expect(await ok("storage", { area: "cookies", action: "list", tab })).toMatch(
      /agent_cookie=cookie-value-1/,
    );
    await ok("click", { tab, target: "#echo" });
    await ok("wait_for", { tab, text: "agent_cookie=cookie-value-1" });
    const exported = await ok("storage", { area: "cookies", action: "export", tab });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8"))[0].name).toBe("agent_cookie");
    expect(
      await ok("storage", { area: "cookies", action: "delete", tab, key: "agent_cookie" }),
    ).toMatch(/Deleted 1 cookies/);
    expect(await ok("storage", { area: "cookies", action: "list", tab })).toMatch(
      /No matching cookies/,
    );
  });

  test("upload attaches a file", async () => {
    const file = path.join(mcp.workDir, "avatar.txt");
    await writeFile(file, "avatar");
    await ok("fill", { tab, target: "#avatar", files: [file] });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#avatar').files[0].name" }),
    ).toMatch(/avatar\.txt/);
    expect(
      (await call("fill", { tab, target: "#avatar", files: ["/nonexistent/file.txt"] })).isError,
    ).toBe(true);
  });

  test("downloads are saved and reported", async () => {
    const text = await ok("click", { tab, target: "#download" });
    const reported =
      /download saved to (.+)$/m.exec(text)?.[1] ??
      /download saved to (.+)$/m.exec(await ok("press", { tab, key: "Shift" }))?.[1];
    expect(reported, text).toMatch(/\S/);
    expect(await readFile(reported ?? "", "utf8")).toBe("a,b\n1,2\n");
  });

  test("screenshot returns an inline image and a file", async () => {
    const result = await call("screenshot", { tab });
    expect(result.isError).toBe(false);
    expect(
      result.content.filter((part) => part.type === "image" && (part.data?.length ?? 0) > 1000),
    ).toHaveLength(1);
    expect(result.text).toMatch(/saved to \S+\.jpg/);
  });

  test("navigation by click and read_page paging", async () => {
    expect(await ok("click", { tab, target: "text=Read the article" })).toMatch(
      /Navigated to .*\/article "Fixture Article"/,
    );
    const page = await ok("read_page", { tab, scope: "main", max_chars: 500 });
    expect(page).toMatch(/Long Article/);
    expect(page).not.toContain("Navigation chrome");
    const offset = Number(/pass offset=(\d+)/.exec(page)?.[1]);
    expect(offset).toBe(500);
    expect(await ok("read_page", { tab, scope: "main", offset, max_chars: 300 })).toMatch(
      /chars 500-800 of/,
    );
  });

  test("large snapshots are clipped and saved to a file", async () => {
    const clipped = await ok("snapshot", { tab, max_chars: 1500 });
    const file = /saved to (\S+\.yml)/.exec(clipped)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toMatch(/Paragraph 399/);
  });

  test("navigate back and to a missing page", async () => {
    expect(await ok("navigate", { tab, url: "back" })).toMatch(/Fixture Home/);
    expect(await ok("navigate", { tab, url: `${fixture().url}/missing` })).toMatch(/HTTP 404/);
    await ok("navigate", { tab, url: fixture().url });
  });

  test("run_script drives several tabs in one call", async () => {
    const text = await ok("run_script", {
      tab,
      code: `
        const titles = [await page.title()];
        for (const route of ["/article", "/missing"]) {
          const opened = await openTab("${fixture().url}" + route);
          titles.push(await opened.title());
          log("visited", route, tabId(opened));
          await closeTab(opened);
        }
        const api = await context.request.get("${fixture().url}/api/data");
        const file = await save("titles.json", JSON.stringify(titles));
        return { titles, api: (await api.json()).message, file, words: (await text(page)).split(" ").length > 3 };
      `,
    });
    expect(text).toMatch(/"Fixture Home"/);
    expect(text).toMatch(/"Fixture Article"/);
    expect(text).toMatch(/loaded from api/);
    expect(text).toMatch(/visited \/article t\d+/);
    const file = /"file":"([^"]+)"/.exec(text)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual([
      "Fixture Home",
      "Fixture Article",
      "Missing",
    ]);
  });

  test("run_script reports errors, logs and timeouts", async () => {
    const failed = await call("run_script", {
      tab,
      code: "log('step one'); throw new Error('boom');",
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/boom/);
    expect(failed.text).toMatch(/step one/);
    const slow = await call("run_script", { tab, code: "await sleep(5000);", timeout_ms: 1000 });
    expect(slow.isError).toBe(true);
    expect(slow.text).toMatch(/timed out after 1000 ms/);
    const secret = await ok("run_script", {
      tab,
      code: "await secrets.fill('#password', 'fixture/site'); return await page.locator('#password').inputValue();",
    });
    expect(secret).not.toContain(TEST_SECRET);
  });

  test("save_pages writes files and returns only an index", async () => {
    const text = await ok("save_pages", {
      urls: [fixture().url, `${fixture().url}/article`, "http://127.0.0.1:1/unreachable"],
      include: ["text", "links", "screenshot", "snapshot"],
      settle_ms: 0,
      label: "fixture",
    });
    expect(text).toMatch(/Collected 2 of 3 pages into (\S+)/);
    expect(text).toMatch(/03 FAILED/);
    expect(text.length).toBeLessThan(2500);
    const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
    const files = await readdir(dir);
    expect(files.filter((file) => file.endsWith(".jpg")).length).toBe(2);
    expect(files.filter((file) => file.endsWith(".snapshot.yml")).length).toBe(2);
    const article = files.find((file) => file.startsWith("02-") && file.endsWith(".txt")) ?? "";
    expect(await readFile(path.join(dir, article), "utf8")).toMatch(/Paragraph 399/);
    const links = files.find((file) => file.startsWith("01-") && file.endsWith(".links.tsv")) ?? "";
    expect(await readFile(path.join(dir, links), "utf8")).toMatch(/\/article\tRead the article/);
  });

  test("concurrent save_pages calls with the same label keep their pages apart", async () => {
    const [first, second] = await Promise.all(
      [fixture().url, `${fixture().url}/article`].map((url) =>
        ok("save_pages", { urls: [url], include: ["text"], settle_ms: 0, label: "same" }),
      ),
    );
    const dirs = [first, second].map((text) => /pages into (\S+)/.exec(text ?? "")?.[1] ?? "");
    const listed = await Promise.all(
      dirs.map(async (dir) => (await readdir(dir)).filter((file) => file.endsWith(".txt"))),
    );
    expect(listed.map((files) => files.length)).toStrictEqual([1, 1]);
  });

  test("popups become tabs and tabs can be closed", async () => {
    const text = await ok("click", { tab, target: "#popup" });
    const popup =
      /opened new tab (t\d+)/.exec(text)?.[1] ??
      /opened new tab (t\d+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1] ??
      "";
    expect(popup).toMatch(/^t\d+$/);
    expect(await ok("tabs")).toMatch(new RegExp(`${popup} \\[yours\\] .*\\/article`));
    await ok("tabs", { close: [popup] });
    const gone = await call("snapshot", { tab: popup });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/is not open/);
  });

  test("missing selector fails within the timeout with a hint", async () => {
    const started = Date.now();
    const result = await call("click", { tab, target: "#does-not-exist", timeout_ms: 1500 });
    expect(result.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.text).toMatch(/Take a snapshot/);
  });

  test("a click covered by the target's own label names the label to click", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/label-toggle` });
    const result = await call("click", { tab, target: "#yearly", timeout_ms: 1500 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /Its label covers the target: <label for="yearly">Billed yearly<\/label>\. Click that label instead/,
    );
  });

  test("a click covered by an element inside the target's own label names that label to click", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/label-switch` });
    const result = await call("click", { tab, target: "#basic-toggle", timeout_ms: 1500 });
    expect(result.text).toMatch(
      /^Its label covers the target: <div class="thumb"><\/div> inside <label for="basic-toggle" class="switch">…<\/label>\. Click that label instead/m,
    );
  });

  test("checking a box covered by an element inside its own label names that label to click", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/label-switch` });
    const result = await call("fill", {
      tab,
      target: "#basic-toggle",
      value: "true",
      timeout_ms: 1500,
    });
    expect(result.text).toMatch(
      /^Its label covers the target: <div class="thumb"><\/div> inside <label for="basic-toggle" class="switch">…<\/label>\. Click that label instead/m,
    );
  });

  test("a click covered by an overlay that goes away just before the timeout is not blamed on the label", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/label-overlay` });
    await mcp.deps.manager
      .getTab(tab)
      .page.evaluate(() => setTimeout(() => document.getElementById("loading")?.remove(), 1450));
    const result = await call("click", { tab, target: "#remember-me", timeout_ms: 1500 });
    expect(result.text).toMatch(
      /^Another element covers the target: <div id="loading"[^\n]*Run dismiss_overlays/m,
    );
  });

  test("include_diff reports only changed lines", async () => {
    await ok("navigate", { tab, url: fixture().url });
    const text = await ok("click", { tab, target: "#change", include_diff: true });
    expect(text).toMatch(/Snapshot changes/);
    expect(text).toMatch(/\+ .*changed/);
    expect(text.length).toBeLessThan(800);
  });

  test("include_diff reports a message that fades out and is removed after the click", async () => {
    const page = openedTab(await ok("navigate", { url: `${fixture().url}/notice` }));
    try {
      const close = refOf(await ok("snapshot", { tab: page }), 'link "Close message"');
      const text = await ok("click", { tab: page, target: close, include_diff: true });
      expect(text).toMatch(/^- .*Action successful/m);
    } finally {
      await ok("tabs", { close: [page] });
    }
  });

  test("hover that reveals a CSS :hover menu says the page changed, in agreement with its diff", async () => {
    const page = openedTab(await ok("navigate", { url: `${fixture().url}/hover-menu` }));
    try {
      const text = await ok("hover", { tab: page, target: "#menu-label", include_diff: true });
      expect(text).toMatch(/^\+ .*link "Lamps"/m);
      expect(text).toMatch(/^The page changed/m);
    } finally {
      await ok("tabs", { close: [page] });
    }
  });

  test("hover that reveals a CSS :hover menu without a diff says elements became visible", async () => {
    const page = openedTab(await ok("navigate", { url: `${fixture().url}/hover-menu` }));
    try {
      const text = await ok("hover", { tab: page, target: "#menu-label" });
      expect(text).toMatch(
        /^The page changed: 7 elements became visible although the DOM did not change/m,
      );
    } finally {
      await ok("tabs", { close: [page] });
    }
  });

  test("fill fields fills in order, reports invalid fields and submits", async () => {
    const text = await ok("fill", {
      tab,
      fields: [
        { target: "#name2", value: "Ada" },
        { target: "#age2", value: "12" },
      ],
    });
    expect(text).toMatch(/Filled textbox "Name" \((?:f\d+)?e\d+, from #name2\) with 3 chars\./);
    expect(text).toMatch(/Invalid: #age2/);
    await ok("fill", { tab, fields: [{ target: "#age2", value: "30" }], submit: "#submit2" });
    expect(await ok("read_page", { tab, target: "#status" })).toMatch(/form2 Ada/);
    const failed = await call("fill", {
      tab,
      fields: [
        { target: "#name2", value: "x" },
        { target: "#nope", value: "y" },
      ],
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/Filled 1 of 2 fields, then #nope failed/);
  });

  test("read_page structured returns json-ld, meta and tables as csv", async () => {
    const text = await ok("read_page", { tab, format: "structured" });
    expect(text).toMatch(/product "Fixture Lamp" · price 49\.90 EUR · InStock/);
    expect(text).toMatch(/"og:title": "Fixture OG Title"/);
    const csv = /"file": "([^"]+\.csv)"/.exec(text)?.[1] ?? "";
    expect(await readFile(csv, "utf8")).toBe('Item,Price\n"Lamp, large",49.90\nBulb,3.10');
  });

  test("request calls APIs with the session and replays captured requests", async () => {
    await ok("storage", { area: "cookies", action: "set", tab, key: "sess", value: "abc123" });
    const direct = await ok("request", { url: `${fixture().url}/api/items`, query: { page: "2" } });
    expect(direct).toMatch(/HTTP 200/);
    expect(direct).toMatch(/item-2-a/);
    expect(direct).toMatch(/sess=abc123/);
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const id = Number(
      /#(\d+) GET 200/.exec(await ok("network", { tab, pattern: "/api/data" }))?.[1],
    );
    const replayed = await ok("request", {
      tab,
      from_request: id,
      url: `${fixture().url}/api/items?page=3`,
    });
    expect(replayed).toMatch(/item-3-b/);
    const inPage = await ok("request", {
      tab,
      url: "/api/items?page=1".replace(/^/, fixture().url),
      via: "page",
    });
    expect(inPage).toMatch(/item-1-a/);
    await ok("storage", { area: "cookies", action: "delete", tab, key: "sess" });
  });

  test("save_pages tabs writes pdf, mhtml and html", async () => {
    await inSequence(["pdf", "mhtml", "html"], async (format) => {
      const text = await ok("save_pages", { tabs: [tab], include: [format], settle_ms: 0 });
      const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
      const name = (await readdir(dir)).find((entry) => entry.endsWith(`.${format}`)) ?? "";
      const file = path.join(dir, name);
      const head = (await readFile(file)).subarray(0, 60).toString("latin1");
      if (format === "pdf") expect(head).toMatch(/^%PDF/);
      if (format === "mhtml")
        expect(head).toMatch(/From: |MIME-Version|Snapshot-Content-Location/i);
      if (format === "html") expect(head).toMatch(/<html|<!DOCTYPE/i);
    });
  });

  test("handoff waits for the condition and times out with guidance", async () => {
    await ok("click", { tab, target: "#later" });
    expect(
      await ok("handoff", {
        tab,
        message: "Complete the check",
        until_text: "Verified by human",
        timeout_ms: 8000,
      }),
    ).toMatch(/completed the step/);
    const late = await call("handoff", {
      tab,
      message: "Never happens",
      until_text: "nothing like this",
      timeout_ms: 5000,
    });
    expect(late.isError).toBe(true);
    expect(late.text).toMatch(/has not completed the step/);
    expect(notifications).toStrictEqual([
      ["The browser agent needs you", `Complete the check (tab ${tab})`],
      ["The browser agent needs you", `Never happens (tab ${tab})`],
    ]);
  });

  test("background jobs run, log, finish and cancel", async () => {
    const started = await ok("run_script", {
      background: true,
      label: "paginate",
      code: `
        const all = [];
        for (let n = 1; ; n += 1) {
          const body = await (await context.request.get("${fixture().url}/api/items?page=" + n)).json();
          if (body.items.length === 0) break;
          all.push(...body.items);
          log("page", n);
        }
        return all;
      `,
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    const status =
      (await repeatUntil(
        async () => {
          const current = await ok("run_script", { job: id });
          return / done /.test(current) ? current : undefined;
        },
        { delayMs: () => 100, giveUp: (made) => made >= 40 },
      )) ?? "";
    expect(status).toMatch(/ done /);
    expect(status).toMatch(/page 3/);
    const resultFile = /Result: (\S+)/.exec(status)?.[1] ?? "";
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual({
      value: ["item-1-a", "item-1-b", "item-2-a", "item-2-b", "item-3-a", "item-3-b"],
    });

    const slow = await ok("run_script", {
      background: true,
      code: "const p = await openTab('about:blank'); log('opened', tabId(p)); await sleep(60000);",
    });
    const slowId = /job (j\d+)/.exec(slow)?.[1] ?? "";
    await sleep(500);
    const opened = /opened (t\d+)/.exec(await ok("run_script", { job: slowId }))?.[1] ?? "";
    expect(opened).toMatch(/^t\d+$/);
    expect(await ok("run_script", { job: slowId, cancel: true })).toMatch(/ cancelled /);
    expect(await ok("run_script", {})).toMatch(new RegExp(`${slowId} cancelled`));
    expect((await call("snapshot", { tab: opened })).isError).toBe(true);
  });

  test("cancelling a job shows its log lines once, all of them", async () => {
    const started = await ok("run_script", {
      background: true,
      code: "for (let tick = 0; ; tick += 1) { if (tick < 5) log('tick ' + tick); await sleep(50); }",
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    await sleep(600);
    const text = await ok("run_script", { job: id, cancel: true });
    expect(text).toMatch(/ cancelled /);
    expect(text.match(/^tick 0$/gm)?.length).toBe(1);
    expect(text).toMatch(/^tick 0\ntick 1\ntick 2\ntick 3\ntick 4$/m);
  });

  test("save_pages structured part adds product data to the index", async () => {
    const text = await ok("save_pages", {
      urls: [fixture().url],
      include: ["structured"],
      settle_ms: 0,
    });
    expect(text).toMatch(/product "Fixture Lamp" · price 49\.90 EUR/);
  });

  test("network body survives navigation", async () => {
    await ok("navigate", { tab, url: fixture().url });
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const id = Number(
      /#(\d+) GET 200/.exec(await ok("network", { tab, pattern: "/api/data" }))?.[1],
    );
    await ok("navigate", { tab, url: `${fixture().url}/article` });
    expect(await ok("network", { tab, id })).toMatch(/loaded from api/);
  });

  test("read_page markdown keeps structure and skips chrome", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/doc` });
    const text = await ok("read_page", { tab, format: "markdown", scope: "main" });
    expect(text).toMatch(/^# Doc Title$/m);
    expect(text).toMatch(/^## Steps$/m);
    expect(text).toMatch(/\[the article link\]\(http:\/\/127\.0\.0\.1:\d+\/article\)/);
    expect(text).toMatch(/\*\*bold words\*\*/);
    expect(text).toMatch(/^- First step\n {2}- Nested detail\n- Second step$/m);
    expect(text).toMatch(/^1\. One\n2\. Two$/m);
    expect(text).toMatch(/```js\nconst answer = 42;\nconsole\.log\(answer\);\n```/);
    expect(text).toMatch(
      /\| Name \| Qty \|\n\| --- \| --- \|\n\| Bolt \| 7 \|\n\| Nut \\\| small \| 9 \|/,
    );
    for (const chrome of [
      "Hidden secret text",
      "Sidebar chrome",
      "Doc footer chrome",
      "Doc navigation chrome",
      "localStorage",
    ]) {
      expect(text).not.toContain(chrome);
    }
    expect(await ok("read_page", { tab, format: "markdown", target: "table" })).toMatch(
      /^\[page content[^\n]*\n\| Name \| Qty \|/,
    );
  });

  test("save_pages saves markdown files", async () => {
    const text = await ok("save_pages", {
      urls: [`${fixture().url}/doc`],
      include: ["markdown"],
      settle_ms: 0,
    });
    const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
    const file = (await readdir(dir)).find((name) => name.endsWith(".md")) ?? "";
    expect(file).toMatch(/^01-.*\.md$/);
    const markdown = await readFile(path.join(dir, file), "utf8");
    expect(markdown).toMatch(/^<!-- URL: .*\/doc/);
    expect(markdown).toMatch(/```js/);
  });

  test("storage lists, gets and exports local, session and IndexedDB data", async () => {
    await ok("wait_for", { tab, text: "idb ready" });
    const local = await ok("storage", { tab, action: "list", area: "local" });
    expect(local).toMatch(/auth_token \(44 chars\)/);
    expect(local).toMatch(/prefs \(16 chars\)/);
    expect(await ok("storage", { tab, action: "get", area: "local", key: "auth_token" })).toMatch(
      /tok-x{40}/,
    );
    expect(await ok("storage", { tab, action: "list", area: "session" })).toMatch(
      /tab_state \(2 chars\)/,
    );
    const missing = await call("storage", { tab, action: "get", area: "local", key: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/no key "nope"/);
    const exported = await ok("storage", { tab, action: "export", area: "local" });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8")).entries.prefs).toBe('{"theme":"dark"}');

    expect(await ok("storage", { tab, action: "list", area: "indexeddb" })).toMatch(
      /fixture-db\/items \(2 records\)/,
    );
    const records = await ok("storage", { tab, action: "get", area: "indexeddb", key: "items" });
    expect(records).toMatch(/"name":"alpha"/);
    expect(records).toMatch(/"when":"1970-01-01T00:00:00.000Z"/);
    const idb = await ok("storage", { tab, action: "export", area: "indexeddb" });
    const idbFile = /to (\S+\.json)/.exec(idb)?.[1] ?? "";
    const dump = JSON.parse(await readFile(idbFile, "utf8"));
    expect(dump.databases["fixture-db"].items.records[0]).toEqual({
      key: 1,
      value: { id: 1, name: "alpha", tags: ["a", "b"] },
    });
  });

  test("site notes append, read and hint on navigation", async () => {
    expect(await ok("site", { tab })).toMatch(/No notes for 127\.0\.0\.1 yet/);
    expect(
      await ok("site", {
        tab,
        note: "items API: GET /api/items?page=N,\n3 pages",
      }),
    ).toMatch(/Added a note for 127\.0\.0\.1/);
    await ok("site", {
      site: "http://127.0.0.1/other",
      note: "dialogs are auto-accepted",
    });
    const notes = await ok("site", { site: "127.0.0.1" });
    expect(notes).toMatch(/^# 127\.0\.0\.1$/m);
    expect(notes).toMatch(/^- \d{4}-\d{2}-\d{2}: items API: GET \/api\/items\?page=N, 3 pages$/m);
    expect(notes).toMatch(/dialogs are auto-accepted/);
    expect(await ok("navigate", { tab, url: fixture().url })).toMatch(
      /Site notes exist for 127\.0\.0\.1 \(2 lines\): read them with site\./,
    );
    const opened = await ok("navigate", { url: `${fixture().url}/article` });
    expect(opened).toMatch(/Site notes exist for 127\.0\.0\.1/);
    await ok("tabs", { close: [/Opened (t\d+)/.exec(opened)?.[1] ?? ""] });
    expect((await call("site", { note: "x" })).isError).toBe(true);
  });

  test("navigate accepts cookie banners and dismiss_overlays closes modals and handles iframes", async () => {
    expect(await ok("navigate", { tab, url: `${fixture().url}/consent` })).toMatch(
      /^Event: accepted the cookie banner \(Accept all\)$/m,
    );
    const text = await ok("dismiss_overlays", { tab, consent: "reject" });
    expect(text).toMatch(
      /^Modal \[role=dialog\] in main frame: closed by clicking "Kapat" \(close\)\.$/m,
    );
    expect(text).not.toMatch(/Accept all|Reject all/);
    const state = await ok("evaluate", {
      tab,
      expression:
        "[...['status', 'modal-state', 'frame-state']].map((id) => document.getElementById(id).textContent).join('|')",
    });
    expect(state).toMatch(/accepted\|modal closed\|frame accepted/);
    expect(await ok("dismiss_overlays", { tab })).toMatch(/No cookie banner or modal/);
  });

  test("emulate sets and resets per-tab conditions", async () => {
    await ok("navigate", { tab, url: fixture().url });
    const probe = `(async () => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      width: screen.width,
      touch: navigator.maxTouchPoints,
      agent: navigator.userAgent,
      online: navigator.onLine,
    }))()`;
    const before = JSON.parse(
      (await ok("evaluate", { tab, expression: probe })).split("\n").slice(1).join("\n"),
    );
    const set = await ok("emulate", {
      tab,
      viewport: { width: 390, height: 844, mobile: true, scale: 3 },
      color_scheme: "dark",
      reduced_motion: "reduce",
      timezone: "Asia/Tokyo",
      locale: "de-DE",
      user_agent: "FixtureAgent/1.0",
      geolocation: { latitude: 41.01, longitude: 28.97 },
    });
    expect(set).toMatch(/viewport 390x844 @3x mobile\+touch/);
    expect(set).toMatch(/permission granted to http:\/\/127\.0\.0\.1/);
    const during = await ok("evaluate", { tab, expression: probe });
    expect(during).toMatch(/"dark":true/);
    expect(during).toMatch(/"reduced":true/);
    expect(during).toMatch(/"zone":"Asia\/Tokyo"/);
    expect(during).toMatch(/"width":390/);
    expect(during).toMatch(/"agent":"FixtureAgent\/1\.0"/);
    const position = await ok("evaluate", {
      tab,
      expression:
        "new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.latitude, p.coords.longitude]), (e) => reject(new Error(e.message)), { timeout: 5000 }))",
    });
    expect(position).toMatch(/41\.01[\s\S]*28\.97/);
    expect(
      await ok("evaluate", { tab, expression: "new Intl.NumberFormat().format(1234.5)" }),
    ).toMatch(/1\.234,5/);
    const echoed = await ok("request", { tab, url: `${fixture().url}/api/echo`, via: "page" });
    expect(echoed).toMatch(/"accept-language":\s*"de-DE/);

    await ok("emulate", { tab, network: "fast3g" });
    const slow = await ok("evaluate", {
      tab,
      expression:
        "(async () => { const t = performance.now(); await fetch('/api/data?slow=' + Math.random()); return performance.now() - t; })()",
    });
    expect(Number(slow.split("\n").at(-1))).toBeGreaterThan(400);
    const offline = await ok("emulate", { tab, offline: true, network: "none" });
    expect(offline).toMatch(/offline yes/);
    expect(
      await ok("evaluate", {
        tab,
        expression: "fetch('/api/data?o=' + Math.random()).then(() => 'reached', () => 'blocked')",
      }),
    ).toMatch(/blocked/);
    expect(await ok("evaluate", { tab, expression: "navigator.onLine" })).toMatch(/false/);

    const reset = await ok("emulate", { tab, reset: true });
    expect(reset).toMatch(/Cleared: .*viewport.*offline/);
    expect(reset).toMatch(/No emulation is active/);
    const after = JSON.parse(
      (await ok("evaluate", { tab, expression: probe })).split("\n").slice(1).join("\n"),
    );
    expect(after).toEqual(before);
    expect(
      await ok("evaluate", {
        tab,
        expression: "fetch('/api/data?r=' + Math.random()).then(() => 'reached', () => 'blocked')",
      }),
    ).toMatch(/reached/);
  });

  test("ask_pages answers over collected pages, tabs and folders through the adapter", async () => {
    expect(await ok("tabs")).toMatch(/ask_pages adapter: fixture adapter/);
    const text = await ok("ask_pages", {
      question: "Which page mentions paragraph 7?",
      urls: [fixture().url, `${fixture().url}/article`, `${fixture().url}/doc`],
      batch_chars: 30_000,
      max_pages_per_batch: 2,
    });
    expect(text).toMatch(/^- Paragraph 7 is in the article \[02-127-0-0-1-\d+-article\.md\]$/m);
    expect(text).toMatch(/Nothing relevant in: .*01-127-0-0-1-\d+\.md/);
    const file = /Full answers: (\S+\.md)/.exec(text)?.[1] ?? "";
    const answers = await readFile(file, "utf8");
    expect(answers).toMatch(/Adapter: fixture adapter, model claude-haiku-5-5, 2 call\(s\)/);
    expect(answers).toMatch(/input tokens 2000, output tokens 40/);
    expect(text).not.toContain("Paragraph 8 of");
    const prompt = askPrompts.at(-2) ?? askPrompts.at(-1) ?? "";
    const questionAt = prompt.indexOf("<question>\nWhich page mentions paragraph 7?\n</question>");
    expect(questionAt).not.toBe(-1);
    expect(questionAt).toBeGreaterThan(prompt.lastIndexOf("</document>"));
    expect(answers).toMatch(/Paragraph 7 is in the article/);

    const fromTab = await ok("ask_pages", { question: "Paragraph 7?", tabs: [tab] });
    expect(fromTab).toMatch(/No page had anything relevant|Nothing relevant in: t\d+ /);
    const dir =
      /pages into (\S+)/.exec(
        await ok("save_pages", {
          urls: [`${fixture().url}/article`],
          include: ["text"],
          settle_ms: 0,
        }),
      )?.[1] ?? "";
    expect(await ok("ask_pages", { question: "Paragraph 7?", dir })).toMatch(
      /\[01-.*-article\.txt\]/,
    );
    expect((await call("ask_pages", { question: "Paragraph 7?", dir, tabs: [tab] })).isError).toBe(
      true,
    );
  });

  test("site secrets returns names only", async () => {
    expect(await ok("site", { secrets: "" })).toBe("Password store: fixture/site");
  });
});

describe("structured results", () => {
  let opened: Awaited<ReturnType<typeof call>> | undefined;
  const openedResult = async () => {
    opened ??= await call("navigate", { url: `${fixture().url}/article` });
    return opened;
  };
  const openedId = async () => openedTab((await openedResult()).text);

  test("navigate returns the tab id it reports in its text", async () => {
    expect((await openedResult()).structured?.tab).toBe(await openedId());
  });

  test("navigate returns the final URL, title and HTTP status", async () => {
    expect((await openedResult()).structured).toMatchObject({
      url: `${fixture().url}/article`,
      title: "Fixture Article",
      status: 200,
    });
  });

  test("navigate of a blank tab returns its id and about:blank", async () => {
    const blank = await call("navigate", { url: "about:blank" });
    const id = openedTab(blank.text);
    await ok("tabs", { close: [id] });
    expect(blank.structured).toMatchObject({ tab: id, url: "about:blank" });
  });

  test("tabs returns each tab with its ownership, URL and title", async () => {
    const id = await openedId();
    const listed = await call("tabs");
    expect(listed.structured?.tabs).toContainEqual({
      id,
      ownership: "yours",
      url: `${fixture().url}/article`,
      title: "Fixture Article",
    });
  });

  test("tabs' structured text points to the tabs field instead of repeating the list", async () => {
    await openedId();
    const listed = await call("tabs");
    expect(listed.structured?.text).toMatch(/\nTabs:\n\(tabs in the tabs field\)$/);
  });

  test("tabs keeps the tab list in its text content", async () => {
    const id = await openedId();
    const listed = await call("tabs");
    expect(listed.text).toContain(`${id} [yours] ${fixture().url}/article "Fixture Article"`);
  });

  test("tabs returns the output directory", async () => {
    expect((await call("tabs")).structured?.outputDir).toBe(mcp.deps.store.root);
  });

  test("save_pages returns the folder and how many pages it collected", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/article`, "http://127.0.0.1:1/unreachable"],
      settle_ms: 0,
    });
    const dir = /pages into (\S+)/.exec(collected.text)?.[1];
    expect(collected.structured).toMatchObject({ dir, collected: 1, total: 2 });
  });

  test("save_pages returns each page with its files or its error", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/article`, "http://127.0.0.1:1/unreachable"],
      settle_ms: 0,
    });
    expect(collected.structured?.pages).toMatchObject([
      {
        index: 1,
        url: `${fixture().url}/article`,
        finalUrl: `${fixture().url}/article`,
        files: [expect.stringMatching(/^01-.*\.txt$/)],
      },
      {
        index: 2,
        url: "http://127.0.0.1:1/unreachable",
        files: [],
        error: expect.stringMatching(/\S/),
      },
    ]);
  });

  test("save_pages' structured text points to the pages field instead of repeating the index", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/article`],
      settle_ms: 0,
    });
    expect(collected.structured?.text).toMatch(/\n\(pages in the pages field\)$/);
  });

  test("save_pages keeps the index in its text content", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/article`],
      settle_ms: 0,
    });
    expect(collected.text).toMatch(/\n01 200 \S+\/article "Fixture Article"/);
  });

  test("save_pages returns each page's HTTP status and title", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/article`],
      settle_ms: 0,
    });
    expect(collected.structured?.pages).toMatchObject([{ status: 200, title: "Fixture Article" }]);
  });

  test("save_pages reports an error status with an empty body as the page's HTTP status", async () => {
    const collected = await call("save_pages", {
      urls: [`${fixture().url}/empty-500`],
      settle_ms: 0,
    });
    expect(collected.structured?.pages).toMatchObject([
      { status: 500, error: expect.stringMatching(/^http error: HTTP 500\b/) },
    ]);
  });

  test("navigate of an error status with an empty body names the status and no network failure", async () => {
    const result = await call("navigate", { url: `${fixture().url}/empty-500` });
    const tab = /Tab (t\d+) was opened|Opened (t\d+)/.exec(result.text)?.slice(1).find(Boolean);
    if (tab) await ok("tabs", { close: [tab] });
    expect([result.isError, result.structured?.status, /network level/.test(result.text)]).toEqual([
      false,
      500,
      false,
    ]);
  });

  test("tabs close on a tab opened on an error status with an empty body notes no move", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/empty-500` }));
    expect(await ok("tabs", { close: [tab] })).toStartWith(`Closed ${tab}`);
  });

  test("a call after navigate to an error status with an empty body notes no move", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await ok("navigate", { tab, url: `${fixture().url}/empty-500` });
    expect(await ok("tabs", { close: [tab] })).toStartWith(`Closed ${tab}`);
  });

  test("navigate to an error status with an empty body names the status and no network failure", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const text = await ok("navigate", { tab, url: `${fixture().url}/empty-500` });
    await ok("tabs", { close: [tab] });
    expect([/HTTP 500/.test(text), /network level/.test(text)]).toEqual([true, false]);
  });

  test("screenshot returns the file it saved", async () => {
    const shot = await call("screenshot", { tab: await openedId(), save_only: true });
    const file = /saved to (\S+\.jpg)/.exec(shot.text)?.[1];
    expect(shot.structured).toEqual({ file, text: "Screenshot saved to (file in the file field)" });
  });

  test("save_pages tabs returns the file it saved", async () => {
    const saved = await call("save_pages", {
      tabs: [await openedId()],
      include: ["html"],
      settle_ms: 0,
    });
    expect(JSON.stringify(saved.structured?.pages)).toMatch(/01-[^"]*\.html/);
  });

  test("run_script in the background returns the job id and its files", async () => {
    const started = await call("run_script", { background: true, code: "return 1;" });
    const jobId = /job (j\d+)/.exec(started.text)?.[1];
    const logFile = /Log: (\S+)/.exec(started.text)?.[1];
    const resultFile = /written to (\S+) when/.exec(started.text)?.[1];
    expect(started.structured).toEqual({
      jobId,
      state: "running",
      elapsedMs: expect.any(Number),
      logFile,
      resultFile,
      text: expect.stringContaining("Log: (logFile in the logFile field)"),
    });
  });

  test("run_script in the foreground returns its value and a text that says what it is", async () => {
    const ran = await call("run_script", { code: "return 1;" });
    expect(ran.structured).toEqual({ value: 1, text: "Returned a number." });
  });

  test("navigate repeats its text with the snapshot in the structured result", async () => {
    const withSnapshot = await call("navigate", {
      url: `${fixture().url}/article`,
      include_snapshot: true,
    });
    await ok("tabs", { close: [openedTab(withSnapshot.text)] });
    expect(withSnapshot.structured?.text).toBe(withSnapshot.text);
  });

  test("tabs' structured text points to the server state fields instead of repeating them", async () => {
    const listed = await call("tabs");
    expect(listed.structured?.text).toStartWith(
      "Server state: (browser, profile, cookieBanners, secretStore, askAdapter and log in their fields)\nOutput files: (outputDir in the outputDir field)",
    );
  });

  test("tabs keeps the browser status in its text content", async () => {
    const listed = await call("tabs");
    expect(listed.text).toContain(`Profile: ${mcp.deps.manager.config.profileDir}`);
  });

  test("run_script's structured text points to the logs field instead of repeating the log lines", async () => {
    const result = await call("run_script", { code: "log('first'); return 1;" });
    expect(result.structured?.text).toBe("Returned a number.\nLogs: (logs in the logs field)");
  });

  test("run_script keeps its log lines in its text content", async () => {
    const result = await call("run_script", { code: "log('first'); return 1;" });
    expect(result.text).toBe("Returned: 1\nLogs:\nfirst");
  });

  test("a finished job's structured text points to its file and log fields instead of repeating them", async () => {
    const started = await call("run_script", {
      code: "log('job line'); return 1;",
      background: true,
    });
    const job = /job (j\d+)/.exec(started.text)?.[1];
    const waited = await call("run_script", { job, wait: true });
    expect(String(waited.structured?.text).split("\n").slice(1)).toStrictEqual([
      "Log: (logFile in the logFile field)",
      "Result: (resultFile in the resultFile field)",
      "Returned a number.",
      "Recent log lines: (recentLogs in the recentLogs field)",
    ]);
  });

  test("a background start's structured text points to the log and result file fields", async () => {
    const started = await call("run_script", { code: "return 1;", background: true });
    expect(started.structured?.text).toMatch(
      /^Started background job j\d+\. Log: \(logFile in the logFile field\)\n.*the result is written to \(resultFile in the resultFile field\) when it ends\.$/,
    );
  });

  test("a screenshot's structured text points to the file field instead of repeating the path", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const shot = await call("screenshot", { tab });
    await ok("tabs", { close: [tab] });
    expect(shot.structured?.text).toBe(
      `Screenshot of ${fixture().url}/article saved to (file in the file field)`,
    );
  });

  test("run_script in the foreground names the file that holds its clipped output", async () => {
    const clipped = await call("run_script", {
      code: "return 'x'.repeat(2000);",
      max_chars: 300,
    });
    const file = /Full output saved to (\S+?)\.\]/.exec(clipped.text)?.[1];
    expect(clipped.structured?.file).toBe(file);
  });
});

const timedNavigate = async (args: ToolArgs) => {
  const startedAt = Date.now();
  const result = await call("navigate", args);
  return { result, ms: Date.now() - startedAt };
};

const closeOpened = async (text: string) => {
  const tab = /(?:Opened|Tab) (t\d+)/.exec(text)?.[1];
  if (tab) await ok("tabs", { close: [tab] });
};

describe("facts as structured fields", () => {
  test("tabs returns the browser state", async () => {
    await ok("tabs", { close: [openedTab(await ok("navigate", { url: fixture().url }))] });
    expect((await call("tabs")).structured?.browser).toMatchObject({
      running: true,
      engine: mcp.deps.manager.config.engine,
      headless: true,
    });
  });

  test("tabs returns the profile folder", async () => {
    expect((await call("tabs")).structured?.profile).toBe(mcp.deps.manager.config.profileDir);
  });

  test("tabs returns the cookie banner setting", async () => {
    expect((await call("tabs")).structured?.cookieBanners).toBe(
      mcp.deps.manager.config.autoConsent,
    );
  });

  test("tabs returns the secret store", async () => {
    expect((await call("tabs")).structured?.secretStore).toBe("fake");
  });

  test("tabs returns the model adapter", async () => {
    expect((await call("tabs")).structured?.askAdapter).toBe(mcp.deps.ask.label);
  });

  test("tabs returns the log folder with the errors of the last hour", async () => {
    expect((await call("tabs")).structured?.log).toMatchObject({
      dir: mcp.deps.log.dir,
      errorsLastHour: expect.any(Number),
    });
  });

  test("navigate returns the block it found", async () => {
    const result = await call("navigate", { url: `${fixture().url}/challenge/blocked` });
    await closeOpened(result.text);
    expect(result.structured?.challenge).toMatchObject({
      kind: "block",
      detail: expect.stringMatching(/^HTTP 429\b/),
    });
  });

  test("navigate returns the redirects it followed", async () => {
    const result = await call("navigate", { url: `${fixture().url}/actions/redirect` });
    await closeOpened(result.text);
    expect(result.structured?.redirectedFrom).toEqual([`${fixture().url}/actions/redirect`]);
  });

  test("navigate returns the file a download URL saved", async () => {
    const result = await call("navigate", { url: `${fixture().url}/download` });
    await closeOpened(result.text);
    expect(result.structured?.download).toMatchObject({
      name: "report.csv",
      file: expect.stringMatching(/report.*\.csv$/),
    });
  });

  test("navigate back over a pushState entry says no new request was made", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await ok("evaluate", { tab, expression: 'history.pushState({}, "", "/article-pushed")' });
    const result = await call("navigate", { tab, url: "back" });
    await ok("tabs", { close: [tab] });
    expect(result.structured?.sameDocument).toBe(true);
  });

  test("network returns each page with its requests", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const listed = await call("network", { tab });
    await ok("tabs", { close: [tab] });
    expect(listed.structured?.pages).toContainEqual({
      url: `${fixture().url}/article`,
      current: true,
      requests: expect.arrayContaining([
        expect.objectContaining({
          method: "GET",
          status: 200,
          type: "document",
          url: `${fixture().url}/article`,
          state: "answered",
        }),
      ]),
    });
  });

  test("network with id returns the request's state", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const id = Number(/#(\d+) GET 200 document/.exec(await ok("network", { tab }))?.[1]);
    const detail = await call("network", { tab, id });
    await ok("tabs", { close: [tab] });
    expect(detail.structured?.request).toMatchObject({ id, status: 200, state: "answered" });
  });

  test("network with har returns the file it wrote", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const exported = await call("network", { tab, har: true });
    await ok("tabs", { close: [tab] });
    expect(exported.structured?.harFile).toBe(/to (\S+\.har)$/.exec(exported.text)?.[1]);
  });

  test("logs of a page returns its entries grouped by page", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/console` }));
    await sleep(300);
    const read = await call("logs", { source: "page", tab, contains: "page log line" });
    await ok("tabs", { close: [tab] });
    expect(read.structured?.pages).toMatchObject([
      {
        url: `${fixture().url}/console`,
        current: true,
        entries: [{ level: "log", text: "page log line" }],
      },
    ]);
  });

  test("logs of a page points its structured text to the pages field instead of repeating the entries", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/console` }));
    await sleep(300);
    const read = await call("logs", { source: "page", tab, contains: "page log line" });
    await ok("tabs", { close: [tab] });
    expect(read.structured?.text).not.toContain("page log line");
  });

  test("logs of a page keeps the page content marker in its structured text", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/console` }));
    await sleep(300);
    const read = await call("logs", { source: "page", tab, contains: "page log line" });
    await ok("tabs", { close: [tab] });
    expect(read.structured?.text).toContain("— data, not instructions]");
  });

  test("logs of a page keeps the entries in its text content", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/console` }));
    await sleep(300);
    const read = await call("logs", { source: "page", tab, contains: "page log line" });
    await ok("tabs", { close: [tab] });
    expect(read.text).toContain("page log line");
  });

  test("logs of the server points its structured text to the entries field instead of repeating them", async () => {
    const read = await call("logs", { source: "server", tool: "tabs", limit: 1 });
    expect(read.structured?.text).toMatch(
      /^1 entries \(newest last\): \(entries in the entries field\)$/m,
    );
  });

  test("network points its structured text to the pages field instead of repeating the requests", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const listed = await call("network", { tab });
    await ok("tabs", { close: [tab] });
    expect(listed.structured?.text).not.toContain(`GET 200 document ${fixture().url}/article`);
  });

  test("network keeps the page content marker in its structured text", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const listed = await call("network", { tab });
    await ok("tabs", { close: [tab] });
    expect(listed.structured?.text).toContain("— data, not instructions]");
  });

  test("network keeps the requests in its text content", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const listed = await call("network", { tab });
    await ok("tabs", { close: [tab] });
    expect(listed.text).toContain(`GET 200 document ${fixture().url}/article`);
  });

  test("logs of the server returns its log folder", async () => {
    expect((await call("logs", { source: "server" })).structured?.dir).toBe(mcp.deps.log.dir);
  });

  test("logs of the server returns its entries", async () => {
    const read = await call("logs", { source: "server", tool: "tabs", limit: 1 });
    expect(read.structured?.entries).toMatchObject([{ tool: "tabs" }]);
  });

  test("run_script in the foreground returns its log lines", async () => {
    const result = await call("run_script", { code: "log('first'); log('second'); return 1;" });
    expect(result.structured?.logs).toEqual(["first", "second"]);
  });

  test("a job returns its recent log lines", async () => {
    const started = await call("run_script", {
      code: "log('job line'); return 1;",
      background: true,
    });
    const job = /job (j\d+)/.exec(started.text)?.[1];
    const waited = await call("run_script", { job, wait: true });
    expect(waited.structured?.recentLogs).toEqual(["job line"]);
  });

  test("a job started on a tab with another job running names that job as the one it waits behind", async () => {
    const tab = openedTab(await ok("navigate", { url: fixture().url }));
    const first = await call("run_script", { tab, code: "await sleep(1500);", background: true });
    const firstJob = /job (j\d+)/.exec(first.text)?.[1];
    const second = await call("run_script", { tab, code: "return 1;", background: true });
    const secondJob = /job (j\d+)/.exec(second.text)?.[1];
    await call("run_script", { job: secondJob, wait: true });
    await ok("tabs", { close: [tab] });
    expect(second.structured?.queuedBehind).toBe(firstJob);
  });

  test("a call on a tab that moved since the last call returns the note as a field", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await mcp.deps.manager.getTab(tab).page.goto(`${fixture().url}/`);
    const result = await call("navigate", { tab, url: "reload" });
    await ok("tabs", { close: [tab] });
    expect(result.structured?.notes).toEqual([
      `Note: the tab moved to ${fixture().url}/ since your last call.`,
    ]);
  });

  test("a call on a tab that moved since the last call points its structured text to the notes field", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await mcp.deps.manager.getTab(tab).page.goto(`${fixture().url}/`);
    const result = await call("navigate", { tab, url: "reload" });
    await ok("tabs", { close: [tab] });
    expect(String(result.structured?.text).split("\n").slice(0, 2)).toStrictEqual([
      "(notes in the notes field)",
      expect.not.stringMatching(/^Note:/),
    ]);
  });

  test("save_pages of a tab that moved returns the note as a field", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await mcp.deps.manager.getTab(tab).page.goto(`${fixture().url}/`);
    const saved = await call("save_pages", { tabs: [tab], settle_ms: 0 });
    await ok("tabs", { close: [tab] });
    expect(saved.structured?.notes).toEqual([
      `Note: ${tab} moved to ${fixture().url}/ since your last call.`,
    ]);
  });

  test("save_pages of a tab that moved points its structured text to the notes field instead of repeating the note", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    await mcp.deps.manager.getTab(tab).page.goto(`${fixture().url}/`);
    const saved = await call("save_pages", { tabs: [tab], settle_ms: 0 });
    await ok("tabs", { close: [tab] });
    expect(String(saved.structured?.text).split("\n").slice(0, 2)).toStrictEqual([
      "(notes in the notes field)",
      expect.not.stringMatching(/^Note:/),
    ]);
  });
});

describe("navigation answered with no content", () => {
  test("navigate to a URL answered with no content succeeds", async () => {
    const { result } = await timedNavigate({ url: `${fixture().url}/no-content` });
    await closeOpened(result.text);
    expect(result.isError).toBe(false);
  });

  test("navigate to a URL answered with no content returns without waiting for a download", async () => {
    const { result, ms } = await timedNavigate({ url: `${fixture().url}/no-content` });
    await closeOpened(result.text);
    expect(ms).toBeLessThan(2000);
  });

  test("navigate to a URL answered with no content gives status 204", async () => {
    const { result } = await timedNavigate({ url: `${fixture().url}/no-content` });
    await closeOpened(result.text);
    expect(result.structured?.status).toBe(204);
  });

  test("a new tab answered with no content says the tab stays blank", async () => {
    const { result } = await timedNavigate({ url: `${fixture().url}/no-content` });
    await closeOpened(result.text);
    expect(result.text).toMatch(
      new RegExp(
        `^Opened t\\d+\\.\\nNo page to show: ${fixture().url}/no-content answered HTTP 204 No Content, so the tab stays at about:blank\\.$`,
        "m",
      ),
    );
  });

  test("navigate from a page to a URL answered with no content says the tab stays on that page", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const { result } = await timedNavigate({ tab, url: `${fixture().url}/no-content` });
    await ok("tabs", { close: [tab] });
    expect(result.text.split("\n")[0]).toBe(
      `No page to show: ${fixture().url}/no-content answered HTTP 204 No Content, so the tab stays at ${fixture().url}/article "Fixture Article".`,
    );
  });

  test("a script reads the title of the page that stayed open after a navigation answered with no content", async () => {
    const tab = openedTab(await ok("navigate", { url: "data:text/html,<title>d10</title>data" }));
    await timedNavigate({ tab, url: `${fixture().url}/no-content` });
    const result = await call("run_script", { tab, code: "return await page.title();" });
    await ok("tabs", { close: [tab] });
    expect(result.structured?.value).toBe("d10");
  });

  test("navigate from a data URL page to a URL answered with no content returns at once", async () => {
    const tab = openedTab(await ok("navigate", { url: "data:text/html,<title>d</title>data" }));
    const { ms } = await timedNavigate({ tab, url: `${fixture().url}/no-content` });
    await ok("tabs", { close: [tab] });
    expect(ms).toBeLessThan(2000);
  });

  test("navigate through a redirect to no content names the redirect", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const { result } = await timedNavigate({ tab, url: `${fixture().url}/to-no-content` });
    await ok("tabs", { close: [tab] });
    expect(result.text.split("\n")[0]).toBe(
      `No page to show: ${fixture().url}/no-content answered HTTP 204 No Content (redirected from ${fixture().url}/to-no-content), so the tab stays at ${fixture().url}/article "Fixture Article".`,
    );
  });

  test("navigate through a redirect to no content gives status 204", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/article` }));
    const { result } = await timedNavigate({ tab, url: `${fixture().url}/to-no-content` });
    await ok("tabs", { close: [tab] });
    expect(result.structured?.status).toBe(204);
  });

  test("save_pages lists a URL answered with no content with status 204", async () => {
    const saved = await call("save_pages", { urls: [`${fixture().url}/no-content`], settle_ms: 0 });
    expect(saved.structured?.pages).toMatchObject([{ status: 204 }]);
  });

  test("save_pages says a URL answered with no content has no page to save", async () => {
    const saved = await call("save_pages", { urls: [`${fixture().url}/no-content`], settle_ms: 0 });
    expect(saved.text).toMatch(
      /^01 204 \S+\/no-content — no content: the server answered HTTP 204 No Content, so there is no page to save$/m,
    );
  });
});

test("the debug log records every call without secret values", async () => {
  await mcp.deps.log.flush();
  const dir = path.join(mcp.workDir, "logs");
  const files = (await readdir(dir)).filter((name) =>
    /^daemon-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name),
  );
  expect(files.length).toBeGreaterThan(0);
  const raw = (await Promise.all(files.map((name) => readFile(path.join(dir, name), "utf8")))).join(
    "",
  );
  expect(raw).toContain('"tool":"fill"');
  expect(raw).toContain('"result":');
  expect(raw).toContain('"event":"model_call","tool":"ask_pages","adapter":"fixture adapter"');
  expect(raw).not.toContain(TEST_SECRET);
  expect(raw).not.toContain(encodeURIComponent(TEST_SECRET));
});
