import path from "node:path";
import { fileURLToPath } from "node:url";
import packageManifest from "../../package.json" with { type: "json" };

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SERVER_SCRIPT = path.join(PACKAGE_DIR, "src", "server.ts");

export const SERVER_VERSION = packageManifest.version;
