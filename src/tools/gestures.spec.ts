import { describe, expect, test } from "bun:test";
import { scrollMove } from "./gestures.ts";

describe("scrollMove", () => {
  test("a target scrolls it into view", () => {
    expect(scrollMove({ target: "#a" })).toEqual({ kind: "into-view", target: "#a" });
  });

  test("to jumps to an end of the page", () => {
    expect(scrollMove({ to: "bottom" })).toEqual({ kind: "jump", to: "bottom" });
  });

  test("nothing given scrolls down 800 pixels", () => {
    expect(scrollMove({})).toEqual({ kind: "pixels", direction: "down", amount: 800 });
  });

  test("direction and amount scroll by pixels", () => {
    expect(scrollMove({ direction: "left", amount: 50 })).toEqual({
      kind: "pixels",
      direction: "left",
      amount: 50,
    });
  });

  test("target with to is refused", () => {
    expect(() => scrollMove({ target: "#a", to: "top" })).toThrow(
      "Give target, to, or direction and amount, not target with to.",
    );
  });

  test("target with direction is refused", () => {
    expect(() => scrollMove({ target: "#a", direction: "up" })).toThrow(
      "Give target, to, or direction and amount, not target with direction.",
    );
  });

  test("to with amount is refused", () => {
    expect(() => scrollMove({ to: "top", amount: 10 })).toThrow(
      "Give target, to, or direction and amount, not amount with to.",
    );
  });

  test("to with direction is refused", () => {
    expect(() => scrollMove({ to: "top", direction: "down" })).toThrow(
      "Give target, to, or direction and amount, not direction with to.",
    );
  });
});
