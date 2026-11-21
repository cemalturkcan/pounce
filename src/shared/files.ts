import { readdir } from "node:fs/promises";

export function listDir(dir: string) {
  return readdir(dir).catch((): string[] => []);
}
