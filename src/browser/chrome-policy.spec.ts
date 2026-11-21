import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  explainPolicyBlock,
  findPolicyMatches,
  matchesUrlFilter,
  type PolicyFile,
} from "./chrome-policy.ts";

const matches = (pattern: string, url: string) => matchesUrlFilter(pattern, new URL(url));

test("a host pattern matches the host and its subdomains on any scheme, port and path", () => {
  expect(matches("example.com", "https://example.com/")).toBe(true);
  expect(matches("example.com", "http://www.example.com:8080/a/b?x=1")).toBe(true);
  expect(matches("example.com", "https://deep.sub.example.com/")).toBe(true);
  expect(matches("example.com", "https://notexample.com/")).toBe(false);
  expect(matches("example.com", "https://example.com.evil.test/")).toBe(false);
  expect(matches("EXAMPLE.com", "https://example.COM/")).toBe(true);
});

test("a leading dot limits the pattern to the exact host", () => {
  expect(matches(".example.com", "https://example.com/page")).toBe(true);
  expect(matches(".example.com", "https://www.example.com/")).toBe(false);
});

test("a star alone or as the host matches every host", () => {
  expect(matches("*", "https://anything.test/x")).toBe(true);
  expect(matches("*", "file:///etc/hosts")).toBe(true);
  expect(matches("https://*", "https://anything.test/")).toBe(true);
  expect(matches("https://*", "http://anything.test/")).toBe(false);
  expect(matches("*/admin", "https://a.test/admin/users")).toBe(true);
  expect(matches("*/admin", "https://a.test/public")).toBe(false);
});

test("scheme, port, path prefix and query must match when the pattern gives them", () => {
  expect(matches("https://example.com", "http://example.com/")).toBe(false);
  expect(matches("http://example.com", "http://example.com/")).toBe(true);
  expect(matches("example.com:8080", "http://example.com:8080/")).toBe(true);
  expect(matches("example.com:8080", "http://example.com/")).toBe(false);
  expect(matches("example.com:443", "https://example.com/")).toBe(true);
  expect(matches("example.com/docs", "https://example.com/docs/intro")).toBe(true);
  expect(matches("example.com/docs", "https://example.com/blog")).toBe(false);
  expect(matches("example.com/docs*", "https://example.com/docs2")).toBe(true);
  expect(matches("example.com/search?q=cats", "https://example.com/search?lang=en&q=cats")).toBe(
    true,
  );
  expect(matches("example.com/search?q=cats", "https://example.com/search?q=dogs")).toBe(false);
  expect(matches("example.com/search?q=*", "https://example.com/search?q=dogs")).toBe(true);
});

test("IP, IPv6, file and custom scheme patterns", () => {
  expect(matches("127.0.0.1:8080/blocked", "http://127.0.0.1:8080/blocked/page")).toBe(true);
  expect(matches("127.0.0.1", "http://127.0.0.2/")).toBe(false);
  expect(matches("[::1]:3000", "http://[::1]:3000/")).toBe(true);
  expect(matches("file:///home/user/", "file:///home/user/notes.txt")).toBe(true);
  expect(matches("file:///home/user/", "file:///etc/passwd")).toBe(false);
  expect(matches("file://*", "file:///etc/passwd")).toBe(true);
  expect(matches("chrome://settings", "chrome://settings/passwords")).toBe(true);
  expect(matches("chrome://settings", "chrome://history/")).toBe(false);
  expect(matches("", "https://example.com/")).toBe(false);
});

const FILES: PolicyFile[] = [
  {
    path: "/etc/opt/chrome/policies/managed/block.json",
    policies: { URLBlocklist: ["example.com", "other.test"], URLAllowlist: ["example.com/public"] },
  },
  {
    path: "/etc/chromium/policies/recommended/legacy.json",
    policies: { URLBlacklist: ["legacy.test"] },
  },
];

