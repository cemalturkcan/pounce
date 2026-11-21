import { expect, test } from "bun:test";
import { countNoteLines, siteHost } from "./sites.ts";

test("siteHost normalises hosts and URLs into file-safe names", () => {
  expect(siteHost("https://www.Shop.example.com/a?b=1")).toBe("shop.example.com");
  expect(siteHost("shop.example.com")).toBe("shop.example.com");
  expect(siteHost("http://localhost:3000/x")).toBe("localhost");
  expect(() => siteHost("about:blank")).toThrow(/no usable host name|not a host/);
  expect(countNoteLines("# host\n\n- 2026-01-01: a\n- 2026-01-02: b\n")).toBe(2);
});
