import { expect, test } from "bun:test";
import { sleep } from "../shared/async.ts";
import { ConsoleHookScript, installConsoleHook, rejectionSource } from "./page-hooks.ts";

function scriptContext() {
  const registered = new Set<{ sites: string[] }>();
  const context = {
    addInitScript: async (_script: typeof installConsoleHook, argument: { sites: string[] }) => {
      await sleep(5);
      const entry = { sites: argument.sites };
      registered.add(entry);
      return {
        dispose: async () => {
          await sleep(5);
          registered.delete(entry);
        },
      };
    },
  };
  return { context, registered };
}

async function chooseConcurrently() {
  const { context, registered } = scriptContext();
  const hook = new ConsoleHookScript("all");
  await hook.apply(context, []);
  await Promise.all([
    hook.choose(async () => ["race1.example"]),
    hook.choose(async () => ["race1.example", "race2.example"]),
    hook.choose(async () => []),
  ]);
  return [...registered];
}

test("three concurrent site choices leave one console hook script registered", async () => {
  expect((await chooseConcurrently()).length).toBe(1);
});

test("the console hook script left after concurrent choices carries the last choice", async () => {
  expect((await chooseConcurrently())[0]?.sites).toStrictEqual([]);
});

test("an unhandled rejection names the first frame of its stack as its source", () => {
  expect(
    rejectionSource(
      "Unhandled rejection: Error: late\n    at load (https://shop.example/app.js:12:7)\n    at https://shop.example/app.js:30:1",
    ),
  ).toBe("https://shop.example/app.js:12:7");
});

test("an unhandled rejection with a frame outside a function names that frame", () => {
  expect(
    rejectionSource("Unhandled rejection: Error: late\n    at https://shop.example/page:4:9"),
  ).toBe("https://shop.example/page:4:9");
});

test("an unhandled rejection without a stack has no source", () => {
  expect(rejectionSource("Unhandled rejection: plain reason")).toBeUndefined();
});

test("an uncaught error entry gets no source from its text", () => {
  expect(
    rejectionSource("boom\n    at https://shop.example/app.js:1:1 https://shop.example/app.js 1"),
  ).toBeUndefined();
});

test("an unhandled rejection on a data URL page names the whole data URL frame", () => {
  expect(
    rejectionSource(
      "Unhandled rejection: Error: rej9\n    at data:text/html,<script>Promise.reject(new Error('rej9'))</script><p>x</p>:1:41",
    ),
  ).toBe("data:text/html,<script>Promise.reject(new Error('rej9'))</script><p>x</p>:1:41");
});

test("an unhandled rejection in a function on a data URL page names the frame inside the parentheses", () => {
  expect(
    rejectionSource(
      "Unhandled rejection: Error: rej9\n    at run (data:text/html,<script>(function run() { Promise.reject(new Error('x')) })()</script>:1:30)",
    ),
  ).toBe(
    "data:text/html,<script>(function run() { Promise.reject(new Error('x')) })()</script>:1:30",
  );
});
