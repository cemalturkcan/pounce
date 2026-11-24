import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DIFF_WORKER_URL, SCRIPT_WORKER_URL } from "./workers.ts";

test("the script worker URL names the script worker source", () => {
  expect(fileURLToPath(SCRIPT_WORKER_URL)).toBe(
    fileURLToPath(new URL("./script/worker.ts", import.meta.url)),
  );
});

test("the diff worker URL names the diff worker source", () => {
  expect(fileURLToPath(DIFF_WORKER_URL)).toBe(
    fileURLToPath(new URL("./visual/diff-worker.ts", import.meta.url)),
  );
});
