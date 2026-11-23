import type { StructuredValue } from "../src/shared/output.ts";

export type ValueCase = { name: string; code: string; value: StructuredValue };

const nested = (levels: number, end: StructuredValue): StructuredValue =>
  levels === 0 ? end : { next: nested(levels - 1, end) };

export const VALUE_CASES: ValueCase[] = [
  {
    name: "a Map becomes the list of its entries",
    code: 'return new Map([["k", 1]]);',
    value: [["k", 1]],
  },
  { name: "a Set becomes the list of its values", code: "return new Set([1, 2]);", value: [1, 2] },
  {
    name: "a Map inside an object becomes a nested list",
    code: 'return { seen: new Map([["k", new Set([2])]]) };',
    value: { seen: [["k", [2]]] },
  },
  {
    name: "an Error keeps its name and message",
    code: 'const error = new TypeError("boom"); error.stack = "TypeError: boom\\n    at run (code.js:1:2)"; return error;',
    value: { name: "TypeError", message: "boom", stack: "at run (code.js:1:2)" },
  },
  { name: "NaN is the text NaN", code: "return NaN;", value: "NaN" },
  {
    name: "infinities are their texts",
    code: "return [Infinity, -Infinity];",
    value: ["Infinity", "-Infinity"],
  },
  { name: "negative zero is the text -0", code: "return { zero: -0 };", value: { zero: "-0" } },
  {
    name: "a BigInt is its digits as text",
    code: "return { total: 10n };",
    value: { total: "10" },
  },
  {
    name: "a circular object marks the reference that loops back",
    code: 'const node = { name: "loop" }; node.self = node; return node;',
    value: { name: "loop", self: "[Circular]" },
  },
  { name: "a RegExp is its source text", code: "return /x/g;", value: "/x/g" },
  {
    name: "a Date is its ISO time",
    code: "return new Date(0);",
    value: "1970-01-01T00:00:00.000Z",
  },
  {
    name: "undefined inside an array or an object is marked as undefined",
    code: "return { list: [undefined], field: undefined };",
    value: { list: ["[undefined]"], field: "[undefined]" },
  },
  {
    name: "a function inside an array or an object is marked as a function",
    code: "return { list: [() => 1], field: function named() {} };",
    value: { list: ["[Function]"], field: "[Function]" },
  },
  {
    name: "a Symbol inside an array or an object is marked with its description",
    code: 'return { list: [Symbol("s")], field: Symbol() };',
    value: { list: ["[Symbol(s)]"], field: "[Symbol()]" },
  },
  {
    name: "undefined as a Map key or value and in a Set is marked as undefined",
    code: "return [new Map([[undefined, undefined]]), new Set([undefined])];",
    value: [[["[undefined]", "[undefined]"]], ["[undefined]"]],
  },
  {
    name: "a part whose toJSON throws is marked as unconvertible",
    code: 'return { kept: 1, broken: { toJSON() { throw new Error("boom"); } } };',
    value: { kept: 1, broken: "[Unconvertible: Error: boom]" },
  },
  {
    name: "a field whose getter throws is marked as unconvertible",
    code: 'return { kept: 1, get broken() { throw new TypeError("no"); } };',
    value: { kept: 1, broken: "[Unconvertible: TypeError: no]" },
  },
  {
    name: "an Error whose name getter throws keeps its message",
    code: 'const error = new Error("kept"); error.stack = ""; Object.defineProperty(error, "name", { get() { throw new Error("hidden"); } }); return error;',
    value: { name: "[Unconvertible: Error: hidden]", message: "kept" },
  },
  {
    name: "an object whose keys cannot be listed is marked as unconvertible",
    code: 'return { kept: 1, broken: new Proxy({}, { ownKeys() { throw new Error("keys"); } }) };',
    value: { kept: 1, broken: "[Unconvertible: Error: keys]" },
  },
  {
    name: "a part nested deeper than 64 levels is marked as too deep",
    code: "let node = {}; const root = node; for (let level = 0; level < 20000; level += 1) { node.next = {}; node = node.next; } return root;",
    value: nested(64, "[Too deep]"),
  },
];
