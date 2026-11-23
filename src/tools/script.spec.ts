import vm from "node:vm";
import { expect, jest, test } from "bun:test";
import { VALUE_CASES } from "../../tests/valueCases.ts";
import type { Job } from "../script/jobs.ts";
import { convertedSource } from "../script/text.ts";
import { evaluationSource, waitForJob } from "./script.ts";

function endedJob(): Job {
  return {
    id: "j1",
    owner: "session",
    label: "",
    state: "done",
    startedAt: 0,
    endedAt: 10,
    logFile: "/out/jobs/j1/log.txt",
    resultFile: "/out/jobs/j1/result.txt",
    logLines: 0,
    recentLogs: [],
    controller: new AbortController(),
    finished: Promise.resolve(),
  };
}

test("a wait that ends with the job leaves no timer behind", async () => {
  jest.useFakeTimers();
  try {
    await waitForJob(endedJob(), 900_000, new AbortController().signal);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test("evaluationSource picks expression or statements by parsing, not by running", () => {
  expect(evaluationSource("document.title")).toMatch(/const value = \(document\.title/);
  expect(evaluationSource("() => 1")).toMatch(/const value = \(\(\) => 1/);
  expect(evaluationSource("const n = 1; return n;")).toContain(
    "(async () => {\nconst n = 1; return n;\n})()",
  );
  expect(evaluationSource("JSON.parse('{')")).toMatch(/const value = /);
  expect(() => evaluationSource("return (")).toThrow(/does not parse/);
});

const ranConverted = (expression: string) =>
  vm.runInThisContext(convertedSource(evaluationSource(expression)));

const evaluated = async (expression: string) => {
  const text: string = JSON.stringify(await ranConverted(expression));
  return text;
};

test("an evaluated Map becomes the list of its entries", async () => {
  expect(await evaluated(`new Map([["a", 1], ["b", 2]])`)).toBe(`[["a",1],["b",2]]`);
});

test("an evaluated Set becomes the list of its values", async () => {
  expect(await evaluated(`new Set([1, "x"])`)).toBe(`[1,"x"]`);
});

test("a Map inside an evaluated object becomes the list of its entries", async () => {
  expect(await evaluated(`({ seen: new Map([["k", new Set([2])]]) })`)).toBe(
    `{"seen":[["k",[2]]]}`,
  );
});

test("a Set returned by evaluated statements becomes the list of its values", async () => {
  expect(await evaluated("const tags = new Set(['a']); return tags;")).toBe(`["a"]`);
});

test("an evaluated Date inside an object becomes its ISO time", async () => {
  expect(await evaluated("({ when: new Date(0) })")).toBe(`{"when":"1970-01-01T00:00:00.000Z"}`);
});

test("an evaluated object that refers to itself marks the reference that loops back", async () => {
  expect(
    await evaluated(
      "(() => { const node = { set: new Set() }; node.self = node; return node; })()",
    ),
  ).toBe(`{"set":[],"self":"[Circular]"}`);
});

for (const { name, code, value } of VALUE_CASES) {
  test(`evaluate: ${name}`, async () => {
    expect(await ranConverted(code)).toStrictEqual(value);
  });
}

test("evaluate: undefined stays undefined", async () => {
  expect(await ranConverted("undefined")).toBeUndefined();
});

test("evaluate: a DOMException keeps its name and message like an Error", async () => {
  expect(await ranConverted('new DOMException("aborted", "AbortError")')).toMatchObject({
    name: "AbortError",
    message: "aborted",
  });
});

test("evaluate: a revoked Proxy is marked as unconvertible", async () => {
  expect(
    await ranConverted(
      "const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return { broken: proxy };",
    ),
  ).toStrictEqual({ broken: expect.stringMatching(/^\[Unconvertible: TypeError: .+\]$/) });
});

const fromOtherRealm = async (source: string) => {
  Object.assign(globalThis, { otherRealmValue: vm.runInNewContext(source) });
  return evaluated("globalThis.otherRealmValue");
};

test("a Map from another realm, as from an iframe, becomes the list of its entries", async () => {
  expect(await fromOtherRealm(`new Map([["a", 1]])`)).toBe(`[["a",1]]`);
});

test("a Set from another realm becomes the list of its values", async () => {
  expect(await fromOtherRealm(`new Set([1])`)).toBe(`[1]`);
});

test("a plain object from another realm has its Map turned into a list", async () => {
  expect(await fromOtherRealm(`({ seen: new Map([["k", 2]]) })`)).toBe(`{"seen":[["k",2]]}`);
});

test("an object that only claims to be a Map is left as it is", async () => {
  expect(await evaluated(`({ [Symbol.toStringTag]: "Map", size: 1 })`)).toBe(`{"size":1}`);
});

test("an object that only claims to be a Set is left as it is", async () => {
  expect(await evaluated(`({ [Symbol.toStringTag]: "Set", size: 1 })`)).toBe(`{"size":1}`);
});

test("a Map inside an object with its own tag becomes the list of its entries", async () => {
  expect(await evaluated(`({ [Symbol.toStringTag]: "Custom", inner: new Map([["k", 1]]) })`)).toBe(
    `{"inner":[["k",1]]}`,
  );
});

test("a Map with its own tag becomes the list of its entries", async () => {
  expect(
    await evaluated(
      `Object.defineProperty(new Map([["k", 1]]), Symbol.toStringTag, { value: "Registry" })`,
    ),
  ).toBe(`[["k",1]]`);
});

test("a Map with a custom tag inside a Map becomes a nested list", async () => {
  expect(
    await evaluated(
      `new Map([["outer", Object.defineProperty(new Map([["k", 1]]), Symbol.toStringTag, { value: "Registry" })]])`,
    ),
  ).toBe(`[["outer",[["k",1]]]]`);
});

test("a Set with its own tag from another realm becomes the list of its values", async () => {
  expect(
    await fromOtherRealm(
      `Object.defineProperty(new Set([1]), Symbol.toStringTag, { value: "Bag" })`,
    ),
  ).toBe(`[1]`);
});
