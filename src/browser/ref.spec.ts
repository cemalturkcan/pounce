import { expect, test } from "bun:test";
import {
  dropOldLoads,
  type IssuedRef,
  parseRef,
  refIdentities,
  sameElement,
  targetLabel,
} from "./ref.ts";

test("parseRef accepts refs in the forms a model writes them", () => {
  expect(parseRef("e12")).toBe("e12");
  expect(parseRef(" f1e3 ")).toBe("f1e3");
  expect(parseRef("@e4")).toBe("e4");
  expect(parseRef("[ref=e7]")).toBe("e7");
  expect(parseRef("ref=e7")).toBe("e7");
  expect(parseRef("#email")).toBe(undefined);
  expect(parseRef("text=e12 items")).toBe(undefined);
  expect(parseRef("element")).toBe(undefined);
});

const SNAPSHOT = [
  "- main [ref=e1]:",
  '  - button "Delete" [ref=e2]',
  '  - button "Delete" [ref=e3]',
  '  - textbox "Say \\"hi\\"" [ref=e4]',
  "  - button [ref=e5]",
  '  - iframe "Pay" [ref=e6]:',
  '    - button "Delete" [ref=f1e2]',
].join("\n");

test("refIdentities records role and name", () => {
  expect(refIdentities(SNAPSHOT).get("e3")).toMatchObject({ role: "button", name: "Delete" });
});

test("refIdentities unescapes quoted names", () => {
  expect(refIdentities(SNAPSHOT).get("e4")?.name).toBe('Say "hi"');
});

test("refIdentities records an element without a name with an empty name", () => {
  expect(refIdentities(SNAPSHOT).get("e5")).toMatchObject({ role: "button", name: "" });
});

test("refIdentities ties an element inside an iframe to the iframe's ref", () => {
  expect(refIdentities(SNAPSHOT).get("f1e2")?.frameRef).toBe("e6");
});

test("refIdentities keeps the snapshot line each ref was shown on", () => {
  expect(refIdentities(SNAPSHOT).get("e3")?.line).toBe('  - button "Delete" [ref=e3]');
});

test("targetLabel names a ref target by role, name and ref", () => {
  expect(targetLabel('- button "Save" [ref=e12]', "e12")).toBe('button "Save" (e12)');
});

test("targetLabel gives the ref of an element a selector matched", () => {
  expect(targetLabel('- button "Save" [ref=e12]', "#save")).toBe('button "Save" (e12, from #save)');
});

test("targetLabel keeps quotes inside the name escaped", () => {
  expect(targetLabel('- textbox "Say \\"hi\\"" [ref=e4]', "e4")).toBe(
    'textbox "Say \\"hi\\"" (e4)',
  );
});

test("targetLabel skips states and attributes around the ref", () => {
  expect(targetLabel('- link "Read" [checked] [ref=e3] [cursor=pointer]:', "e3")).toBe(
    'link "Read" (e3)',
  );
});

test("targetLabel uses the inline text of an element without a name", () => {
  expect(targetLabel("- generic [ref=e9]: Some text", "e9")).toBe('generic "Some text" (e9)');
});

test("targetLabel leaves out the value of a text field without a name", () => {
  expect(targetLabel("- textbox [ref=e4]: hello human", "#target")).toBe(
    "textbox (e4, from #target)",
  );
});

test("targetLabel names a text field by its name, not its value", () => {
  expect(targetLabel('- textbox "Your city" [ref=e4]: Paris', "e4")).toBe(
    'textbox "Your city" (e4)',
  );
});

test("targetLabel leaves out the value of a search box without a name", () => {
  expect(targetLabel("- searchbox [ref=e6]: shoes", "e6")).toBe("searchbox (e6)");
});

test("targetLabel leaves out the value of a number field without a name", () => {
  expect(targetLabel('- spinbutton [ref=e7]: "4"', "e7")).toBe("spinbutton (e7)");
});

test("targetLabel gives only the role of an element without a name or text", () => {
  expect(targetLabel("- button [ref=e5]", "e5")).toBe("button (e5)");
});

test("targetLabel shortens a long name", () => {
  expect(targetLabel(`- link "${"a".repeat(100)}" [ref=e2]`, "e2")).toBe(
    `link "${"a".repeat(79)}…" (e2)`,
  );
});

test("targetLabel falls back to the target when the snapshot line names no element", () => {
  expect(targetLabel("", "#save")).toBe("#save");
});

const rowsOf = (text: string) =>
  [
    "- table [ref=e2]:",
    "  - row [ref=e3]:",
    `    - cell "${text}" [ref=e4]`,
    '    - button "Sil" [ref=e5]',
  ].join("\n");

test("refIdentities ties an element inside nested iframes to its own iframe's ref", () => {
  const nested = [
    "- iframe [ref=e2]:",
    "  - iframe [ref=f1e3]:",
    '    - button "Pay" [ref=f2e2]',
  ].join("\n");
  expect(refIdentities(nested).get("f2e2")?.frameRef).toBe("f1e3");
});

test("sameElement accepts the same button whose row now holds other text", () => {
  const before = refIdentities(rowsOf("Kılıf A")).get("e5");
  expect(sameElement(before, refIdentities(rowsOf("Kılıf B")).get("e5"))).toBe(true);
});

test("sameElement refuses a button with another name", () => {
  const before = refIdentities(rowsOf("Kılıf A")).get("e5");
  const renamed = refIdentities(rowsOf("Kılıf A").replace('"Sil"', '"Geri al"')).get("e5");
  expect(sameElement(before, renamed)).toBe(false);
});

test("sameElement accepts an element shown without a name that now has one", () => {
  const before = refIdentities("- cell [ref=e5]:").get("e5");
  expect(sameElement(before, refIdentities('- cell "Satır 1 İç 1" [ref=e5]').get("e5"))).toBe(true);
});

test("sameElement refuses an element shown without a name whose role changed", () => {
  const before = refIdentities("- cell [ref=e5]:").get("e5");
  expect(sameElement(before, refIdentities("- row [ref=e5]:").get("e5"))).toBe(false);
});

test("sameElement refuses an element the page no longer shows", () => {
  expect(sameElement(refIdentities(rowsOf("Kılıf A")).get("e5"), undefined)).toBe(false);
});

const issuedAt = (loads: number): IssuedRef => ({
  role: "button",
  name: "Sil",
  line: '- button "Sil" [ref=e1]',
  loads,
  url: "https://shop.test/cart",
  token: "1",
  path: [],
  bound: Promise.resolve(true),
});

test("dropOldLoads keeps the refs of the current and the previous page load only", () => {
  const refs = new Map([
    ["e1", issuedAt(3)],
    ["f1e1", issuedAt(4)],
    ["f2e1", issuedAt(5)],
  ]);
  dropOldLoads(refs, 5);
  expect([...refs.keys()]).toStrictEqual(["f1e1", "f2e1"]);
});
