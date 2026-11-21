import { expect, test } from "bun:test";
import { shouldRetainBody } from "./tab-watch.ts";

test("response bodies are fetched for agent tabs and watched tabs, never above the size limit", () => {
  const html = { "content-type": "text/html" };
  expect(shouldRetainBody({ owner: "session-1" }, html)).toBe(true);
  expect(shouldRetainBody({ owner: "orphaned" }, html)).toBe(true);
  expect(shouldRetainBody({ owner: "browser" }, html)).toBe(false);
  expect(shouldRetainBody({ owner: "browser", captureBodies: true }, html)).toBe(true);
  expect(
    shouldRetainBody(
      { owner: "session-1" },
      { ...html, "content-length": String(2 * 1024 * 1024) },
    ),
  ).toBe(false);
  expect(shouldRetainBody({ owner: "session-1" }, { "content-type": "image/png" })).toBe(false);
  expect(shouldRetainBody({ owner: "session-1" }, { "content-type": "text/event-stream" })).toBe(
    false,
  );
});
