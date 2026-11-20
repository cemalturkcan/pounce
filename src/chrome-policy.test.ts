import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { explainPolicyBlock, findPolicyMatches, matchesUrlFilter, type PolicyFile } from "./chrome-policy.ts";

const matches = (pattern: string, url: string) => matchesUrlFilter(pattern, new URL(url));

test("a host pattern matches the host and its subdomains on any scheme, port and path", () => {
  assert.equal(matches("example.com", "https://example.com/"), true);
  assert.equal(matches("example.com", "http://www.example.com:8080/a/b?x=1"), true);
  assert.equal(matches("example.com", "https://deep.sub.example.com/"), true);
  assert.equal(matches("example.com", "https://notexample.com/"), false);
  assert.equal(matches("example.com", "https://example.com.evil.test/"), false);
  assert.equal(matches("EXAMPLE.com", "https://example.COM/"), true);
});

test("a leading dot limits the pattern to the exact host", () => {
  assert.equal(matches(".example.com", "https://example.com/page"), true);
  assert.equal(matches(".example.com", "https://www.example.com/"), false);
});

test("a star alone or as the host matches every host", () => {
  assert.equal(matches("*", "https://anything.test/x"), true);
  assert.equal(matches("*", "file:///etc/hosts"), true);
  assert.equal(matches("https://*", "https://anything.test/"), true);
  assert.equal(matches("https://*", "http://anything.test/"), false);
  assert.equal(matches("*/admin", "https://a.test/admin/users"), true);
  assert.equal(matches("*/admin", "https://a.test/public"), false);
});

test("scheme, port, path prefix and query must match when the pattern gives them", () => {
  assert.equal(matches("https://example.com", "http://example.com/"), false);
  assert.equal(matches("http://example.com", "http://example.com/"), true);
  assert.equal(matches("example.com:8080", "http://example.com:8080/"), true);
  assert.equal(matches("example.com:8080", "http://example.com/"), false);
  assert.equal(matches("example.com:443", "https://example.com/"), true);
  assert.equal(matches("example.com/docs", "https://example.com/docs/intro"), true);
  assert.equal(matches("example.com/docs", "https://example.com/blog"), false);
  assert.equal(matches("example.com/docs*", "https://example.com/docs2"), true);
  assert.equal(matches("example.com/search?q=cats", "https://example.com/search?lang=en&q=cats"), true);
  assert.equal(matches("example.com/search?q=cats", "https://example.com/search?q=dogs"), false);
  assert.equal(matches("example.com/search?q=*", "https://example.com/search?q=dogs"), true);
});

test("IP, IPv6, file and custom scheme patterns", () => {
  assert.equal(matches("127.0.0.1:8080/blocked", "http://127.0.0.1:8080/blocked/page"), true);
  assert.equal(matches("127.0.0.1", "http://127.0.0.2/"), false);
  assert.equal(matches("[::1]:3000", "http://[::1]:3000/"), true);
  assert.equal(matches("file:///home/user/", "file:///home/user/notes.txt"), true);
  assert.equal(matches("file:///home/user/", "file:///etc/passwd"), false);
  assert.equal(matches("file://*", "file:///etc/passwd"), true);
  assert.equal(matches("chrome://settings", "chrome://settings/passwords"), true);
  assert.equal(matches("chrome://settings", "chrome://history/"), false);
  assert.equal(matches("", "https://example.com/"), false);
});

const FILES: PolicyFile[] = [
  { path: "/etc/opt/chrome/policies/managed/block.json", policies: { URLBlocklist: ["example.com", "other.test"], URLAllowlist: ["example.com/public"] } },
  { path: "/etc/chromium/policies/recommended/legacy.json", policies: { URLBlacklist: ["legacy.test"] } },
];

test("policy matches name the file and the pattern, and the more specific allow pattern wins", () => {
  const blocked = findPolicyMatches("https://www.example.com/private", FILES);
  assert.deepEqual(blocked.blocklist, [{ file: "/etc/opt/chrome/policies/managed/block.json", policy: "URLBlocklist", pattern: "example.com" }]);
  assert.deepEqual(blocked.allowlist, []);
  assert.equal(blocked.verdict, "blocked");

  const allowed = findPolicyMatches("https://example.com/public/page", FILES);
  assert.equal(allowed.blocklist.length, 1);
  assert.deepEqual(allowed.allowlist, [{ file: "/etc/opt/chrome/policies/managed/block.json", policy: "URLAllowlist", pattern: "example.com/public" }]);
  assert.equal(allowed.verdict, "allowed");

  assert.deepEqual(findPolicyMatches("https://legacy.test/", FILES).blocklist, [{ file: "/etc/chromium/policies/recommended/legacy.json", policy: "URLBlacklist", pattern: "legacy.test" }]);
  assert.equal(findPolicyMatches("https://free.test/", FILES).verdict, "none");
});

async function withPolicyDirs(run: (dirs: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-policy-"));
  try {
    const managed = path.join(root, "managed");
    await mkdir(managed);
    await writeFile(path.join(managed, "block.json"), JSON.stringify({ URLBlocklist: ["blocked.test"] }));
    await writeFile(path.join(managed, "broken.json"), "{ nope");
    await writeFile(path.join(managed, "notes.txt"), JSON.stringify({ URLBlocklist: ["*"] }));
    await run([managed, path.join(root, "missing")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a blocked-by-administrator error names the policy file and the matching pattern", async () => {
  await withPolicyDirs(async (dirs) => {
    const text = await explainPolicyBlock("page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://www.blocked.test/page\nCall log:", dirs);
    assert.equal(text, `Chrome policy: URLBlocklist pattern "blocked.test" in ${path.join(dirs[0] ?? "", "block.json")} matches https://www.blocked.test/page.`);
  });
});

test("a blocked-by-administrator error without a matching pattern says so and lists the folders searched", async () => {
  await withPolicyDirs(async (dirs) => {
    const text = await explainPolicyBlock("net::ERR_BLOCKED_BY_ADMINISTRATOR at https://free.test/", dirs);
    assert.equal(text, `Chrome policy: no URLBlocklist pattern in the policy files under ${dirs.join(", ")} matches https://free.test/; the block comes from another source, such as cloud-managed policy or an extension.`);
  });
});

test("a blocked-by-client error is explained only when a policy pattern matches", async () => {
  await withPolicyDirs(async (dirs) => {
    assert.equal(await explainPolicyBlock("net::ERR_BLOCKED_BY_CLIENT at https://free.test/", dirs), undefined);
    assert.match((await explainPolicyBlock("net::ERR_BLOCKED_BY_CLIENT at https://blocked.test/x", dirs)) ?? "", /URLBlocklist pattern "blocked.test"/);
    assert.equal(await explainPolicyBlock("net::ERR_CONNECTION_REFUSED at https://blocked.test/", dirs), undefined);
  });
});

test("an allow pattern that outranks the block pattern is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-policy-"));
  try {
    await writeFile(path.join(root, "p.json"), JSON.stringify({ URLBlocklist: ["shop.test"], URLAllowlist: ["shop.test/cart"] }));
    const text = await explainPolicyBlock("net::ERR_BLOCKED_BY_ADMINISTRATOR at https://shop.test/cart/1", [root]);
    assert.match(text ?? "", /URLBlocklist pattern "shop.test" in .*p\.json matches/);
    assert.match(text ?? "", /URLAllowlist pattern "shop.test\/cart" in .*p\.json also matches and is more specific/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
