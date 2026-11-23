import { expect, test } from "bun:test";
import {
  type ConsoleLog,
  deliveryDocument,
  type DocumentLog,
  documentCommitted,
  forgetEvent,
  documentOrder,
  messageDocument,
  movedTo,
  navigationAbandoned,
  navigationRequested,
  navigationResponded,
  pushConsole,
  readConsole,
  reconcileDocument,
  stackSource,
  upsertConsole,
} from "./tab.ts";

function consoleLog(): ConsoleLog {
  return { console: [], consoleSeq: 0, consoleReads: new Map() };
}

function logLine(log: ConsoleLog, text: string) {
  pushConsole(log, {
    level: "log",
    text,
    time: new Date().toISOString(),
    url: "https://a.test/",
    documentId: 0,
  });
}

function texts(log: ConsoleLog, owner: string, newOnly: boolean) {
  return readConsole(log, owner, newOnly).map((entry) => entry.text);
}

test("a first read of new entries returns everything captured", () => {
  const log = consoleLog();
  logLine(log, "one");
  logLine(log, "two");
  expect(texts(log, "a", true)).toStrictEqual(["one", "two"]);
});

test("a read of new entries returns only what arrived since the caller's last read", () => {
  const log = consoleLog();
  logLine(log, "one");
  texts(log, "a", true);
  logLine(log, "two");
  expect(texts(log, "a", true)).toStrictEqual(["two"]);
});

test("another caller's read leaves this caller's cursor in place", () => {
  const log = consoleLog();
  logLine(log, "one");
  texts(log, "b", true);
  expect(texts(log, "a", true)).toStrictEqual(["one"]);
});

test("a full read also moves the caller's cursor", () => {
  const log = consoleLog();
  logLine(log, "one");
  texts(log, "a", false);
  logLine(log, "two");
  expect(texts(log, "a", true)).toStrictEqual(["two"]);
});

test("a full read returns entries already read", () => {
  const log = consoleLog();
  logLine(log, "one");
  texts(log, "a", true);
  expect(texts(log, "a", false)).toStrictEqual(["one"]);
});

function keyedLine(
  log: ConsoleLog,
  key: string,
  text: string,
  source?: string,
  options: { keepKnown?: boolean } = {},
) {
  upsertConsole(
    log,
    {
      key,
      level: "error",
      text,
      source,
      time: new Date().toISOString(),
      url: "https://a.test/",
      documentId: 0,
    },
    options,
  );
}

test("an entry delivered again with the same key replaces the first delivery", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: boom");
  keyedLine(log, "doc:1", "Unhandled rejection: Error: boom\n    at x (https://a.test/app.js:1:2)");
  expect(texts(log, "a", false)).toStrictEqual([
    "Unhandled rejection: Error: boom\n    at x (https://a.test/app.js:1:2)",
  ]);
});

test("an entry delivered again takes the source of the later delivery", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: boom");
  keyedLine(log, "doc:1", "Unhandled rejection: Error: boom", "https://a.test/app.js:1:2");
  expect(readConsole(log, "a", false).map((entry) => entry.source)).toStrictEqual([
    "https://a.test/app.js:1:2",
  ]);
});

test("a delivery that keeps a known entry leaves the full text in place", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: Error: boom\n    at x (https://a.test/app.js:1:2)");
  keyedLine(log, "doc:1", "Unhandled rejection: boom", undefined, { keepKnown: true });
  expect(texts(log, "a", false)).toStrictEqual([
    "Unhandled rejection: Error: boom\n    at x (https://a.test/app.js:1:2)",
  ]);
});

test("a delivery that keeps a known entry leaves the full source in place", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: Error: boom", "https://a.test/app.js:1:2");
  keyedLine(log, "doc:1", "Unhandled rejection: boom", undefined, { keepKnown: true });
  expect(readConsole(log, "a", false).map((entry) => entry.source)).toStrictEqual([
    "https://a.test/app.js:1:2",
  ]);
});

test("a delivery that keeps known entries still adds a new key", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: boom", undefined, { keepKnown: true });
  expect(texts(log, "a", false)).toStrictEqual(["Unhandled rejection: boom"]);
});