test("policy matches name the file and the pattern, and the more specific allow pattern wins", () => {
  const blocked = findPolicyMatches("https://www.example.com/private", FILES);
  expect(blocked.blocklist).toStrictEqual([
    {
      file: "/etc/opt/chrome/policies/managed/block.json",
      policy: "URLBlocklist",
      pattern: "example.com",
    },
  ]);
  expect(blocked.allowlist).toStrictEqual([]);
  expect(blocked.verdict).toBe("blocked");

  const allowed = findPolicyMatches("https://example.com/public/page", FILES);
  expect(allowed.blocklist.length).toBe(1);
  expect(allowed.allowlist).toStrictEqual([
    {
      file: "/etc/opt/chrome/policies/managed/block.json",
      policy: "URLAllowlist",
      pattern: "example.com/public",
    },
  ]);
  expect(allowed.verdict).toBe("allowed");

  expect(findPolicyMatches("https://legacy.test/", FILES).blocklist).toStrictEqual([
    {
      file: "/etc/chromium/policies/recommended/legacy.json",
      policy: "URLBlacklist",
      pattern: "legacy.test",
    },
  ]);
  expect(findPolicyMatches("https://free.test/", FILES).verdict).toBe("none");
});

async function withPolicyDirs(run: (dirs: string[]) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-policy-"));
  try {
    const managed = path.join(root, "managed");
    await mkdir(managed);
    await writeFile(
      path.join(managed, "block.json"),
      JSON.stringify({ URLBlocklist: ["blocked.test"] }),
    );
    await writeFile(path.join(managed, "broken.json"), "{ nope");
    await writeFile(path.join(managed, "notes.txt"), JSON.stringify({ URLBlocklist: ["*"] }));
    await run([managed, path.join(root, "missing")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a blocked-by-administrator error names the policy file and the matching pattern", async () => {
  await withPolicyDirs(async (dirs) => {
    const text = await explainPolicyBlock(
      "page.goto: net::ERR_BLOCKED_BY_ADMINISTRATOR at https://www.blocked.test/page\nCall log:",
      dirs,
    );
    expect(text).toBe(
      `Chrome policy: URLBlocklist pattern "blocked.test" in ${path.join(dirs[0] ?? "", "block.json")} matches https://www.blocked.test/page.`,
    );
  });
});

test("a blocked-by-administrator error without a matching pattern says so and lists the folders searched", async () => {
  await withPolicyDirs(async (dirs) => {
    const text = await explainPolicyBlock(
      "net::ERR_BLOCKED_BY_ADMINISTRATOR at https://free.test/",
      dirs,
    );
    expect(text).toBe(
      `Chrome policy: no URLBlocklist pattern in the policy files under ${dirs.join(", ")} matches https://free.test/; the block comes from another source, such as cloud-managed policy or an extension.`,
    );
  });
});

test("a blocked-by-client error is explained only when a policy pattern matches", async () => {
  await withPolicyDirs(async (dirs) => {
    expect(await explainPolicyBlock("net::ERR_BLOCKED_BY_CLIENT at https://free.test/", dirs)).toBe(
      undefined,
    );
    expect(
      (await explainPolicyBlock("net::ERR_BLOCKED_BY_CLIENT at https://blocked.test/x", dirs)) ??
        "",
    ).toMatch(/URLBlocklist pattern "blocked.test"/);
    expect(
      await explainPolicyBlock("net::ERR_CONNECTION_REFUSED at https://blocked.test/", dirs),
    ).toBe(undefined);
  });
});

test("an allow pattern that outranks the block pattern is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-agent-policy-"));
  try {
    await writeFile(
      path.join(root, "p.json"),
      JSON.stringify({ URLBlocklist: ["shop.test"], URLAllowlist: ["shop.test/cart"] }),
    );
    const text = await explainPolicyBlock(
      "net::ERR_BLOCKED_BY_ADMINISTRATOR at https://shop.test/cart/1",
      [root],
    );
    expect(text ?? "").toMatch(/URLBlocklist pattern "shop.test" in .*p\.json matches/);
    expect(text ?? "").toMatch(
      /URLAllowlist pattern "shop.test\/cart" in .*p\.json also matches and is more specific/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
