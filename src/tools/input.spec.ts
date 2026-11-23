import { describe, expect, test } from "bun:test";
import { fillMode } from "./input.ts";

describe("fillMode", () => {
  test("a target with a value fills one field", () => {
    expect(fillMode({ target: "#a", value: "x" }).kind).toBe("field");
  });

  test("a target with a secret fills one field", () => {
    expect(fillMode({ target: "#a", secret: "site", secret_field: "otp" }).kind).toBe("field");
  });

  test("a target with files attaches them", () => {
    expect(fillMode({ target: "#a", files: ["/f"], submit: "#send" }).kind).toBe("files");
  });

  test("fields fill a form", () => {
    expect(
      fillMode({ fields: [{ target: "#a", value: "x" }], submit: true, human: true }).kind,
    ).toBe("fields");
  });

  test("neither target nor fields is refused", () => {
    expect(() => fillMode({})).toThrow("Give either target or fields.");
  });

  test("target and fields together are refused", () => {
    expect(() => fillMode({ target: "#a", value: "x", fields: [] })).toThrow(
      "Give either target or fields.",
    );
  });

  test("a target without a value, secret or files is refused", () => {
    expect(() => fillMode({ target: "#a" })).toThrow(
      "Give exactly one of value, secret or files with target.",
    );
  });

  test("a target with a value and a secret is refused", () => {
    expect(() => fillMode({ target: "#a", value: "x", secret: "s" })).toThrow(
      "Give exactly one of value, secret or files with target.",
    );
  });

  test("secret_field without a secret is refused", () => {
    expect(() => fillMode({ target: "#a", value: "x", secret_field: "otp" })).toThrow(
      "secret_field needs secret.",
    );
  });

  test("files with slowly are refused", () => {
    expect(() => fillMode({ target: "#a", files: ["/f"], slowly: true })).toThrow(
      "slowly does not apply to files.",
    );
  });

  test("files with human are refused", () => {
    expect(() => fillMode({ target: "#a", files: ["/f"], human: true })).toThrow(
      "human does not apply to files.",
    );
  });

  test("files with submit true are refused", () => {
    expect(() => fillMode({ target: "#a", files: ["/f"], submit: true })).toThrow(
      /submit: true presses Enter/,
    );
  });

  test("a value beside fields is refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a", value: "x" }], value: "y" })).toThrow(
      "With fields, give value, secret and secret_field inside each field entry.",
    );
  });

  test("files beside fields are refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a", value: "x" }], files: ["/f"] })).toThrow(
      /files work with target only/,
    );
  });

  test("slowly with fields is refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a", value: "x" }], slowly: true })).toThrow(
      /slowly works with target only/,
    );
  });

  test("timeout_ms with fields is refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a", value: "x" }], timeout_ms: 100 })).toThrow(
      "timeout_ms works with target only.",
    );
  });

  test("a field entry without a value or secret is refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a" }] })).toThrow(
      "Give exactly one of value or secret for #a.",
    );
  });

  test("a field entry with secret_field but no secret is refused", () => {
    expect(() => fillMode({ fields: [{ target: "#a", value: "x", secret_field: "otp" }] })).toThrow(
      "secret_field needs secret (#a).",
    );
  });

  test("secret_field beside files is refused", () => {
    expect(() => fillMode({ target: "#f", files: ["/f"], secret_field: "username" })).toThrow(
      "secret_field does not apply to files.",
    );
  });

  test("an empty submit is refused", () => {
    expect(() => fillMode({ target: "#a", value: "x", submit: "" })).toThrow(
      /submit needs a ref or selector/,
    );
  });
});
