import { expect, test } from "bun:test";
import { z } from "zod";
import { parseJson, parseJsonOrThrow } from "./decode.ts";

const Tokens = z.object({ accessToken: z.string(), expiresAt: z.number() });

test("parseJson decodes JSON text that matches the schema", () => {
  const result = parseJson('{"accessToken":"abc","expiresAt":1700000000000}', Tokens);
  expect(result).toStrictEqual({
    success: true,
    data: { accessToken: "abc", expiresAt: 1_700_000_000_000 },
  });
});

test("parseJson reports text that is not JSON as a failure", () => {
  const result = parseJson("{not json", Tokens);
  expect(result.error?.issues.map((issue) => issue.message)).toStrictEqual(["Invalid JSON"]);
});

test("parseJson reports JSON that does not match the schema as a failure", () => {
  const result = parseJson('{"accessToken":"abc"}', Tokens);
  expect(result.error?.issues.map((issue) => issue.path)).toStrictEqual([["expiresAt"]]);
});

test("parseJsonOrThrow returns the decoded value", () => {
  expect(parseJsonOrThrow('{"accessToken":"abc","expiresAt":1}', Tokens)).toStrictEqual({
    accessToken: "abc",
    expiresAt: 1,
  });
});

test("parseJsonOrThrow throws on a value that does not match the schema", () => {
  expect(() => parseJsonOrThrow('{"accessToken":1,"expiresAt":1}', Tokens)).toThrow(z.ZodError);
});