test("entries with different keys are both kept", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "one");
  keyedLine(log, "doc:2", "two");
  expect(texts(log, "a", false)).toStrictEqual(["one", "two"]);
});

test("an entry delivered again is not new for a caller that already read it", () => {
  const log = consoleLog();
  keyedLine(log, "doc:1", "Unhandled rejection: boom");
  texts(log, "a", true);
  keyedLine(log, "doc:1", "Unhandled rejection: Error: boom");
  expect(texts(log, "a", true)).toStrictEqual([]);
});

test("the source of an error is the first frame of its stack", () => {
  expect(
    stackSource(
      "Error: boom\n    at load (http://127.0.0.1:3000/app.js:12:5)\n    at http://127.0.0.1:3000/main.js:1:1",
    ),
  ).toBe("http://127.0.0.1:3000/app.js:12:5");
});

test("an anonymous first frame is read as the source", () => {
  expect(stackSource("Error: boom\n    at http://127.0.0.1:3000/app.js:7:9")).toBe(
    "http://127.0.0.1:3000/app.js:7:9",
  );
});

test("an error thrown on a data URL page names the whole data URL frame", () => {
  expect(
    stackSource("Error: x\n    at data:text/html,<p>a (b)</p><script>throw 1</script>:1:20"),
  ).toBe("data:text/html,<p>a (b)</p><script>throw 1</script>:1:20");
});

test("an async frame names the location inside its parentheses", () => {
  expect(stackSource("Error: x\n    at async load (https://a.test/app.js:3:4)")).toBe(
    "https://a.test/app.js:3:4",
  );
});

test("a stack without a located frame has no source", () => {
  expect(stackSource("Error: boom\n    at <anonymous>")).toBeUndefined();
});

test("a tab now at another URL than last seen has moved there", () => {
  expect(movedTo("https://a.test/one", "https://a.test/two", "https://a.test/two")).toBe(
    "https://a.test/two",
  );
});

test("a tab still at the URL last seen has not moved", () => {
  expect(movedTo("https://a.test/one", "https://a.test/one", "https://a.test/one")).toBeUndefined();
});

test("a tab whose URL differs from the one last seen only in query parameter order has not moved", () => {
  expect(
    movedTo(
      "https://a.test/list?b=2&a=1",
      "https://a.test/list?a=1&b=2",
      "https://a.test/list?a=1&b=2",
    ),
  ).toBeUndefined();
});

test("a tab whose URL differs from the one last seen in a query parameter value has moved", () => {
  expect(
    movedTo(
      "https://a.test/list?a=1&b=2",
      "https://a.test/list?a=1&b=3",
      "https://a.test/list?a=1&b=3",
    ),
  ).toBe("https://a.test/list?a=1&b=3");
});

test("Chrome's error page for the URL last seen is no move", () => {
  expect(
    movedTo("https://a.test/missing", "chrome-error://chromewebdata/", "https://a.test/missing"),
  ).toBeUndefined();
});

test("Chrome's error page for another URL than last seen is a move", () => {
  expect(
    movedTo("https://a.test/one", "chrome-error://chromewebdata/", "https://a.test/gone"),
  ).toBe("chrome-error://chromewebdata/");
});

test("a data URL whose body differs only in the order of what looks like query parameters is a move", () => {
  expect(movedTo("data:text/html,<p>?b=1&a=2", "data:text/html,<p>?a=2&b=1", undefined)).toBe(
    "data:text/html,<p>?a=2&b=1",
  );
});

test("a tab never seen has not moved", () => {
  expect(movedTo(undefined, "https://a.test/two", undefined)).toBeUndefined();
});

test("forgetEvent removes the event a result already reported and keeps the others", () => {
  const tab = {
    events: [
      { at: 1, text: "download saved to /d/a.csv" },
      { at: 2, text: "opened new tab t2" },
    ],
  };
  forgetEvent(tab, "download saved to /d/a.csv");
  expect(tab.events.map((event) => event.text)).toStrictEqual(["opened new tab t2"]);
});

