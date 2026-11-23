import { expect, test } from "bun:test";
import { inTimeZone } from "../../tests/timeZone.ts";
import { cookieDomainMatches, cookieLifetime } from "./data.ts";

test("cookie delete matches a domain exactly or by subdomain", () => {
  expect(cookieDomainMatches(".x.com", "x.com")).toBe(true);
  expect(cookieDomainMatches("x.com", ".x.com")).toBe(true);
  expect(cookieDomainMatches("api.x.com", "x.com")).toBe(true);
  expect(cookieDomainMatches(".netflix.com", "x.com")).toBe(false);
  expect(cookieDomainMatches("box.com", "x.com")).toBe(false);
});

test("a cookie's expiry date is the local date", async () => {
  expect(
    await inTimeZone("Europe/Istanbul", () =>
      cookieLifetime(Date.parse("2026-01-02T23:00:00.000Z") / 1000),
    ),
  ).toBe("expires 2026-01-03");
});
