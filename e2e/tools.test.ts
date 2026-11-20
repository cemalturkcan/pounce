import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.ts";
import type { AskAdapter } from "../src/ask.ts";
import type { SecretStore } from "../src/secrets.ts";
import { createDeps, createServer } from "../src/server.ts";
import type { ToolDeps } from "../src/tools.ts";
import { startFixture, type Fixture } from "./fixture.ts";

const TEST_SECRET = `fixture-${randomBytes(9).toString("hex")}`;

const fakeSecrets: SecretStore = {
  backend: "fake",
  list: async () => ["fixture/site"],
  get: async (name, field) => {
    assert.equal(name, "fixture/site");
    return field === "username" ? "fixture-user" : TEST_SECRET;
  },
};

const askPrompts: string[] = [];

const fakeAdapter: AskAdapter = {
  name: "fixture adapter",
  complete: async ({ prompt }) => {
    askPrompts.push(prompt);
    const documents = [...prompt.matchAll(/<document source="([^"]+)">\n([\s\S]*?)\n<\/document>/g)];
    const hits = documents.filter((match) => (match[2] ?? "").includes("Paragraph 7 of")).map((match) => `- Paragraph 7 is in the article [${match[1]}]`);
    const misses = documents.filter((match) => !(match[2] ?? "").includes("Paragraph 7 of")).map((match) => match[1]);
    return { text: [...hits, misses.length ? `NOT FOUND: ${misses.join(", ")}` : ""].join("\n"), usage: { input_tokens: 1000, output_tokens: 20 } };
  },
};

type Content = { type: string; text?: string; data?: string };
type CallResult = { text: string; isError: boolean; content: Content[] };

let fixture: Fixture;
let workDir: string;
let deps: ToolDeps;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Content[];
  return {
    text: content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n"),
    isError: result.isError === true,
    content,
  };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const result = await call(name, args);
  assert.equal(result.isError, false, `${name} failed: ${result.text}`);
  return result.text;
}

function refOf(snapshot: string, label: string) {
  const line = snapshot.split("\n").find((candidate) => candidate.includes(label));
  const ref = line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
  assert.ok(ref, `no ref for ${label} in:\n${snapshot}`);
  return ref;
}

before(async () => {
  fixture = await startFixture();
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-e2e-"));
  const config = loadConfig({
    WEB_AGENT_DATA_DIR: workDir,
    WEB_AGENT_HEADLESS: "true",
    WEB_AGENT_PASSWORD_STORE: "basic",
    WEB_AGENT_ENGINE: process.env.WEB_AGENT_ENGINE,
  });
  deps = createDeps(config, fakeSecrets, fakeAdapter);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(config, deps).connect(serverTransport);
  client = new Client({ name: "e2e", version: "0" });
  await client.connect(clientTransport);
});

after(async () => {
  await client?.close();
  await deps?.manager.shutdown();
  await fixture?.close();
  await rm(workDir, { recursive: true, force: true });
});

test("every tool and parameter is described", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 37);
  for (const tool of tools) {
    assert.ok((tool.description ?? "").length >= 60, `${tool.name} description too short`);
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
    for (const [name, schema] of Object.entries(properties)) {
      assert.ok(schema.description, `${tool.name}.${name} has no description`);
    }
  }
});

