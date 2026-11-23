import { expect, test } from "bun:test";
import { isUserDownload, shouldRetainBody } from "./tab-watch.ts";

const idleUserTab = { owner: "browser", actions: [] };

test("a download in an unclaimed tab no tool is driving belongs to the user", () => {
  expect(isUserDownload(idleUserTab)).toBe(true);
});

test("a download in a session's tab belongs to the agent", () => {
  expect(isUserDownload({ ...idleUserTab, owner: "session-1" })).toBe(false);
});

test("a download in an orphaned agent tab belongs to the agent", () => {
  expect(isUserDownload({ ...idleUserTab, owner: "orphaned" })).toBe(false);
});

test("a download while a tool drives an unclaimed tab belongs to the agent", () => {
  expect(isUserDownload({ ...idleUserTab, actions: [{ tool: "click", owner: "session-1" }] })).toBe(
    false,
  );
});

test("a download while a script drives an unclaimed tab belongs to the agent", () => {
  expect(
    isUserDownload({
      ...idleUserTab,
      scripts: new Set([{ owner: "session-1", log: () => undefined }]),
    }),
  ).toBe(false);
});

test("a download in a tab save_pages left unattended belongs to the agent", () => {
  expect(isUserDownload({ ...idleUserTab, unattended: true })).toBe(false);
});

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
