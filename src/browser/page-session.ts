import type { CDPSession, Page } from "playwright-core";

type Closable = { once(event: "close", listener: () => void): void };

export function cachedSessions<Key extends object, Session extends Closable>(
  open: (key: Key) => Promise<Session>,
) {
  const sessions = new WeakMap<Key, Promise<Session>>();
  return (key: Key) => {
    const existing = sessions.get(key);
    if (existing) return existing;
    const opened = open(key);
    sessions.set(key, opened);
    const forget = () => {
      if (sessions.get(key) === opened) sessions.delete(key);
    };
    opened.then((session) => session.once("close", forget), forget);
    return opened;
  };
}

const openSession = (page: Page): Promise<CDPSession> => page.context().newCDPSession(page);

export const pageSession = cachedSessions(openSession);

export const screencastSession = cachedSessions(openSession);
