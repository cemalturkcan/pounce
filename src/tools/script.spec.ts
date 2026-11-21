import { expect, test } from "bun:test";
import { evaluationSource } from "./script.ts";

test("evaluationSource picks expression or statements by parsing, not by running", () => {
  expect(evaluationSource("document.title")).toMatch(/const value = \(document\.title/);
  expect(evaluationSource("() => 1")).toMatch(/const value = \(\(\) => 1/);
  expect(evaluationSource("const n = 1; return n;")).toMatch(
    /^\(async \(\) => \{\nconst n = 1; return n;\n\}\)\(\)$/,
  );
  expect(evaluationSource("JSON.parse('{')")).toMatch(/const value = /);
  expect(() => evaluationSource("return (")).toThrow(/does not parse/);
});