test("an entry keeps the url of the page it was captured on", () => {
  const log = consoleLog();
  pushConsole(log, {
    level: "log",
    text: "one",
    time: "t",
    url: "https://first.test/",
    documentId: 0,
  });
  pushConsole(log, {
    level: "log",
    text: "two",
    time: "t",
    url: "https://second.test/",
    documentId: 1,
  });
  expect(readConsole(log, "a", false).map((entry) => entry.url)).toStrictEqual([
    "https://first.test/",
    "https://second.test/",
  ]);
});

function documentLog(url = "about:blank"): DocumentLog {
  return { documents: [{ id: 0, url }], currentDocument: 0 };
}

const currentUrl = (log: DocumentLog) =>
  log.documents.find((document) => document.id === log.currentDocument)?.url;

function navigate(log: DocumentLog, url: string) {
  const id = navigationRequested(log, url, false);
  navigationResponded(log, id);
  documentCommitted(log, url);
  return id;
}

test("a navigation that sends no request, as to a data URL, opens its own current document", () => {
  const log = documentLog("https://a.test/");
  documentCommitted(log, "data:text/html,<p>x</p>");
  expect(currentUrl(log)).toBe("data:text/html,<p>x</p>");
});

test("a second load of the same URL is a document of its own", () => {
  const log = documentLog();
  const first = navigate(log, "https://a.test/");
  expect(navigate(log, "https://a.test/")).not.toBe(first);
});

test("the document a navigation requested becomes current when it commits", () => {
  const log = documentLog();
  const id = navigate(log, "https://a.test/");
  expect(log.currentDocument).toBe(id);
});

test("a commit at the requested URL with a fragment is the requested document", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/page", false);
  navigationResponded(log, id);
  documentCommitted(log, "https://a.test/page#part");
  expect(log.currentDocument).toBe(id);
});

test("a page restored from the back/forward cache is the document it was before", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/", false);
  navigationResponded(log, id);
  documentCommitted(log, "https://a.test/", { loaderId: "first" });
  navigate(log, "https://b.test/");
  documentCommitted(log, "https://a.test/", { loaderId: "first", restored: true });
  expect(log.currentDocument).toBe(id);
});

test("a restored page whose document is no longer kept opens a document of its own", () => {
  const log = documentLog();
  const id = navigate(log, "https://a.test/");
  documentCommitted(log, "https://a.test/", { loaderId: "forgotten", restored: true });
  expect(log.currentDocument).not.toBe(id);
});

test("pages are ordered oldest first with the current page last", () => {
  const log = documentLog();
  const restored = navigationRequested(log, "https://a.test/", false);
  navigationResponded(log, restored);
  documentCommitted(log, "https://a.test/", { loaderId: "first" });
  const left = navigate(log, "https://b.test/");
  documentCommitted(log, "https://a.test/", { loaderId: "first", restored: true });
  expect(documentOrder(log, [left, restored, 0])).toStrictEqual([0, left, restored]);
});

test("a redirect keeps the requested document and takes the new URL", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/old", false);
  navigationRequested(log, "https://a.test/new", true);
  navigationResponded(log, id);
  documentCommitted(log, "https://a.test/new");
  expect(currentUrl(log)).toBe("https://a.test/new");
});

test("a message Chrome logs after the navigation's response belongs to the new document", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/", false);
  navigationResponded(log, id);
  expect(messageDocument(log, true)).toBe(id);
});

test("a message of the page after the navigation's response belongs to the page still shown", () => {
  const log = documentLog();
  navigationResponded(log, navigationRequested(log, "https://a.test/", false));
  expect(messageDocument(log, false)).toBe(0);
});

test("a request after a navigation answered with no content belongs to the page still shown", () => {
  const log = documentLog();
  navigationResponded(log, navigationRequested(log, "https://a.test/no-content", false), 204);
  expect(messageDocument(log, true)).toBe(0);
});

test("a request after a redirect that ends in no content belongs to the page still shown", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/to-no-content", false);
  navigationResponded(log, id, 302);
  navigationResponded(log, navigationRequested(log, "https://a.test/no-content", true), 204);
  expect(messageDocument(log, true)).toBe(0);
});

