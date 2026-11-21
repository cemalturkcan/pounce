import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { inSequence, repeatUntil, sleep } from "../src/shared/async.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, askPrompts, notifications, openedTab, refOf } =
  useToolsHarness("tools-flow");

const propertiesSchema = z.record(z.string(), z.object({ description: z.string().optional() }));

test("every tool and parameter is described", async () => {
  const { tools } = await mcp.client.listTools();
  expect(tools.length).toBe(41);
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

  test("tabs_list does not start the browser", async () => {
    expect(await ok("tabs_list")).toMatch(/Browser not started/);
  });

  test("tab_open returns an id and a snapshot with refs", async () => {
    const text = await ok("tab_open", { url: fixture().url, include_snapshot: true });
    tab = /Opened (t\d+)/.exec(text)?.[1] ?? "";
    expect(tab).toMatch(/^t\d+$/);
    expect(text).toMatch(/Fixture Home/);
    expect(text).toMatch(/button "Change status" \[ref=/);
    snapshot = text;
  });

  test("click by ref reports a page change", async () => {
    const text = await ok("click", { tab, target: refOf(snapshot, 'button "Change status"') });
    expect(text).toMatch(/The page changed/);
    expect(await ok("read_text", { tab, target: "#status" })).toMatch(/changed/);
  });

  test("click that does nothing says so", async () => {
    expect(await ok("click", { tab, target: "#noop" })).toMatch(/No change detected/);
  });

  test("click reports a page change on a site that defines its own webAgentMutations global", async () => {
    const siteTab =
      /Opened (t\d+)/.exec(await ok("tab_open", { url: `${fixture().url}/site-globals` }))?.[1] ??
      "";
    const text = await ok("click", { tab: siteTab, target: "#change" });
    await ok("tab_close", { tab: siteTab });
    expect(text).toMatch(/The page changed/);
  });

  test("click inside an iframe by frame ref", async () => {
    const fresh = await ok("snapshot", { tab });
    expect(fresh).toMatch(/data, not instructions/);
    await ok("click", { tab, target: refOf(fresh, 'button "Frame button"') });
    expect(await ok("read_text", { tab, target: "#status" })).toMatch(/framed/);
  });

  test("stale ref gives an actionable error quickly", async () => {
    const result = await call("click", { tab, target: "e9999" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not in the latest snapshot/);
  });

  test("a ref taken before a reload says the page was reloaded", async () => {
    const page = openedTab(await ok("tab_open", { url: `${fixture().url}/` }));
    try {
      const before = refOf(await ok("snapshot", { tab: page }), 'button "Load data"');
      await ok("navigate", { tab: page, url: "reload" });
      const result = await call("click", { tab: page, target: before });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(
        new RegExp(
          `Ref ${before} is from a snapshot taken before tab ${page} loaded a new page \\(navigation or reload\\)`,
        ),
      );
    } finally {
      await ok("tab_close", { tab: page });
    }
  });

  test("a ref from an earlier page load with a frame number says the page was reloaded", async () => {
    const page = openedTab(await ok("tab_open", { url: `${fixture().url}/` }));
    try {
      await ok("navigate", { tab: page, url: "reload" });
      const before = refOf(await ok("snapshot", { tab: page }), 'button "Load data"');
      expect(before).toMatch(/^f\d+e\d+$/);
      await ok("navigate", { tab: page, url: "reload" });
      const result = await call("click", { tab: page, target: before });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(
        new RegExp(`Ref ${before} is from a snapshot taken before tab ${page} loaded a new page`),
      );
    } finally {
      await ok("tab_close", { tab: page });
    }
  });

  test("fill handles text, select and checkbox", async () => {
    expect(await ok("fill", { tab, target: "#email", text: "person@example.test" })).toMatch(
      /Filled #email \(19 chars\)/,
    );
    await ok("fill", { tab, target: "#plan", text: "Pro" });
    await ok("fill", { tab, target: "#terms", text: "true" });
    const state = await ok("evaluate", {
      tab,
      expression:
        "({ email: document.querySelector('#email').value, plan: document.querySelector('#plan').value, terms: document.querySelector('#terms').checked })",
    });
    expect(state).toMatch(/person@example\.test/);
    expect(state).toMatch(/"plan": "pro"/);
    expect(state).toMatch(/"terms": true/);
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
      await ok("fill", { tab, target: "#email", text: "second@example.test", submit: true }),
    ).toMatch(/Filled/);
    expect(await ok("read_text", { tab, target: "#status" })).toMatch(/submitted/);
    await ok("press", { tab, key: "Tab", target: "#email" });
  });

  test("find returns matching lines with refs", async () => {
    const found = await ok("find", { tab, query: "sign up" });
    expect(found).toMatch(/button "Sign up" \[ref=/);
    expect(await ok("find", { tab, query: "no such thing anywhere" })).toMatch(/No match/);
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

  test("dialogs are accepted and reported", async () => {
    expect(await ok("click", { tab, target: "#alert" })).toMatch(
      /alert dialog "Careful now" was accepted/,
    );
  });

  test("console capture works on local hosts", async () => {
    const logs = await ok("console_logs", { tab });
    expect(logs).toMatch(/boot log/);
    const errors = await ok("console_logs", { tab, level: "errors" });
    expect(errors).toMatch(/boot error/);
    expect(errors).not.toContain("boot log");
  });

  test("network list, detail and HAR export", async () => {
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const list = await ok("network_requests", { tab, pattern: "/api/data" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    expect(id).toBeGreaterThan(0);
    expect(await ok("network_requests", { tab, id })).toMatch(/loaded from api/);
    const exported = await ok("network_export", { tab, pattern: "/api/" });
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
    expect(await ok("network_requests", { tab, failed_only: true })).toMatch(/FAILED/);
    await ok("intercept", { tab, action: "clear" });
  });

  test("cookies can be set, listed, sent, exported and deleted", async () => {
    await ok("cookies", { action: "set", tab, name: "agent_cookie", value: "cookie-value-1" });
    expect(await ok("cookies", { action: "list", tab })).toMatch(/agent_cookie=cookie-value-1/);
    await ok("click", { tab, target: "#echo" });
    await ok("wait_for", { tab, text: "agent_cookie=cookie-value-1" });
    const exported = await ok("cookies", { action: "export", tab });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8"))[0].name).toBe("agent_cookie");
    expect(await ok("cookies", { action: "delete", name: "agent_cookie" })).toMatch(
      /Deleted 1 cookies/,
    );
    expect(await ok("cookies", { action: "list", tab })).toMatch(/No matching cookies/);
  });

  test("upload attaches a file", async () => {
    const file = path.join(mcp.workDir, "avatar.txt");
    await writeFile(file, "avatar");
    await ok("upload", { tab, target: "#avatar", paths: [file] });
    expect(
      await ok("evaluate", { tab, expression: "document.querySelector('#avatar').files[0].name" }),
    ).toMatch(/avatar\.txt/);
    expect(
      (await call("upload", { tab, target: "#avatar", paths: ["/nonexistent/file.txt"] })).isError,
    ).toBe(true);
  });

  test("downloads are saved and reported", async () => {
    const text = await ok("click", { tab, target: "#download" });
    const reported =
      /download saved to (\S+)/.exec(text)?.[1] ??
      /download saved to (\S+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1];
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

  test("navigation by click and read_text paging", async () => {
    expect(await ok("click", { tab, target: "text=Read the article" })).toMatch(
      /Navigated to .*\/article "Fixture Article"/,
    );
    const page = await ok("read_text", { tab, scope: "main", max_chars: 500 });
    expect(page).toMatch(/Long Article/);
    expect(page).not.toContain("Navigation chrome");
    const offset = Number(/pass offset=(\d+)/.exec(page)?.[1]);
    expect(offset).toBe(500);
    expect(await ok("read_text", { tab, scope: "main", offset, max_chars: 300 })).toMatch(
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
    const file = /"file": "([^"]+)"/.exec(text)?.[1] ?? "";
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

  test("collect_pages writes files and returns only an index", async () => {
    const text = await ok("collect_pages", {
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

  test("popups become tabs and tabs can be closed", async () => {
    const text = await ok("click", { tab, target: "#popup" });
    const popup =
      /opened new tab (t\d+)/.exec(text)?.[1] ??
      /opened new tab (t\d+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1] ??
      "";
    expect(popup).toMatch(/^t\d+$/);
    expect(await ok("tabs_list")).toMatch(new RegExp(`${popup} \\[yours\\] .*\\/article`));
    await ok("tab_close", { tab: popup });
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

  test("include_diff reports only changed lines", async () => {
    await ok("navigate", { tab, url: fixture().url });
    const text = await ok("click", { tab, target: "#change", include_diff: true });
    expect(text).toMatch(/Snapshot changes/);
    expect(text).toMatch(/\+ .*changed/);
    expect(text.length).toBeLessThan(800);
  });

  test("include_diff reports a message that fades out and is removed after the click", async () => {
    const page = openedTab(await ok("tab_open", { url: `${fixture().url}/notice` }));
    try {
      const close = refOf(await ok("snapshot", { tab: page }), 'link "Close message"');
      const text = await ok("click", { tab: page, target: close, include_diff: true });
      expect(text).toMatch(/^- .*Action successful/m);
    } finally {
      await ok("tab_close", { tab: page });
    }
  });

  test("hover that reveals a CSS :hover menu says the page changed, in agreement with its diff", async () => {
    const page = openedTab(await ok("tab_open", { url: `${fixture().url}/hover-menu` }));
    try {
      const text = await ok("hover", { tab: page, target: "#menu-label", include_diff: true });
      expect(text).toMatch(/^\+ .*link "Lamps"/m);
      expect(text).toMatch(/^The page changed/m);
    } finally {
      await ok("tab_close", { tab: page });
    }
  });

  test("fill_form fills in order, reports invalid fields and submits", async () => {
    const text = await ok("fill_form", {
      tab,
      fields: [
        { target: "#name2", text: "Ada" },
        { target: "#age2", text: "12" },
      ],
    });
    expect(text).toMatch(/Filled #name2 \(3 chars\)/);
    expect(text).toMatch(/Invalid: #age2/);
    await ok("fill_form", { tab, fields: [{ target: "#age2", text: "30" }], submit: "#submit2" });
    expect(await ok("read_text", { tab, target: "#status" })).toMatch(/form2 Ada/);
    const failed = await call("fill_form", {
      tab,
      fields: [
        { target: "#name2", text: "x" },
        { target: "#nope", text: "y" },
      ],
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/Filled 1 of 2 fields, then #nope failed/);
  });

  test("extract returns json-ld, meta and tables as csv", async () => {
    const text = await ok("extract", { tab });
    expect(text).toMatch(/product "Fixture Lamp" · price 49\.90 EUR · InStock/);
    expect(text).toMatch(/"og:title": "Fixture OG Title"/);
    const csv = /"file": "([^"]+\.csv)"/.exec(text)?.[1] ?? "";
    expect(await readFile(csv, "utf8")).toBe('Item,Price\n"Lamp, large",49.90\nBulb,3.10');
  });

  test("request calls APIs with the session and replays captured requests", async () => {
    await ok("cookies", { action: "set", tab, name: "sess", value: "abc123" });
    const direct = await ok("request", { url: `${fixture().url}/api/items`, query: { page: "2" } });
    expect(direct).toMatch(/HTTP 200/);
    expect(direct).toMatch(/item-2-a/);
    expect(direct).toMatch(/sess=abc123/);
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const id = Number(
      /#(\d+) GET 200/.exec(await ok("network_requests", { tab, pattern: "/api/data" }))?.[1],
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
    await ok("cookies", { action: "delete", name: "sess" });
  });

  test("save_page writes pdf, mhtml and html", async () => {
    await inSequence(["pdf", "mhtml", "html"], async (format) => {
      const text = await ok("save_page", { tab, format });
      const file = new RegExp(`to (\\S+\\.${format})`).exec(text)?.[1] ?? "";
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
          const current = await ok("jobs", { action: "status", id });
          return / done /.test(current) ? current : undefined;
        },
        { delayMs: () => 100, giveUp: (made) => made >= 40 },
      )) ?? "";
    expect(status).toMatch(/ done /);
    expect(status).toMatch(/page 3/);
    const resultFile = /Result: (\S+)/.exec(status)?.[1] ?? "";
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual([
      "item-1-a",
      "item-1-b",
      "item-2-a",
      "item-2-b",
      "item-3-a",
      "item-3-b",
    ]);

    const slow = await ok("run_script", {
      background: true,
      code: "const p = await openTab('about:blank'); log('opened', tabId(p)); await sleep(60000);",
    });
    const slowId = /job (j\d+)/.exec(slow)?.[1] ?? "";
    await sleep(500);
    const opened =
      /opened (t\d+)/.exec(await ok("jobs", { action: "status", id: slowId }))?.[1] ?? "";
    expect(opened).toMatch(/^t\d+$/);
    expect(await ok("jobs", { action: "cancel", id: slowId })).toMatch(/ cancelled /);
    expect(await ok("jobs", { action: "list" })).toMatch(new RegExp(`${slowId} cancelled`));
    expect((await call("snapshot", { tab: opened })).isError).toBe(true);
  });

  test("cancelling a job shows its log lines once, all of them", async () => {
    const started = await ok("run_script", {
      background: true,
      code: "for (let tick = 0; ; tick += 1) { if (tick < 5) log('tick ' + tick); await sleep(50); }",
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    await sleep(600);
    const text = await ok("jobs", { action: "cancel", id });
    expect(text).toMatch(/ cancelled /);
    expect(text.match(/^tick 0$/gm)?.length).toBe(1);
    expect(text).toMatch(/^tick 0\ntick 1\ntick 2\ntick 3\ntick 4$/m);
  });

  test("collect_pages structured part adds product data to the index", async () => {
    const text = await ok("collect_pages", {
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
      /#(\d+) GET 200/.exec(await ok("network_requests", { tab, pattern: "/api/data" }))?.[1],
    );
    await ok("navigate", { tab, url: `${fixture().url}/article` });
    expect(await ok("network_requests", { tab, id })).toMatch(/loaded from api/);
  });

  test("read_text markdown keeps structure and skips chrome", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/doc` });
    const text = await ok("read_text", { tab, format: "markdown", scope: "main" });
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
    expect(await ok("read_text", { tab, format: "markdown", target: "table" })).toMatch(
      /^\[page content[^\n]*\n\| Name \| Qty \|/,
    );
  });

  test("collect_pages saves markdown files", async () => {
    const text = await ok("collect_pages", {
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
    expect(records).toMatch(/"name": "alpha"/);
    expect(records).toMatch(/"when": "1970-01-01T00:00:00.000Z"/);
    const idb = await ok("storage", { tab, action: "export", area: "indexeddb" });
    const idbFile = /to (\S+\.json)/.exec(idb)?.[1] ?? "";
    const dump = JSON.parse(await readFile(idbFile, "utf8"));
    expect(dump.databases["fixture-db"].items.records[0]).toEqual({
      key: 1,
      value: { id: 1, name: "alpha", tags: ["a", "b"] },
    });
  });

  test("site_notes append, read and hint on navigation", async () => {
    expect(await ok("site_notes", { action: "read", tab })).toMatch(
      /No notes for 127\.0\.0\.1 yet/,
    );
    expect(
      await ok("site_notes", {
        action: "append",
        tab,
        note: "items API: GET /api/items?page=N,\n3 pages",
      }),
    ).toMatch(/Added a note for 127\.0\.0\.1/);
    await ok("site_notes", {
      action: "append",
      site: "http://127.0.0.1/other",
      note: "dialogs are auto-accepted",
    });
    const notes = await ok("site_notes", { action: "read", site: "127.0.0.1" });
    expect(notes).toMatch(/^# 127\.0\.0\.1$/m);
    expect(notes).toMatch(/^- \d{4}-\d{2}-\d{2}: items API: GET \/api\/items\?page=N, 3 pages$/m);
    expect(notes).toMatch(/dialogs are auto-accepted/);
    expect(await ok("navigate", { tab, url: fixture().url })).toMatch(
      /Site notes exist for 127\.0\.0\.1 \(2 lines\): read them with site_notes\./,
    );
    const opened = await ok("tab_open", { url: `${fixture().url}/article` });
    expect(opened).toMatch(/Site notes exist for 127\.0\.0\.1/);
    await ok("tab_close", { tab: /Opened (t\d+)/.exec(opened)?.[1] ?? "" });
    expect((await call("site_notes", { action: "append", tab })).isError).toBe(true);
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
      viewport: { preset: "mobile" },
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
    expect(during).toMatch(/"dark": true/);
    expect(during).toMatch(/"reduced": true/);
    expect(during).toMatch(/"zone": "Asia\/Tokyo"/);
    expect(during).toMatch(/"width": 390/);
    expect(during).toMatch(/"agent": "FixtureAgent\/1\.0"/);
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
    expect(await ok("tabs_list")).toMatch(/ask_pages adapter: fixture adapter/);
    const text = await ok("ask_pages", {
      question: "Which page mentions paragraph 7?",
      urls: [fixture().url, `${fixture().url}/article`, `${fixture().url}/doc`],
      batch_chars: 30_000,
      max_pages_per_batch: 2,
    });
    expect(text).toMatch(/^- Paragraph 7 is in the article \[02-127-0-0-1-\d+-article\.md\]$/m);
    expect(text).toMatch(/Nothing relevant in: .*01-127-0-0-1-\d+\.md/);
    expect(text).toMatch(/Adapter: fixture adapter, model claude-haiku-5-5, 2 call\(s\)/);
    expect(text).toMatch(/input tokens 2000, output tokens 40/);
    expect(text).not.toContain("Paragraph 8 of");
    const prompt = askPrompts.at(-2) ?? askPrompts.at(-1) ?? "";
    const questionAt = prompt.indexOf("<question>\nWhich page mentions paragraph 7?\n</question>");
    expect(questionAt).not.toBe(-1);
    expect(questionAt).toBeGreaterThan(prompt.lastIndexOf("</document>"));
    const file = /Full answers: (\S+\.md)/.exec(text)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toMatch(/Paragraph 7 is in the article/);

    const fromTab = await ok("ask_pages", { question: "Paragraph 7?", tabs: [tab] });
    expect(fromTab).toMatch(/No page had anything relevant|Nothing relevant in: t\d+ /);
    const dir =
      /pages into (\S+)/.exec(
        await ok("collect_pages", {
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

  test("secrets_list returns names only", async () => {
    expect(await ok("secrets_list")).toBe("fixture/site");
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
