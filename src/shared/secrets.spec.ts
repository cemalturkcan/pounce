import { expect, test } from "bun:test";
import { Redactor } from "./output.ts";
import { GopassStore, parseEntry, registerSecret } from "./secrets.ts";

test("registerSecret masks passwords and custom fields, OTPs briefly, usernames never", () => {
  let now = 0;
  const redactor = new Redactor(() => now);
  registerSecret(redactor, "site", "password", "pw-secret-1");
  registerSecret(redactor, "site", "username", "person@example.test");
  registerSecret(redactor, "site", "api_key", "key-secret-2");
  registerSecret(redactor, "site", "otp", "654321");
  expect(redactor.redact("pw-secret-1 person@example.test key-secret-2 654321")).toBe(
    "<secret:site:password> person@example.test <secret:site:api_key> <secret:site:otp>",
  );
  now += 3 * 60 * 1000;
  expect(redactor.redact("654321 pw-secret-1")).toMatch(/^654321 <secret:site:password>$/);
});

test("parseEntry splits the password line from key-value fields", () => {
  const entry = parseEntry(
    "s3cret-value\nusername: person@example.test\nurl: https://example.test/login\nnote without colon\n",
  );
  expect(entry.password).toBe("s3cret-value");
  expect(entry.fields.get("username")).toBe("person@example.test");
  expect(entry.fields.get("url")).toBe("https://example.test/login");
});

test("GopassStore resolves fields without a shell and rejects option-like names", async () => {
  const calls: string[][] = [];
  const store = new GopassStore(async (args) => {
    calls.push(args);
    if (args[0] === "ls") return "web/shop\nweb/mail\n";
    if (args[0] === "otp") return "123456\n";
    return "pw-value\nlogin: shopper\n";
  });
  expect(await store.list("SHOP")).toStrictEqual(["web/shop"]);
  expect(await store.get("web/shop", "password")).toBe("pw-value");
  expect(await store.get("web/shop", "username")).toBe("shopper");
  expect(await store.get("web/shop", "otp")).toBe("123456");
  expect(calls.at(-1)).toStrictEqual(["otp", "-o", "--", "web/shop"]);
  await expect(store.get("web/shop", "pin")).rejects.toThrow(/has no pin field/);
  await expect(store.get("--clip", "password")).rejects.toThrow(/Invalid secret name/);
});