test("a navigation answered with no content leaves no page of its own", () => {
  const log = documentLog();
  navigationResponded(log, navigationRequested(log, "https://a.test/no-content", false), 204);
  expect(log.documents.map((document) => document.url)).toEqual(["about:blank"]);
});

test("a navigation answered with no content is owned by the page still shown", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/no-content", false);
  expect(navigationResponded(log, id, 204)).toBe(0);
});

test("a redirect that ends in no content leaves no page of its own", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/to-no-content", false);
  navigationResponded(log, id, 302);
  navigationResponded(log, navigationRequested(log, "https://a.test/no-content", true), 204);
  expect(log.documents.map((document) => document.url)).toEqual(["about:blank"]);
});

test("a navigation answered with a page is owned by its own document", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/", false);
  expect(navigationResponded(log, id, 200)).toBe(id);
});

test("a request after a navigation that failed after its response belongs to the page still shown", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/cancelled", false);
  navigationResponded(log, id, 200);
  navigationAbandoned(log, id);
  expect(messageDocument(log, true)).toBe(0);
});

test("an earlier navigation ending keeps the navigation that replaced it committing", () => {
  const log = documentLog();
  const earlier = navigationRequested(log, "https://a.test/one", false);
  const later = navigationRequested(log, "https://a.test/two", false);
  navigationResponded(log, later);
  navigationAbandoned(log, earlier);
  expect(messageDocument(log, true)).toBe(later);
});

test("a message Chrome logs while the navigation still waits for its response belongs to the page still shown", () => {
  const log = documentLog();
  navigationRequested(log, "https://a.test/", false);
  expect(messageDocument(log, true)).toBe(0);
});

test("a delivery from the current page's URL belongs to the current document", () => {
  const log = documentLog();
  navigate(log, "https://a.test/");
  const second = navigate(log, "https://a.test/");
  expect(deliveryDocument(log, "https://a.test/")).toBe(second);
});

test("a late delivery from the first of two loads of the same URL belongs to the first load", () => {
  const log = documentLog();
  const first = navigate(log, "https://a.test/");
  navigate(log, "https://a.test/");
  expect(deliveryDocument(log, "https://a.test/", first)).toBe(first);
});

test("a delivery from an earlier page's URL belongs to that page's latest document", () => {
  const log = documentLog();
  const earlier = navigate(log, "https://a.test/one");
  navigate(log, "https://a.test/two");
  expect(deliveryDocument(log, "https://a.test/one")).toBe(earlier);
});

test("a delivery from a URL no document has, as after pushState, belongs to the current document", () => {
  const log = documentLog();
  const current = navigate(log, "https://a.test/one");
  expect(deliveryDocument(log, "https://a.test/pushed")).toBe(current);
});

test("a commit seen late, after the session started, still makes the requested document current", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/", false);
  navigationResponded(log, id);
  reconcileDocument(log, "https://a.test/");
  expect(log.currentDocument).toBe(id);
});

test("reconciling at the current document's URL keeps the current document", () => {
  const log = documentLog();
  const id = navigate(log, "https://a.test/");
  reconcileDocument(log, "https://a.test/");
  expect(log.currentDocument).toBe(id);
});

test("reconciling while a navigation has a response but has not committed keeps the page still shown", () => {
  const log = documentLog("https://a.test/");
  navigationResponded(log, navigationRequested(log, "https://b.test/", false));
  reconcileDocument(log, "https://a.test/");
  expect(log.currentDocument).toBe(0);
});

test("Chrome's error page for a failed navigation is the document that navigation requested", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://unresolvable.test/", false);
  documentCommitted(log, "chrome-error://chromewebdata/");
  expect(log.currentDocument).toBe(id);
});

test("Chrome's error page for a response it cannot show is the document of that response", () => {
  const log = documentLog();
  const id = navigationRequested(log, "https://a.test/empty-404", false);
  navigationResponded(log, id);
  documentCommitted(log, "chrome-error://chromewebdata/");
  expect(log.currentDocument).toBe(id);
});
