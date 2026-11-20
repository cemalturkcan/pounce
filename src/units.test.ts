import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeUrl } from "./collect.ts";
import { loadConfig, parseLaunchArgs } from "./config.ts";
import { isAllowedHost, isAllowedOrigin } from "./daemon.ts";
import { describeError, ToolError } from "./errors.ts";
import { clipHeadTail, clipWindow, Redactor, slugify } from "./output.ts";
import { GopassStore, parseEntry } from "./secrets.ts";
import { countNoteLines, siteHost } from "./sites.ts";
import { buildMatcher, findInSnapshot, interactiveOnly, parseRef } from "./snapshot.ts";

const SNAPSHOT = [
  '- generic [ref=e1]:',
  '  - heading "Shop" [level=1] [ref=e2]',
  '  - navigation [ref=e3]:',
  '    - link "Cart" [ref=e4] [cursor=pointer]:',
  '      - /url: /cart',
  '  - main [ref=e5]:',
  '    - textbox "Search" [ref=e6]',
  '    - button "Add to cart" [ref=e7]',
  '    - iframe [ref=e8]:',
  '      - button "Pay" [ref=f1e2]',
].join("\n");

test("parseRef accepts refs in the forms a model writes them", () => {
  assert.equal(parseRef("e12"), "e12");
  assert.equal(parseRef(" f1e3 "), "f1e3");
  assert.equal(parseRef("@e4"), "e4");
  assert.equal(parseRef("[ref=e7]"), "e7");
  assert.equal(parseRef("ref=e7"), "e7");
  assert.equal(parseRef("#email"), undefined);
  assert.equal(parseRef("text=e12 items"), undefined);
  assert.equal(parseRef("element"), undefined);
});

test("interactiveOnly keeps a flat list of actionable elements", () => {
  assert.equal(
    interactiveOnly(SNAPSHOT),
    ['- link "Cart" [ref=e4] [cursor=pointer]', '- textbox "Search" [ref=e6]', '- button "Add to cart" [ref=e7]', '- button "Pay" [ref=f1e2]'].join("\n"),
  );
});

test("findInSnapshot returns matches with their ancestors and counts overflow", () => {
  const found = findInSnapshot(SNAPSHOT, buildMatcher("pay", false), 10);
  assert.equal(found.matches, 1);
  assert.equal(found.text, ['- generic [ref=e1]:', '  - main [ref=e5]:', '    - iframe [ref=e8]:', '      - button "Pay" [ref=f1e2]'].join("\n"));
  const limited = findInSnapshot(SNAPSHOT, buildMatcher("^\\s*- (button|link)", true), 1);
  assert.equal(limited.matches, 3);
  assert.equal(limited.shown, 1);
});

test("clipHeadTail keeps both ends on line boundaries", () => {
  const text = Array.from({ length: 100 }, (_value, index) => `line ${index}`).join("\n");
  const clipped = clipHeadTail(text, 200);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.totalChars, text.length);
  assert.match(clipped.text, /^line 0\n/);
  assert.match(clipped.text, /line 99$/);
  assert.match(clipped.text, /chars omitted/);
  assert.equal(clipHeadTail("short", 200).truncated, false);
});

test("clipWindow pages through text", () => {
  const first = clipWindow("abcdefghij", 0, 4);
  assert.deepEqual([first.text, first.end, first.hasMore], ["abcd", 4, true]);
  const last = clipWindow("abcdefghij", 8, 4);
  assert.deepEqual([last.text, last.end, last.hasMore], ["ij", 10, false]);
  assert.equal(clipWindow("abc", 99, 4).text, "");
});

test("Redactor masks registered values and ignores trivial ones", () => {
  const redactor = new Redactor();
  redactor.register("site:password", "hunter2-long");
  redactor.register("site:pin", "12");
  assert.equal(redactor.redact("value=hunter2-long and 12"), "value=<secret:site:password> and 12");
});

test("slugify makes file-safe names", () => {
  assert.equal(slugify("https://Example.com/a/b?c=1"), "example-com-a-b-c-1");
  assert.equal(slugify("???"), "page");
});

test("normalizeUrl adds a scheme only when missing", () => {
  assert.equal(normalizeUrl("example.com/x"), "https://example.com/x");
  assert.equal(normalizeUrl(" http://localhost:3000 "), "http://localhost:3000");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
});

