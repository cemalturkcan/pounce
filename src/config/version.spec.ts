import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "./config.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { PACKAGE_DIR, SERVER_VERSION } from "./version.ts";

test("server version comes from package.json", async () => {
  const pkg = parseJsonOrThrow(
    await readFile(path.join(PACKAGE_DIR, "package.json"), "utf8"),
    z.object({ version: z.string() }),
  );
  expect(SERVER_VERSION).toBe(pkg.version);
  expect(loadConfig({}).serverVersion).toBe(pkg.version);
});
