import { expect, test } from "bun:test";
import { DIFF_WORKER_URL, SCRIPT_WORKER_URL } from "./workers.ts";

test("the script worker URL names a file that exists", async () => {
  expect(await Bun.file(SCRIPT_WORKER_URL).exists()).toBe(true);
});

test("the diff worker URL names a file that exists", async () => {
  expect(await Bun.file(DIFF_WORKER_URL).exists()).toBe(true);
});
