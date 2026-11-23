import vm from "node:vm";
import { expect, test } from "bun:test";
import { VALUE_CASES } from "../../tests/valueCases.ts";
import { logPartText, structuredValue, valueText } from "./text.ts";

type Loop = { name: string; self?: Loop };

function circular() {
  const node: Loop = { name: "loop" };
  node.self = node;
  return node;
}

const ranHere = (code: string) => vm.runInThisContext(`(() => {${code}})()`);
const ranInOtherRealm = (code: string) => vm.runInNewContext(`(() => {${code}})()`);

for (const { name, code, value } of VALUE_CASES) {
  test(`structured value: ${name}`, () => {
    expect(structuredValue(ranHere(code))).toStrictEqual(value);
  });

  test(`structured value from another realm: ${name}`, () => {
    expect(structuredValue(ranInOtherRealm(code))).toStrictEqual(value);
  });
}

test("undefined stays undefined", () => {
  expect(structuredValue(undefined)).toBeUndefined();
});

test("an object that only claims to be a Map is left as it is", () => {
  expect(structuredValue({ [Symbol.toStringTag]: "Map", size: 1 })).toStrictEqual({ size: 1 });
});

test("an object referenced twice without a loop is kept both times", () => {
  const shared = { id: 1 };
  expect(structuredValue({ first: shared, second: shared })).toStrictEqual({
    first: { id: 1 },
    second: { id: 1 },
  });
});

test("an object with toJSON is what toJSON returns", () => {
  expect(structuredValue({ toJSON: () => ({ shown: true }) })).toStrictEqual({ shown: true });
});

test("a toJSON the page added to Object.prototype does not replace every object", () => {
  expect(
    structuredValue(
      ranInOtherRealm(
        'Object.prototype.toJSON = function () { return "J"; }; return { a: 1, list: [{ b: 2 }] };',
      ),
    ),
  ).toStrictEqual({ a: 1, list: [{ b: 2 }] });
});

test("a toJSON on the page's own prototype without a prototype of its own is what toJSON returns", () => {
  expect(
    structuredValue(
      ranInOtherRealm(
        'const base = Object.create(null); base.toJSON = () => "custom"; const value = Object.create(base); value.a = 1; return value;',
      ),
    ),
  ).toBe("custom");
});

test("a toJSON the page added to Array.prototype does not replace an object built on it", () => {
  expect(
    structuredValue(
      ranInOtherRealm(
        'Array.prototype.toJSON = function () { return "J"; }; const value = Object.create(Array.prototype); value.a = 1; return value;',
      ),
    ),
  ).toStrictEqual({ a: 1 });
});

test("a built-in toJSON of a built-in prototype is what toJSON returns", () => {
  expect(structuredValue(new URL("https://shop.example/cart"))).toBe("https://shop.example/cart");
});

test("an object whose class defines toJSON is what toJSON returns", () => {
  expect(
    structuredValue(
      ranInOtherRealm(
        "class Money { toJSON() { return '1 EUR'; } } return { price: new Money() };",
      ),
    ),
  ).toStrictEqual({ price: "1 EUR" });
});

test("the text of a circular object shows its fields and the loop marker", () => {
  expect(valueText(structuredValue(circular()))).toBe('{"name":"loop","self":"[Circular]"}');
});

test("the text of an object holding a BigInt shows the number", () => {
  expect(valueText(structuredValue({ total: 10n }))).toBe('{"total":"10"}');
});

test("the text of a BigInt is its digits", () => {
  expect(valueText(structuredValue(10n))).toBe("10");
});

test("the text of undefined is undefined", () => {
  expect(valueText(structuredValue(undefined))).toBe("undefined");
});

const revokedProxy = () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  return proxy;
};

test("a revoked Proxy is marked as unconvertible with the error it raised", () => {
  expect(structuredValue(revokedProxy())).toMatch(/^\[Unconvertible: TypeError: .+\]$/);
});

test("a part that throws a value that cannot be described is marked as unconvertible", () => {
  const thrown = revokedProxy();
  expect(
    structuredValue({
      toJSON: () => {
        throw thrown;
      },
    }),
  ).toBe("[Unconvertible]");
});

test("a DOMException keeps its name and message like an Error", () => {
  expect(structuredValue(new DOMException("aborted", "AbortError"))).toMatchObject({
    name: "AbortError",
    message: "aborted",
  });
});

test("a Symbol has no value", () => {
  expect(structuredValue(Symbol("s"))).toBeUndefined();
});

test("a Map in a log line is the list of its entries", () => {
  expect(logPartText.parse(new Map([[1, 2]]))).toBe("[[1,2]]");
});

test("a Set in a log line is the list of its values", () => {
  expect(logPartText.parse(new Set([1]))).toBe("[1]");
});

test("NaN in a log line is the text NaN", () => {
  expect(logPartText.parse(Number.NaN)).toBe("NaN");
});

test("an Error in a log line keeps its name and message", () => {
  const error = new Error("logged");
  error.stack = "";
  expect(logPartText.parse(error)).toBe('{"name":"Error","message":"logged"}');
});

test("a text in a log line is the text itself", () => {
  expect(logPartText.parse("plain")).toBe("plain");
});

test("a Symbol in a log line is its description text", () => {
  expect(logPartText.parse(Symbol("s"))).toBe("Symbol(s)");
});

test("a function in a log line is its source", () => {
  expect(logPartText.parse(function named() {})).toBe("function named() {}");
});

type Shell = { inner?: Shell };

test("a Proxy that is its own prototype is marked as too deep", () => {
  const looped: Shell = new Proxy({}, { getPrototypeOf: () => looped });
  expect(structuredValue({ looped })).toStrictEqual({ looped: "[Too deep]" });
});

test("a Proxy whose prototype is always a new Proxy is marked as too deep", () => {
  const endless = (): Shell => new Proxy({}, { getPrototypeOf: endless });
  expect(structuredValue({ endless: endless() })).toStrictEqual({ endless: "[Too deep]" });
});
