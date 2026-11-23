import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { cachedSessions } from "./page-session.ts";

type FakePage = { name: string };

function opener(results: (() => Promise<EventEmitter>)[] = []) {
  const opened: EventEmitter[] = [];
  const open = async (_page: FakePage) => {
    const next = results.shift();
    if (next) return next();
    const session = new EventEmitter();
    opened.push(session);
    return session;
  };
  return { opened, open };
}

test("a page keeps one session across calls", async () => {
  const { opened, open } = opener();
  const sessionOf = cachedSessions(open);
  const page = { name: "a" };
  await sessionOf(page);
  await sessionOf(page);
  expect(opened.length).toBe(1);
});

test("each page gets its own session", async () => {
  const { open } = opener();
  const sessionOf = cachedSessions(open);
  expect(await sessionOf({ name: "a" })).not.toBe(await sessionOf({ name: "b" }));
});

test("a session that closed is replaced on the next call", async () => {
  const { open } = opener();
  const sessionOf = cachedSessions(open);
  const page = { name: "a" };
  const first = await sessionOf(page);
  first.emit("close");
  expect(await sessionOf(page)).not.toBe(first);
});

test("a session that failed to open is opened again on the next call", async () => {
  const { opened, open } = opener([async () => Promise.reject(new Error("target closed"))]);
  const sessionOf = cachedSessions(open);
  const page = { name: "a" };
  await sessionOf(page).catch(() => undefined);
  expect(opened).toContain(await sessionOf(page));
});
