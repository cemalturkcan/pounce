import { expect, test } from "bun:test";
import { cookieDomainMatches } from "./data.ts";

test("cookie delete matches a domain exactly or by subdomain", () => {
  expect(cookieDomainMatches(".x.com", "x.com")).toBe(true);
  expect(cookieDomainMatches("x.com", ".x.com")).toBe(true);
  expect(cookieDomainMatches("api.x.com", "x.com")).toBe(true);
  expect(cookieDomainMatches(".netflix.com", "x.com")).toBe(false);
  expect(cookieDomainMatches("box.com", "x.com")).toBe(false);
});
