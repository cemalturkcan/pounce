import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseJsonOrThrow } from "../shared/decode.ts";

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SERVER_SCRIPT = path.join(PACKAGE_DIR, "src", "server.ts");

const packageManifest = z.object({ version: z.string() });

export const SERVER_VERSION = parseJsonOrThrow(
  readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8"),
  packageManifest,
).version;
