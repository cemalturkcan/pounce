import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runPool, TIMED_OUT, untilAborted, withDeadline } from "./async.ts";
import { normalizeUrl } from "./collect.ts";
import { loadConfig, parseLaunchArgs } from "./config.ts";
import { isAllowedHost, isAllowedOrigin, isDaemonProcess } from "./daemon.ts";
import { synthesizeMetadata } from "./emulate.ts";
import { describeError, ToolError } from "./errors.ts";
import { isStreamingMime, isTextualMime } from "./mime.ts";
import { clipHeadTail, clipWindow, OutputStore, Redactor, slugify } from "./output.ts";
import { registerSecret } from "./script.ts";
import { GopassStore, parseEntry } from "./secrets.ts";
import { countNoteLines, siteHost } from "./sites.ts";
import { buildMatcher, cutSubtree, findInSnapshot, interactiveOnly, limitDepth, parseRef, topLevelRefs } from "./snapshot.ts";
import { cookieDomainMatches, evaluationSource } from "./tools.ts";
import { PACKAGE_DIR, SERVER_VERSION } from "./version.ts";

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

test("Redactor masks JSON-escaped and URL-encoded forms", () => {
  const redactor = new Redactor();
  const value = 'p@ss "word"/ä &x';
  redactor.register("site:password", value);
  assert.equal(redactor.redact(JSON.stringify({ password: value })), '{"password":"<secret:site:password>"}');
  assert.equal(redactor.redact(`a=${encodeURIComponent(value)}&b=1`), "a=<secret:site:password>&b=1");
  assert.equal(redactor.redact(`a=${encodeURIComponent(value).replace(/%20/g, "+")}`), "a=<secret:site:password>");
});

test("Redactor drops values once their time to live has passed", () => {
  let now = 1000;
  const redactor = new Redactor(() => now);
  redactor.register("site:otp", "123456", 120_000);
  assert.equal(redactor.redact("code 123456"), "code <secret:site:otp>");
  now += 120_001;
  assert.equal(redactor.redact("order 123456"), "order 123456");
});

test("registerSecret masks passwords and custom fields, OTPs briefly, usernames never", () => {
  let now = 0;
  const redactor = new Redactor(() => now);
  registerSecret(redactor, "site", "password", "pw-secret-1");
  registerSecret(redactor, "site", "username", "person@example.test");
  registerSecret(redactor, "site", "api_key", "key-secret-2");
  registerSecret(redactor, "site", "otp", "654321");
  assert.equal(redactor.redact("pw-secret-1 person@example.test key-secret-2 654321"), "<secret:site:password> person@example.test <secret:site:api_key> <secret:site:otp>");
  now += 3 * 60 * 1000;
  assert.match(redactor.redact("654321 pw-secret-1"), /^654321 <secret:site:password>$/);
});

