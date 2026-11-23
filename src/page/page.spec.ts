import { expect, test } from "bun:test";
import { autoView, historyReason, noResponseNote, statusNote } from "./page.ts";

test("statusNote gives the HTTP status", () => {
  expect(statusNote(404, [])).toBe("(HTTP 404)");
});

test("statusNote names the URL a single redirect came from", () => {
  expect(statusNote(200, ["http://a.test/old"])).toBe(
    "(HTTP 200, redirected from http://a.test/old)",
  );
});

test("statusNote counts the steps of a redirect chain", () => {
  expect(statusNote(200, ["http://a.test/1", "http://a.test/2"])).toBe(
    "(HTTP 200, redirected from http://a.test/1 in 2 steps)",
  );
});

test("noResponseNote says a page reached through history came from the back/forward cache", () => {
  expect(noResponseNote("https://a.test/links", "cache")).toBe("(from the back/forward cache)");
});

test("noResponseNote says a navigation without a response stayed in the same document", () => {
  expect(noResponseNote("https://a.test/links#part", "same-document")).toBe(
    "(same document, no new request)",
  );
});

test("noResponseNote gives nothing while it is unknown which document the tab shows", () => {
  expect(noResponseNote("https://a.test/next", "unknown")).toBe("");
});

test("noResponseNote gives nothing for a data URL, which has no HTTP status", () => {
  expect(noResponseNote("data:text/html,<p>hi</p>", "same-document")).toBe("");
});

test("historyReason calls a history step that kept the document a same-document move", () => {
  expect(historyReason(1000.5, 1000.5)).toBe("same-document");
});

test("historyReason calls a history step to another document without a response a cache restore", () => {
  expect(historyReason(1000.5, 900.25)).toBe("cache");
});

test("historyReason gives unknown when the document could not be read", () => {
  expect(historyReason(1000.5, undefined)).toBe("unknown");
});

const pageSnapshot = [
  "- banner [ref=e1]:",
  '  - link "Home" [ref=e2]',
  "- main [ref=e3]:",
  '  - button "Delete account" [ref=e4]',
  '- dialog "Leave?" [ref=e5]:',
  '  - button "Stay" [ref=e6]',
].join("\n");

const noModal = {
  modalFlags: async () => [],
  snapshotOf: async () => "",
};

test("a snapshot whose dialog lookup fails shows the view without a dialog", async () => {
  const failing = {
    modalFlags: async () => {
      throw new Error("Execution context was destroyed");
    },
    snapshotOf: async () => "",
  };
  expect(await autoView(failing, pageSnapshot)).toEqual(await autoView(noModal, pageSnapshot));
});

test("a snapshot whose dialog closed before it was read shows the view without a dialog", async () => {
  const closed = {
    modalFlags: async () => [true],
    snapshotOf: async (_index: number, timeout: number) => {
      await Bun.sleep(Math.min(timeout, 3000));
      throw new Error("Timeout exceeded");
    },
  };
  expect(await autoView(closed, pageSnapshot)).toEqual(await autoView(noModal, pageSnapshot));
});

test("a snapshot whose dialog closed before it was read does not wait long for it", async () => {
  const closed = {
    modalFlags: async () => [true],
    snapshotOf: async (_index: number, timeout: number) => {
      await Bun.sleep(Math.min(timeout, 3000));
      throw new Error("Timeout exceeded");
    },
  };
  const startedAt = Date.now();
  await autoView(closed, pageSnapshot);
  expect(Date.now() - startedAt).toBeLessThan(2000);
});

test("a snapshot with an open modal is scoped to it", async () => {
  const open = {
    modalFlags: async () => [true],
    snapshotOf: async () => '- dialog "Leave?" [ref=e5]:\n  - button "Stay" [ref=e6]',
  };
  expect((await autoView(open, pageSnapshot)).text).toBe(
    '- dialog "Leave?" [ref=e5]:\n  - button "Stay" [ref=e6]',
  );
});