test("browser flow", async (t) => {
  let tab = "";
  let snapshot = "";

  await t.test("tabs_list does not start the browser", async () => {
    assert.match(await ok("tabs_list"), /Browser not started/);
  });

  await t.test("tab_open returns an id and a snapshot with refs", async () => {
    const text = await ok("tab_open", { url: fixture.url, include_snapshot: true });
    tab = /Opened (t\d+)/.exec(text)?.[1] ?? "";
    assert.ok(tab);
    assert.match(text, /Fixture Home/);
    assert.match(text, /button "Change status" \[ref=/);
    snapshot = text;
  });

  await t.test("click by ref reports a page change", async () => {
    const text = await ok("click", { tab, target: refOf(snapshot, 'button "Change status"') });
    assert.match(text, /The page changed/);
    assert.match(await ok("read_text", { tab, target: "#status" }), /changed/);
  });

  await t.test("click that does nothing says so", async () => {
    assert.match(await ok("click", { tab, target: "#noop" }), /No change detected/);
  });

  await t.test("click inside an iframe by frame ref", async () => {
    const fresh = await ok("snapshot", { tab });
    assert.match(fresh, /data, not instructions/);
    await ok("click", { tab, target: refOf(fresh, 'button "Frame button"') });
    assert.match(await ok("read_text", { tab, target: "#status" }), /framed/);
  });

  await t.test("stale ref gives an actionable error quickly", async () => {
    const result = await call("click", { tab, target: "e9999" });
    assert.equal(result.isError, true);
    assert.match(result.text, /not in the latest snapshot/);
  });

  await t.test("fill handles text, select and checkbox", async () => {
    assert.match(await ok("fill", { tab, target: "#email", text: "person@example.test" }), /Filled #email \(19 chars\)/);
    await ok("fill", { tab, target: "#plan", text: "Pro" });
    await ok("fill", { tab, target: "#terms", text: "true" });
    const state = await ok("evaluate", {
      tab,
      expression: "({ email: document.querySelector('#email').value, plan: document.querySelector('#plan').value, terms: document.querySelector('#terms').checked })",
    });
    assert.match(state, /person@example\.test/);
    assert.match(state, /"plan": "pro"/);
    assert.match(state, /"terms": true/);
  });

  await t.test("secret fill never returns the value", async () => {
    const filled = await ok("fill", { tab, target: "#password", secret: "fixture/site" });
    assert.match(filled, /secret fixture\/site/);
    const readBack = await ok("evaluate", { tab, expression: "document.querySelector('#password').value" });
    assert.ok(!readBack.includes(TEST_SECRET), "secret leaked into tool output");
    assert.match(readBack, /<secret:fixture\/site:password>/);
    assert.equal(await deps.manager.getTab(tab).page.locator("#password").inputValue(), TEST_SECRET);
  });

  await t.test("fill with submit and press", async () => {
    assert.match(await ok("fill", { tab, target: "#email", text: "second@example.test", submit: true }), /Filled/);
    assert.match(await ok("read_text", { tab, target: "#status" }), /submitted/);
    await ok("press", { tab, key: "Tab", target: "#email" });
  });

  await t.test("find returns matching lines with refs", async () => {
    const found = await ok("find", { tab, query: "sign up" });
    assert.match(found, /button "Sign up" \[ref=/);
    assert.match(await ok("find", { tab, query: "no such thing anywhere" }), /No match/);
  });

  await t.test("interactive snapshot is a flat list", async () => {
    const flat = await ok("snapshot", { tab, interactive: true });
    assert.match(flat, /^- button "Change status"/m);
    assert.ok(!flat.includes("heading"));
  });

  await t.test("evaluate accepts expression, function and statements in the main world", async () => {
    assert.match(await ok("evaluate", { tab, expression: "document.title" }), /Fixture Home/);
    assert.match(await ok("evaluate", { tab, expression: "() => window.appState.ready" }), /true/);
    assert.match(await ok("evaluate", { tab, expression: "const n = 20; return n + 1;" }), /21/);
    assert.match(await ok("evaluate", { tab, expression: "typeof window.appState", world: "isolated" }), /undefined|object/);
  });

  await t.test("dialogs are accepted and reported", async () => {
    assert.match(await ok("click", { tab, target: "#alert" }), /alert dialog "Careful now" was accepted/);
  });

  await t.test("console capture works on local hosts", async () => {
    const logs = await ok("console_logs", { tab });
    assert.match(logs, /boot log/);
    const errors = await ok("console_logs", { tab, level: "errors" });
    assert.match(errors, /boot error/);
    assert.ok(!errors.includes("boot log"));
  });

  await t.test("network list, detail and HAR export", async () => {
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const list = await ok("network_requests", { tab, pattern: "/api/data" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    assert.ok(id > 0, list);
    assert.match(await ok("network_requests", { tab, id }), /loaded from api/);
    const exported = await ok("network_export", { tab, pattern: "/api/" });
    const file = /to (\S+\.har)/.exec(exported)?.[1] ?? "";
    const har = JSON.parse(await readFile(file, "utf8"));
    assert.equal(har.log.version, "1.2");
    assert.ok(har.log.entries.some((entry: { response: { content: { text?: string } } }) => entry.response.content.text?.includes("loaded from api")));
  });

  await t.test("intercept modifies, mocks and blocks requests", async () => {
    assert.match(await ok("intercept", { tab, action: "add", url: "/api/echo", mode: "modify", set_headers: { "x-agent-test": "yes" } }), /Added rule #1/);
    await ok("click", { tab, target: "#echo" });
    await ok("wait_for", { tab, text: "x-agent-test" });
    assert.match(await ok("intercept", { tab, action: "list" }), /#1 .* 1 hits/);

    await ok("intercept", { tab, action: "add", url: "/api/data", mode: "mock", mock_body: JSON.stringify({ message: "mocked reply" }) });
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "mocked reply" });

    await ok("intercept", { tab, action: "add", url: "/api/data", mode: "patch_response", replacements: [{ find: "mocked", replace: "patched" }] });
    assert.match(await ok("intercept", { tab, action: "clear" }), /Removed 3 rules/);
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });

    await ok("intercept", { tab, action: "add", url: "/api/data", mode: "block" });
    await ok("click", { tab, target: "#load" });
    assert.match(await ok("network_requests", { tab, failed_only: true }), /FAILED/);
    await ok("intercept", { tab, action: "clear" });
  });

  await t.test("cookies can be set, listed, sent, exported and deleted", async () => {
    await ok("cookies", { action: "set", tab, name: "agent_cookie", value: "cookie-value-1" });
    assert.match(await ok("cookies", { action: "list", tab }), /agent_cookie=cookie-value-1/);
    await ok("click", { tab, target: "#echo" });
    await ok("wait_for", { tab, text: "agent_cookie=cookie-value-1" });
    const exported = await ok("cookies", { action: "export", tab });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    assert.equal(JSON.parse(await readFile(file, "utf8"))[0].name, "agent_cookie");
    assert.match(await ok("cookies", { action: "delete", name: "agent_cookie" }), /Deleted 1 cookies/);
    assert.match(await ok("cookies", { action: "list", tab }), /No matching cookies/);
  });

  await t.test("upload attaches a file", async () => {
    const file = path.join(workDir, "avatar.txt");
    await writeFile(file, "avatar");
    await ok("upload", { tab, target: "#avatar", paths: [file] });
    assert.match(await ok("evaluate", { tab, expression: "document.querySelector('#avatar').files[0].name" }), /avatar\.txt/);
    assert.equal((await call("upload", { tab, target: "#avatar", paths: ["/nonexistent/file.txt"] })).isError, true);
  });

  await t.test("downloads are saved and reported", async () => {
    const text = await ok("click", { tab, target: "#download" });
    const reported = /download saved to (\S+)/.exec(text)?.[1] ?? /download saved to (\S+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1];
    assert.ok(reported, text);
    assert.equal(await readFile(reported, "utf8"), "a,b\n1,2\n");
  });

  await t.test("screenshot returns an inline image and a file", async () => {
    const result = await call("screenshot", { tab });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.content.some((part) => part.type === "image" && (part.data?.length ?? 0) > 1000));
    assert.match(result.text, /saved to \S+\.jpg/);
  });

  await t.test("navigation by click and read_text paging", async () => {
    assert.match(await ok("click", { tab, target: "text=Read the article" }), /Navigated to .*\/article "Fixture Article"/);
    const page = await ok("read_text", { tab, scope: "main", max_chars: 500 });
    assert.match(page, /Long Article/);
    assert.ok(!page.includes("Navigation chrome"));
    const offset = Number(/pass offset=(\d+)/.exec(page)?.[1]);
    assert.equal(offset, 500);
    assert.match(await ok("read_text", { tab, scope: "main", offset, max_chars: 300 }), /chars 500-800 of/);
  });

  await t.test("large snapshots are clipped and saved to a file", async () => {
    const clipped = await ok("snapshot", { tab, max_chars: 1500 });
    const file = /saved to (\S+\.yml)/.exec(clipped)?.[1] ?? "";
    assert.match(await readFile(file, "utf8"), /Paragraph 399/);
  });

  await t.test("navigate back and to a missing page", async () => {
    assert.match(await ok("navigate", { tab, url: "back" }), /Fixture Home/);
    assert.match(await ok("navigate", { tab, url: `${fixture.url}/missing` }), /HTTP 404/);
    await ok("navigate", { tab, url: fixture.url });
  });

  await t.test("run_script drives several tabs in one call", async () => {
    const text = await ok("run_script", {
      tab,
      code: `
        const titles = [await page.title()];
        for (const route of ["/article", "/missing"]) {
          const opened = await openTab("${fixture.url}" + route);
          titles.push(await opened.title());
          log("visited", route, tabId(opened));
          await closeTab(opened);
        }
        const api = await context.request.get("${fixture.url}/api/data");
        const file = await save("titles.json", JSON.stringify(titles));
        return { titles, api: (await api.json()).message, file, words: (await text(page)).split(" ").length > 3 };
      `,
    });
    assert.match(text, /"Fixture Home"/);
    assert.match(text, /"Fixture Article"/);
    assert.match(text, /loaded from api/);
    assert.match(text, /visited \/article t\d+/);
    const file = /"file": "([^"]+)"/.exec(text)?.[1] ?? "";
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["Fixture Home", "Fixture Article", "Missing"]);
  });

  await t.test("run_script reports errors, logs and timeouts", async () => {
    const failed = await call("run_script", { tab, code: "log('step one'); throw new Error('boom');" });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /boom/);
    assert.match(failed.text, /step one/);
    const slow = await call("run_script", { tab, code: "await sleep(5000);", timeout_ms: 1000 });
    assert.equal(slow.isError, true);
    assert.match(slow.text, /timed out after 1000 ms/);
    const secret = await ok("run_script", { tab, code: "await secrets.fill('#password', 'fixture/site'); return await page.locator('#password').inputValue();" });
    assert.ok(!secret.includes(TEST_SECRET));
  });

  await t.test("collect_pages writes files and returns only an index", async () => {
    const text = await ok("collect_pages", {
      urls: [fixture.url, `${fixture.url}/article`, "http://127.0.0.1:1/unreachable"],
      include: ["text", "links", "screenshot", "snapshot"],
      settle_ms: 0,
      label: "fixture",
    });
    assert.match(text, /Collected 2 of 3 pages into (\S+)/);
    assert.match(text, /03 FAILED/);
    assert.ok(text.length < 2500, `index too large: ${text.length}`);
    const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
    const files = await readdir(dir);
    assert.equal(files.filter((file) => file.endsWith(".jpg")).length, 2);
    assert.equal(files.filter((file) => file.endsWith(".snapshot.yml")).length, 2);
    const article = files.find((file) => file.startsWith("02-") && file.endsWith(".txt")) ?? "";
    assert.match(await readFile(path.join(dir, article), "utf8"), /Paragraph 399/);
    const links = files.find((file) => file.startsWith("01-") && file.endsWith(".links.tsv")) ?? "";
    assert.match(await readFile(path.join(dir, links), "utf8"), /\/article\tRead the article/);
  });

  await t.test("popups become tabs and tabs can be closed", async () => {
    const text = await ok("click", { tab, target: "#popup" });
    const popup = /opened new tab (t\d+)/.exec(text)?.[1] ?? /opened new tab (t\d+)/.exec(await ok("press", { tab, key: "Shift" }))?.[1] ?? "";
    assert.ok(popup, text);
    assert.match(await ok("tabs_list"), new RegExp(`${popup} \\[yours\\] .*\\/article`));
    await ok("tab_close", { tab: popup });
    const gone = await call("snapshot", { tab: popup });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /is not open/);
  });

  await t.test("missing selector fails within the timeout with a hint", async () => {
    const started = Date.now();
    const result = await call("click", { tab, target: "#does-not-exist", timeout_ms: 1500 });
    assert.equal(result.isError, true);
    assert.ok(Date.now() - started < 5000);
    assert.match(result.text, /Take a snapshot/);
  });

  await t.test("include_diff reports only changed lines", async () => {
    await ok("navigate", { tab, url: fixture.url });
    const text = await ok("click", { tab, target: "#change", include_diff: true });
    assert.match(text, /Snapshot changes/);
    assert.match(text, /\+ .*changed/);
    assert.ok(text.length < 800, `diff too large: ${text.length}`);
  });

  await t.test("fill_form fills in order, reports invalid fields and submits", async () => {
    const text = await ok("fill_form", {
      tab,
      fields: [
        { target: "#name2", text: "Ada" },
        { target: "#age2", text: "12" },
      ],
    });
    assert.match(text, /Filled #name2 \(3 chars\)/);
    assert.match(text, /Invalid: #age2/);
    await ok("fill_form", { tab, fields: [{ target: "#age2", text: "30" }], submit: "#submit2" });
    assert.match(await ok("read_text", { tab, target: "#status" }), /form2 Ada/);
    const failed = await call("fill_form", { tab, fields: [{ target: "#name2", text: "x" }, { target: "#nope", text: "y", }] });
    assert.equal(failed.isError, true);
    assert.match(failed.text, /Filled 1 of 2 fields, then #nope failed/);
  });

  await t.test("extract returns json-ld, meta and tables as csv", async () => {
    const text = await ok("extract", { tab });
    assert.match(text, /product "Fixture Lamp" · price 49\.90 EUR · InStock/);
    assert.match(text, /"og:title": "Fixture OG Title"/);
    const csv = /"file": "([^"]+\.csv)"/.exec(text)?.[1] ?? "";
    assert.equal(await readFile(csv, "utf8"), 'Item,Price\n"Lamp, large",49.90\nBulb,3.10');
  });

  await t.test("request calls APIs with the session and replays captured requests", async () => {
    await ok("cookies", { action: "set", tab, name: "sess", value: "abc123" });
    const direct = await ok("request", { url: `${fixture.url}/api/items`, query: { page: "2" } });
    assert.match(direct, /HTTP 200/);
    assert.match(direct, /item-2-a/);
    assert.match(direct, /sess=abc123/);
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const id = Number(/#(\d+) GET 200/.exec(await ok("network_requests", { tab, pattern: "/api/data" }))?.[1]);
    const replayed = await ok("request", { tab, from_request: id, url: `${fixture.url}/api/items?page=3` });
    assert.match(replayed, /item-3-b/);
    const inPage = await ok("request", { tab, url: "/api/items?page=1".replace(/^/, fixture.url), via: "page" });
    assert.match(inPage, /item-1-a/);
    await ok("cookies", { action: "delete", name: "sess" });
  });

  await t.test("save_page writes pdf, mhtml and html", async () => {
    for (const format of ["pdf", "mhtml", "html"]) {
      const text = await ok("save_page", { tab, format });
      const file = new RegExp(`to (\\S+\\.${format})`).exec(text)?.[1] ?? "";
      const head = (await readFile(file)).subarray(0, 60).toString("latin1");
      if (format === "pdf") assert.match(head, /^%PDF/);
      if (format === "mhtml") assert.match(head, /From: |MIME-Version|Snapshot-Content-Location/i);
      if (format === "html") assert.match(head, /<html|<!DOCTYPE/i);
    }
  });

  await t.test("handoff waits for the condition and times out with guidance", async () => {
    await ok("click", { tab, target: "#later" });
    assert.match(await ok("handoff", { tab, message: "Complete the check", until_text: "Verified by human", timeout_ms: 8000 }), /completed the step/);
    const late = await call("handoff", { tab, message: "Never happens", until_text: "nothing like this", timeout_ms: 5000 });
    assert.equal(late.isError, true);
    assert.match(late.text, /has not completed the step/);
  });

  await t.test("background jobs run, log, finish and cancel", async () => {
    const started = await ok("run_script", {
      background: true,
      label: "paginate",
      code: `
        const all = [];
        for (let n = 1; ; n += 1) {
          const body = await (await context.request.get("${fixture.url}/api/items?page=" + n)).json();
          if (body.items.length === 0) break;
          all.push(...body.items);
          log("page", n);
        }
        return all;
      `,
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    let status = "";
    for (let attempt = 0; attempt < 40 && !/ done /.test(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await ok("jobs", { action: "status", id });
    }
    assert.match(status, / done /);
    assert.match(status, /page 3/);
    const resultFile = /Result: (\S+)/.exec(status)?.[1] ?? "";
    assert.deepEqual(JSON.parse(await readFile(resultFile, "utf8")), ["item-1-a", "item-1-b", "item-2-a", "item-2-b", "item-3-a", "item-3-b"]);

    const slow = await ok("run_script", { background: true, code: "const p = await openTab('about:blank'); log('opened', tabId(p)); await sleep(60000);" });
    const slowId = /job (j\d+)/.exec(slow)?.[1] ?? "";
    await new Promise((resolve) => setTimeout(resolve, 500));
    const opened = /opened (t\d+)/.exec(await ok("jobs", { action: "status", id: slowId }))?.[1] ?? "";
    assert.ok(opened);
    assert.match(await ok("jobs", { action: "cancel", id: slowId }), / cancelled /);
    assert.match(await ok("jobs", { action: "list" }), new RegExp(`${slowId} cancelled`));
    assert.equal((await call("snapshot", { tab: opened })).isError, true);
  });

  await t.test("collect_pages structured part adds product data to the index", async () => {
    const text = await ok("collect_pages", { urls: [fixture.url], include: ["structured"], settle_ms: 0 });
    assert.match(text, /product "Fixture Lamp" · price 49\.90 EUR/);
  });

  await t.test("network body survives navigation", async () => {
    await ok("navigate", { tab, url: fixture.url });
    await ok("click", { tab, target: "#load" });
    await ok("wait_for", { tab, text: "loaded from api" });
    const id = Number(/#(\d+) GET 200/.exec(await ok("network_requests", { tab, pattern: "/api/data" }))?.[1]);
    await ok("navigate", { tab, url: `${fixture.url}/article` });
    assert.match(await ok("network_requests", { tab, id }), /loaded from api/);
  });

  await t.test("read_text markdown keeps structure and skips chrome", async () => {
    await ok("navigate", { tab, url: `${fixture.url}/doc` });
    const text = await ok("read_text", { tab, format: "markdown", scope: "main" });
    assert.match(text, /^# Doc Title$/m);
    assert.match(text, /^## Steps$/m);
    assert.match(text, /\[the article link\]\(http:\/\/127\.0\.0\.1:\d+\/article\)/);
    assert.match(text, /\*\*bold words\*\*/);
    assert.match(text, /^- First step\n {2}- Nested detail\n- Second step$/m);
    assert.match(text, /^1\. One\n2\. Two$/m);
    assert.match(text, /```js\nconst answer = 42;\nconsole\.log\(answer\);\n```/);
    assert.match(text, /\| Name \| Qty \|\n\| --- \| --- \|\n\| Bolt \| 7 \|\n\| Nut \\\| small \| 9 \|/);
    for (const chrome of ["Hidden secret text", "Sidebar chrome", "Doc footer chrome", "Doc navigation chrome", "localStorage"]) {
      assert.ok(!text.includes(chrome), `${chrome} leaked into markdown:\n${text}`);
    }
    assert.match(await ok("read_text", { tab, format: "markdown", target: "table" }), /^\[page content[^\n]*\n\| Name \| Qty \|/);
  });

  await t.test("collect_pages saves markdown files", async () => {
    const text = await ok("collect_pages", { urls: [`${fixture.url}/doc`], include: ["markdown"], settle_ms: 0 });
    const dir = /pages into (\S+)/.exec(text)?.[1] ?? "";
    const file = (await readdir(dir)).find((name) => name.endsWith(".md")) ?? "";
    assert.match(file, /^01-.*\.md$/);
    const markdown = await readFile(path.join(dir, file), "utf8");
    assert.match(markdown, /^<!-- URL: .*\/doc/);
    assert.match(markdown, /```js/);
  });

  await t.test("storage lists, gets and exports local, session and IndexedDB data", async () => {
    await ok("wait_for", { tab, text: "idb ready" });
    const local = await ok("storage", { tab, action: "list", area: "local" });
    assert.match(local, /auth_token \(44 chars\)/);
    assert.match(local, /prefs \(16 chars\)/);
    assert.match(await ok("storage", { tab, action: "get", area: "local", key: "auth_token" }), /tok-x{40}/);
    assert.match(await ok("storage", { tab, action: "list", area: "session" }), /tab_state \(2 chars\)/);
    const missing = await call("storage", { tab, action: "get", area: "local", key: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no key "nope"/);
    const exported = await ok("storage", { tab, action: "export", area: "local" });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    assert.equal(JSON.parse(await readFile(file, "utf8")).entries.prefs, '{"theme":"dark"}');

    assert.match(await ok("storage", { tab, action: "list", area: "indexeddb" }), /fixture-db\/items \(2 records\)/);
    const records = await ok("storage", { tab, action: "get", area: "indexeddb", key: "items" });
    assert.match(records, /"name": "alpha"/);
    assert.match(records, /"when": "1970-01-01T00:00:00.000Z"/);
    const idb = await ok("storage", { tab, action: "export", area: "indexeddb" });
    const idbFile = /to (\S+\.json)/.exec(idb)?.[1] ?? "";
    const dump = JSON.parse(await readFile(idbFile, "utf8"));
    assert.deepEqual(dump.databases["fixture-db"].items.records[0], { key: 1, value: { id: 1, name: "alpha", tags: ["a", "b"] } });
  });

  await t.test("site_notes append, read and hint on navigation", async () => {
    assert.match(await ok("site_notes", { action: "read", tab }), /No notes for 127\.0\.0\.1 yet/);
    assert.match(await ok("site_notes", { action: "append", tab, note: "items API: GET /api/items?page=N,\n3 pages" }), /Added a note for 127\.0\.0\.1/);
    await ok("site_notes", { action: "append", site: "http://127.0.0.1/other", note: "dialogs are auto-accepted" });
    const notes = await ok("site_notes", { action: "read", site: "127.0.0.1" });
    assert.match(notes, /^# 127\.0\.0\.1$/m);
    assert.match(notes, /^- \d{4}-\d{2}-\d{2}: items API: GET \/api\/items\?page=N, 3 pages$/m);
    assert.match(notes, /dialogs are auto-accepted/);
    assert.match(await ok("navigate", { tab, url: fixture.url }), /Site notes exist for 127\.0\.0\.1 \(2 lines\): read them with site_notes\./);
    const opened = await ok("tab_open", { url: `${fixture.url}/article` });
    assert.match(opened, /Site notes exist for 127\.0\.0\.1/);
    await ok("tab_close", { tab: /Opened (t\d+)/.exec(opened)?.[1] ?? "" });
    assert.equal((await call("site_notes", { action: "append", tab })).isError, true);
  });

  await t.test("dismiss_overlays rejects cookie banners, closes modals and handles iframes", async () => {
    await ok("navigate", { tab, url: `${fixture.url}/consent` });
    const text = await ok("dismiss_overlays", { tab });
    assert.match(text, /Clicked "reject all" \(reject\) in #cookie-banner, main frame/);
    assert.match(text, /Clicked "kapat" \(close\)/);
    assert.match(text, /Clicked "alle ablehnen" \(reject\) in #consent, frame/);
    const state = await ok("evaluate", {
      tab,
      expression: "[...['status', 'modal-state', 'frame-state']].map((id) => document.getElementById(id).textContent).join('|')",
    });
    assert.match(state, /rejected\|modal closed\|frame rejected/);
    assert.match(await ok("dismiss_overlays", { tab }), /No cookie banner or modal/);
  });

  await t.test("emulate sets and resets per-tab conditions", async () => {
    await ok("navigate", { tab, url: fixture.url });
    const probe = `(async () => ({
      dark: matchMedia('(prefers-color-scheme: dark)').matches,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      width: screen.width,
      touch: navigator.maxTouchPoints,
      agent: navigator.userAgent,
      online: navigator.onLine,
    }))()`;
    const before = JSON.parse((await ok("evaluate", { tab, expression: probe })).split("\n").slice(1).join("\n"));
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
    assert.match(set, /viewport 390x844 @3x mobile\+touch/);
    assert.match(set, /permission granted to http:\/\/127\.0\.0\.1/);
    const during = await ok("evaluate", { tab, expression: probe });
    assert.match(during, /"dark": true/);
    assert.match(during, /"reduced": true/);
    assert.match(during, /"zone": "Asia\/Tokyo"/);
    assert.match(during, /"width": 390/);
    assert.match(during, /"agent": "FixtureAgent\/1\.0"/);
    const position = await ok("evaluate", {
      tab,
      expression: "new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition((p) => resolve([p.coords.latitude, p.coords.longitude]), (e) => reject(new Error(e.message)), { timeout: 5000 }))",
    });
    assert.match(position, /41\.01[\s\S]*28\.97/);
    assert.match(await ok("evaluate", { tab, expression: "new Intl.NumberFormat().format(1234.5)" }), /1\.234,5/);
    const echoed = await ok("request", { tab, url: `${fixture.url}/api/echo`, via: "page" });
    assert.match(echoed, /"accept-language":\s*"de-DE/);

    await ok("emulate", { tab, network: "fast3g" });
    const slow = await ok("evaluate", { tab, expression: "(async () => { const t = performance.now(); await fetch('/api/data?slow=' + Math.random()); return performance.now() - t; })()" });
    assert.ok(Number(slow.split("\n").at(-1)) > 400, `throttled fetch was fast: ${slow}`);
    const offline = await ok("emulate", { tab, offline: true, network: "none" });
    assert.match(offline, /offline yes/);
    assert.match(await ok("evaluate", { tab, expression: "fetch('/api/data?o=' + Math.random()).then(() => 'reached', () => 'blocked')" }), /blocked/);
    assert.match(await ok("evaluate", { tab, expression: "navigator.onLine" }), /false/);

    const reset = await ok("emulate", { tab, reset: true });
    assert.match(reset, /Cleared: .*viewport.*offline/);
    assert.match(reset, /No emulation is active/);
    const after = JSON.parse((await ok("evaluate", { tab, expression: probe })).split("\n").slice(1).join("\n"));
    assert.deepEqual(after, before);
    assert.match(await ok("evaluate", { tab, expression: "fetch('/api/data?r=' + Math.random()).then(() => 'reached', () => 'blocked')" }), /reached/);
  });

  await t.test("ask_pages answers over collected pages, tabs and folders through the adapter", async () => {
    assert.match(await ok("tabs_list"), /ask_pages adapter: claude CLI/);
    const text = await ok("ask_pages", { question: "Which page mentions paragraph 7?", urls: [fixture.url, `${fixture.url}/article`, `${fixture.url}/doc`], batch_chars: 30_000, max_pages_per_batch: 2 });
    assert.match(text, /^- Paragraph 7 is in the article \[02-127-0-0-1-\d+-article\.md\]$/m);
    assert.match(text, /Nothing relevant in: .*01-127-0-0-1-\d+\.md/);
    assert.match(text, /Adapter: fixture adapter, model haiku, 2 call\(s\)/);
    assert.match(text, /input tokens 2000, output tokens 40/);
    assert.ok(!text.includes("Paragraph 8 of"), "page content leaked into the result");
    assert.match(askPrompts.at(-2) ?? askPrompts.at(-1) ?? "", /<question>\nWhich page mentions paragraph 7\?\n<\/question>$/);
    const file = /Full answers: (\S+\.md)/.exec(text)?.[1] ?? "";
    assert.match(await readFile(file, "utf8"), /Paragraph 7 is in the article/);

    const fromTab = await ok("ask_pages", { question: "Paragraph 7?", tabs: [tab] });
    assert.match(fromTab, /No page had anything relevant|Nothing relevant in: t\d+ /);
    const dir = /pages into (\S+)/.exec(await ok("collect_pages", { urls: [`${fixture.url}/article`], include: ["text"], settle_ms: 0 }))?.[1] ?? "";
    assert.match(await ok("ask_pages", { question: "Paragraph 7?", dir }), /\[01-.*-article\.txt\]/);
    assert.equal((await call("ask_pages", { question: "Paragraph 7?", dir, tabs: [tab] })).isError, true);
  });

  await t.test("secrets_list returns names only", async () => {
    assert.equal(await ok("secrets_list"), "fixture/site");
  });
});