test("OutputStore redacts text files unless raw, and prune keeps durable kinds", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-store-"));
  try {
    const redactor = new Redactor();
    redactor.register("site:password", "pw-secret-9");
    const store = new OutputStore(root, redactor);
    assert.equal(await readFile(await store.write("evaluate", "a.txt", "x pw-secret-9 y"), "utf8"), "x <secret:site:password> y");
    assert.equal(await readFile(await store.write("har", "a.har", "pw-secret-9", { raw: true }), "utf8"), "pw-secret-9");
    assert.equal((await readFile(await store.write("screenshots", "a.bin", Buffer.from("pw-secret-9")))).toString(), "pw-secret-9");
    for (const kind of ["pages", "downloads", "cookies", "har", "extract", "snapshots", "collect"]) {
      await mkdir(path.join(root, kind), { recursive: true });
      const file = path.join(root, kind, "old.txt");
      await writeFile(file, "old");
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      await utimes(file, old, old);
    }
    await store.prune();
    for (const kind of ["pages", "downloads", "cookies", "har", "extract"]) assert.deepEqual(await readdir(path.join(root, kind)).then((names) => names.includes("old.txt")), true, kind);
    for (const kind of ["snapshots", "collect"]) assert.deepEqual(await readdir(path.join(root, kind)), [], kind);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("slugify makes file-safe names", () => {
  assert.equal(slugify("https://Example.com/a/b?c=1"), "example-com-a-b-c-1");
  assert.equal(slugify("???"), "page");
});

test("normalizeUrl adds a scheme only when missing", () => {
  assert.equal(normalizeUrl("example.com/x"), "https://example.com/x");
  assert.equal(normalizeUrl(" http://localhost:3000 "), "http://localhost:3000");
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("mailto:a@example.com"), "mailto:a@example.com");
});

test("normalizeUrl treats host:port as a URL, http for local hosts", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("localhost:3000/a?b=1"), "http://localhost:3000/a?b=1");
  assert.equal(normalizeUrl("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
  assert.equal(normalizeUrl("[::1]:3000"), "http://[::1]:3000");
  assert.equal(normalizeUrl("app.localhost:5173"), "http://app.localhost:5173");
  assert.equal(normalizeUrl("192.168.1.10:9000"), "http://192.168.1.10:9000");
  assert.equal(normalizeUrl("10.0.0.2"), "http://10.0.0.2");
  assert.equal(normalizeUrl("example.com:8443/api"), "https://example.com:8443/api");
  assert.equal(normalizeUrl("172.32.0.1:80"), "https://172.32.0.1:80");
});

test("scoped snapshot helpers cut a subtree and keep its refs", () => {
  assert.equal(cutSubtree(SNAPSHOT, "e5"), ['- main [ref=e5]:', '  - textbox "Search" [ref=e6]', '  - button "Add to cart" [ref=e7]', '  - iframe [ref=e8]:', '    - button "Pay" [ref=f1e2]'].join("\n"));
  assert.equal(cutSubtree(SNAPSHOT, "e4"), ['- link "Cart" [ref=e4] [cursor=pointer]:', '  - /url: /cart'].join("\n"));
  assert.equal(cutSubtree(SNAPSHOT, "e99"), undefined);
  assert.equal(limitDepth(cutSubtree(SNAPSHOT, "e5") ?? "", 1), "- main [ref=e5]:");
  assert.deepEqual(topLevelRefs(['  - textbox "A" [ref=e3]', '    - text: x', '  - button "B" [ref=e9]'].join("\n")), ["e3", "e9"]);
});

test("cookie delete matches a domain exactly or by subdomain", () => {
  assert.equal(cookieDomainMatches(".x.com", "x.com"), true);
  assert.equal(cookieDomainMatches("x.com", ".x.com"), true);
  assert.equal(cookieDomainMatches("api.x.com", "x.com"), true);
  assert.equal(cookieDomainMatches(".netflix.com", "x.com"), false);
  assert.equal(cookieDomainMatches("box.com", "x.com"), false);
});

test("evaluationSource picks expression or statements by parsing, not by running", () => {
  assert.match(evaluationSource("document.title"), /const value = \(document\.title/);
  assert.match(evaluationSource("() => 1"), /const value = \(\(\) => 1/);
  assert.match(evaluationSource("const n = 1; return n;"), /^\(async \(\) => \{\nconst n = 1; return n;\n\}\)\(\)$/);
  assert.match(evaluationSource("JSON.parse('{')"), /const value = /);
  assert.throws(() => evaluationSource("return ("), /does not parse/);
});

test("textual and streaming MIME detection", () => {
  for (const type of ["text/html; charset=utf-8", "application/json", "application/ld+json", "application/vnd.api+json", "application/xml", "image/svg+xml", "application/javascript"]) {
    assert.equal(isTextualMime(type), true, type);
  }
  for (const type of ["image/png", "application/octet-stream", "application/pdf", "", undefined]) assert.equal(isTextualMime(type), false, String(type));
  assert.equal(isStreamingMime("text/event-stream; charset=utf-8"), true);
  assert.equal(isStreamingMime("text/plain"), false);
});

test("deadline, abort and pool helpers", async () => {
  assert.equal(await withDeadline(new Promise(() => undefined), 20), TIMED_OUT);
  assert.equal(await withDeadline(Promise.resolve(5), 20), 5);
  const controller = new AbortController();
  const waiting = untilAborted(new Promise(() => undefined), controller.signal, () => new Error("stopped"));
  controller.abort();
  await assert.rejects(waiting, /stopped/);
  let active = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(peak, 2);
});

test("synthesized client hints keep three brands", () => {
  const metadata = synthesizeMetadata("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.1.2 Safari/537.36", "Chrome/140.0.1.2");
  assert.equal(metadata.brands.length, 3);
  assert.equal(metadata.platform, "Linux");
  assert.ok(metadata.brands.some((brand) => brand.brand === "Google Chrome" && brand.version === "140"));
});

test("isDaemonProcess requires this package's server.ts and --daemon", async () => {
  assert.equal(isDaemonProcess(process.pid), false);
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "src/server.ts", "--daemon"], { cwd: PACKAGE_DIR, stdio: "ignore" });
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)", "/elsewhere/server.ts", "--daemon"], { cwd: tmpdir(), stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(isDaemonProcess(child.pid), true);
    assert.equal(isDaemonProcess(other.pid), false);
  } finally {
    child.kill();
    other.kill();
  }
});

test("server version comes from package.json", async () => {
  const pkg = JSON.parse(await readFile(path.join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string };
  assert.equal(SERVER_VERSION, pkg.version);
  assert.equal(loadConfig({}).serverVersion, pkg.version);
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
