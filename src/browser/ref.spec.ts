import { expect, test } from "bun:test";
import { parseRef } from "./ref.ts";

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