test("host and origin validation only accepts the loopback endpoint", () => {
  assert.equal(isAllowedHost("127.0.0.1:29741", 29741), true);
  assert.equal(isAllowedHost("localhost:29741", 29741), true);
  assert.equal(isAllowedHost("evil.example", 29741), false);
  assert.equal(isAllowedHost("evil.example:29741", 29741), false);
  assert.equal(isAllowedHost("127.0.0.1:8080", 29741), false);
  assert.equal(isAllowedHost(undefined, 29741), false);
  assert.equal(isAllowedOrigin(undefined, 29741), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:29741", 29741), true);
  assert.equal(isAllowedOrigin("https://evil.example", 29741), false);
  assert.equal(isAllowedOrigin("null", 29741), false);
});

test("describeError keeps the call log tail and adds a next step", () => {
  const error = new Error(
    ["locator.click: Timeout 1500ms exceeded.", "Call log:", "  - waiting for locator('#buy')", "  - <div class=\"overlay\"> intercepts pointer events", "  - retrying click action"].join("\n"),
  );
  const text = describeError(error);
  assert.match(text, /^locator\.click: Timeout 1500ms exceeded\./);
  assert.match(text, /intercepts pointer events/);
  assert.match(text, /Another element covers the target/);
  assert.equal(describeError(new ToolError("Bad input.", "Do this instead.")), "Bad input.\nDo this instead.");
  assert.equal(describeError("plain"), "plain");
});

test("config reads launch args and defaults", () => {
  assert.deepEqual(parseLaunchArgs("--disable-features=A,B --lang=tr"), ["--disable-features=A,B", "--lang=tr"]);
  assert.deepEqual(parseLaunchArgs(undefined), []);
  const config = loadConfig({ WEB_AGENT_DAEMON_DATA_DIR: "/data", WEB_AGENT_DAEMON_PORT: "4000" });
  assert.equal(config.profileDir, "/data/profile");
  assert.equal(config.outputDir, "/data/output");
  assert.equal(config.sitesDir, "/data/sites");
  assert.equal(config.endpoint, "http://127.0.0.1:4000/mcp");
  assert.equal(config.engine, "patchright");
  assert.equal(config.headless, true);
  assert.equal(loadConfig({ DISPLAY: ":0" }).headless, false);
  assert.throws(() => loadConfig({ WEB_AGENT_DAEMON_PORT: "abc" }), /Invalid WEB_AGENT_DAEMON_PORT/);
});

test("parseEntry splits the password line from key-value fields", () => {
  const entry = parseEntry("s3cret-value\nusername: person@example.test\nurl: https://example.test/login\nnote without colon\n");
  assert.equal(entry.password, "s3cret-value");
  assert.equal(entry.fields.get("username"), "person@example.test");
  assert.equal(entry.fields.get("url"), "https://example.test/login");
});

test("GopassStore resolves fields without a shell and rejects option-like names", async () => {
  const calls: string[][] = [];
  const store = new GopassStore(async (args) => {
    calls.push(args);
    if (args[0] === "ls") return "web/shop\nweb/mail\n";
    if (args[0] === "otp") return "123456\n";
    return "pw-value\nlogin: shopper\n";
  });
  assert.deepEqual(await store.list("SHOP"), ["web/shop"]);
  assert.equal(await store.get("web/shop", "password"), "pw-value");
  assert.equal(await store.get("web/shop", "username"), "shopper");
  assert.equal(await store.get("web/shop", "otp"), "123456");
  assert.deepEqual(calls.at(-1), ["otp", "-o", "--", "web/shop"]);
  await assert.rejects(store.get("web/shop", "pin"), /has no pin field/);
  await assert.rejects(store.get("--clip", "password"), /Invalid secret name/);
});

test("siteHost normalises hosts and URLs into file-safe names", () => {
  assert.equal(siteHost("https://www.Shop.example.com/a?b=1"), "shop.example.com");
  assert.equal(siteHost("shop.example.com"), "shop.example.com");
  assert.equal(siteHost("http://localhost:3000/x"), "localhost");
  assert.throws(() => siteHost("about:blank"), /no usable host name|not a host/);
  assert.equal(countNoteLines("# host\n\n- 2026-01-01: a\n- 2026-01-02: b\n"), 2);
});
