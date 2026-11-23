import { expect, test } from "bun:test";
import {
  checkedSentence,
  logEntryLine,
  quietCurrentSentence,
  shownLogEntry,
  uncapturedNote,
} from "./logs.ts";

const stealth = { engine: "patchright", consoleHook: "local" } as const;
const capturingExample = { ...stealth, consoleSites: ["example.com"] };

test("there is no note on a site whose console capture was turned on with site", () => {
  expect(uncapturedNote(capturingExample, ["https://shop.example.com/a"])).toBeUndefined();
});

test("console capture turned on for one site leaves the note on other sites", () => {
  expect(uncapturedNote(capturingExample, ["https://shop.other.test.example/a"])).toMatch(
    /are not captured on this site \(/,
  );
});

test("the note says how to turn on console capture for the site and to reload afterwards", () => {
  expect(uncapturedNote(stealth, ["https://shop.example.com/a"])).toMatch(
    /To capture console calls too, call site with site example\.com and console_capture true, then reload the page/,
  );
});

test("an empty result on a site with console capture turned on says its console calls were checked", () => {
  expect(checkedSentence(capturingExample, ["https://shop.example.com/a"])).toBe(
    "Checked the console calls, uncaught errors and unhandled rejections of the pages on shop.example.com.",
  );
});

test("the note names the site it applies to when the pages listed come from several sites", () => {
  expect(uncapturedNote(stealth, ["http://localhost:3000/", "https://shop.example/cart"])).toMatch(
    /are not captured on shop\.example \(/,
  );
});

test("the note names every uncaptured site when several are listed", () => {
  expect(
    uncapturedNote(stealth, ["https://shop.example/cart", "https://pay.example:8443/checkout"]),
  ).toMatch(/are not captured on shop\.example and pay\.example:8443 \(/);
});

test("the note says this site when every page listed comes from one site", () => {
  expect(uncapturedNote(stealth, ["https://shop.example/a", "https://shop.example/b"])).toMatch(
    /are not captured on this site \(/,
  );
});

test("a page that is not on the web does not count as another site", () => {
  expect(uncapturedNote(stealth, ["about:blank", "https://shop.example/a"])).toMatch(
    /are not captured on this site \(/,
  );
});

test("there is no note when every page listed is captured", () => {
  expect(uncapturedNote(stealth, ["http://localhost:3000/", "http://app.test/"])).toBeUndefined();
});

test("the note says that a page leaving within a few milliseconds of loading may lose its errors", () => {
  expect(uncapturedNote(stealth, ["https://shop.example/a"])).toMatch(
    /errors of a page that navigates away within a few milliseconds of loading/,
  );
});

test("an empty result names the site whose pages it checked", () => {
  expect(checkedSentence(stealth, ["about:blank", "http://localhost:3000/a"])).toBe(
    "Checked the console calls, uncaught errors and unhandled rejections of the pages on localhost:3000.",
  );
});

test("an empty result names what it checked on each site", () => {
  expect(checkedSentence(stealth, ["http://localhost:3000/a", "https://shop.example/b"])).toBe(
    "Checked the console calls, uncaught errors and unhandled rejections of the pages on localhost:3000, and the uncaught errors and unhandled rejections of the pages on shop.example.",
  );
});

test("an empty result for a tab that showed no web page names the pages this tab showed", () => {
  expect(checkedSentence(stealth, ["about:blank"])).toBe(
    "Checked the console calls, uncaught errors and unhandled rejections of the pages this tab showed.",
  );
});

test("with new_only, a current page without new entries is said to have no new entries", () => {
  expect(quietCurrentSentence("https://shop.example/a", { filtered: false, newOnly: true })).toBe(
    "No new entries from the current page (https://shop.example/a).",
  );
});

const dataPage = "data:text/html,<title>d9</title><p>data9</p>";
const rejection = {
  time: "2026-11-22T07:00:00.000Z",
  level: "error",
  url: dataPage,
  text: `Unhandled rejection: Error: rej9\n    at ${dataPage}:1:41`,
  source: `${dataPage}:1:41`,
};

test("a log entry on a data URL page names that URL in its short form", () => {
  expect(shownLogEntry(rejection).text).toBe(
    `Unhandled rejection: Error: rej9\n    at data:text/html… (${dataPage.length} chars):1:41`,
  );
});

test("a log entry whose text names its source keeps the source in short form", () => {
  expect(shownLogEntry(rejection).source).toBe(`data:text/html… (${dataPage.length} chars):1:41`);
});

test("a log entry whose text was cut inside its data URL source names that source in short form", () => {
  const longPage = `data:text/html,<p>${"x".repeat(2500)}</p>`;
  const text = `Uncaught Error: thrown10\n    at ${longPage}:1:83`.slice(0, 2000);
  expect(
    shownLogEntry({ ...rejection, url: longPage, text, source: `${longPage}:1:83` }).text,
  ).toBe(`Uncaught Error: thrown10\n    at data:text/html… (${longPage.length} chars):1:83`);
});

test("a log entry whose text was cut inside a lower stack frame's data URL leaves out the top frame's position there", () => {
  const page = `data:text/html,<p>${"x".repeat(1200)}</p>`;
  const short = `data:text/html… (${page.length} chars)`;
  const text = `Error: boom\n    at inner (${page}:1:300)\n    at outer (${page}:1:900)`.slice(
    0,
    2000,
  );
  expect(shownLogEntry({ ...rejection, url: page, text, source: `${page}:1:300` }).text).toBe(
    `Error: boom\n    at inner (${short}:1:300)\n    at outer (${short}`,
  );
});

test("a log line whose text names its source does not repeat it", () => {
  expect(logEntryLine(rejection)).toEndWith(
    `rej9\n    at data:text/html… (${dataPage.length} chars):1:41`,
  );
});

test("a log entry whose text does not name its source keeps the source in short form", () => {
  expect(shownLogEntry({ ...rejection, text: "Uncaught Error: thr" }).source).toBe(
    `data:text/html… (${dataPage.length} chars):1:41`,
  );
});
