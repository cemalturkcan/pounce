import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const SERVER_SCRIPT = path.join(PACKAGE_DIR, "src", "server.ts");

export const SERVER_VERSION = (JSON.parse(readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf8")) as { version: string }).version;
