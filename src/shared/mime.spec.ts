import { expect, test } from "bun:test";
import { isStreamingMime, isTextualMime } from "./mime.ts";

test("textual and streaming MIME detection", () => {
  for (const type of [
    "text/html; charset=utf-8",
    "application/json",
    "application/ld+json",
    "application/vnd.api+json",
    "application/xml",
    "image/svg+xml",
    "application/javascript",
  ]) {
    expect(isTextualMime(type)).toBe(true);
  }
  for (const type of ["image/png", "application/octet-stream", "application/pdf", "", undefined])
    expect(isTextualMime(type)).toBe(false);
  expect(isStreamingMime("text/event-stream; charset=utf-8")).toBe(true);
  expect(isStreamingMime("text/plain")).toBe(false);
});
