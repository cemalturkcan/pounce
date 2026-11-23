import { describe, expect, test } from "bun:test";
import { handoffCondition, urlCondition, urlContains } from "./waits.ts";

describe("urlContains", () => {
  test("matches a URL containing the text", () => {
    expect(urlContains("checkout")(new URL("https://shop.test/checkout/done"))).toBe(true);
  });

  test("does not match a URL without the text", () => {
    expect(urlContains("cart")(new URL("https://shop.test/checkout"))).toBe(false);
  });
});

describe("urlCondition", () => {
  test("text with * is handed on as a glob", () => {
    expect(urlCondition("**/checkout*")).toBe("**/checkout*");
  });
});

describe("handoffCondition", () => {
  test("no condition waits for the next navigation", () => {
    expect(handoffCondition({})).toEqual({ kind: "navigation" });
  });

  test("until_gone waits for the text to go", () => {
    expect(handoffCondition({ until_gone: "Verify" })).toEqual({ kind: "gone", text: "Verify" });
  });

  test("two conditions are refused", () => {
    expect(() => handoffCondition({ until_text: "a", until_url: "b" })).toThrow(
      "Give at most one of until_text, until_gone, until_url.",
    );
  });
});
