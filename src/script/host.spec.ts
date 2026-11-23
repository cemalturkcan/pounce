import { expect, test } from "bun:test";
import { HandleTable } from "./host.ts";

test("a handle the worker released while it was sent again stays available", () => {
  const handles = new HandleTable();
  const page = { name: "page" };
  const id = handles.export(page);
  handles.export(page);
  handles.release(id, 1);
  expect(handles.get(id)).toBe(page);
});

test("a handle released as often as it was sent is dropped", () => {
  const handles = new HandleTable();
  const id = handles.export({ name: "page" });
  handles.release(id, 1);
  expect(handles.get(id)).toBeUndefined();
});

test("an object sent again after its handle was dropped gets a new handle", () => {
  const handles = new HandleTable();
  const page = { name: "page" };
  const first = handles.export(page);
  handles.release(first, 1);
  expect(handles.export(page)).not.toBe(first);
});
