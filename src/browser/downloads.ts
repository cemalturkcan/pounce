import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config/config.ts";
import { parseJson } from "../shared/decode.ts";

type DownloadFolders = Pick<Config, "profileDir" | "homeDir" | "userDirsFile">;

const chromePreferences = z.object({
  download: z
    .object({ default_directory: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

async function chromeDownloadDir(profileDir: string) {
  const text = await readFile(path.join(profileDir, "Default", "Preferences"), "utf8").catch(
    () => undefined,
  );
  if (text === undefined) return undefined;
  return parseJson(text, chromePreferences).data?.download?.default_directory?.trim() || undefined;
}

async function xdgDownloadDir(userDirsFile: string, home: string) {
  const text = await readFile(userDirsFile, "utf8").catch(() => "");
  const value = /^XDG_DOWNLOAD_DIR="(.*)"\s*$/m.exec(text)?.[1]?.replace(/^\$HOME(?=\/|$)/, home);
  return value && path.isAbsolute(value) ? value : path.join(home, "Downloads");
}

export async function downloadFolder(folders: DownloadFolders) {
  return (
    (await chromeDownloadDir(folders.profileDir)) ??
    xdgDownloadDir(folders.userDirsFile, folders.homeDir)
  );
}

function numberedName(name: string, index: number) {
  if (index === 0) return name;
  const extension = path.extname(name);
  return `${name.slice(0, name.length - extension.length)} (${index})${extension}`;
}

function plainName(suggested: string) {
  const name = path.basename(suggested.replaceAll("\\", "/"));
  return name === "" || name === "." || name === ".." ? "download" : name;
}

async function claimFree(folder: string, name: string, index: number): Promise<string> {
  const target = path.join(folder, numberedName(name, index));
  const claimed = await writeFile(target, "", { flag: "wx" }).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false;
      throw error;
    },
  );
  return claimed ? target : claimFree(folder, name, index + 1);
}

export async function reserveDownload(folder: string, suggested: string) {
  await mkdir(folder, { recursive: true });
  return claimFree(folder, plainName(suggested), 0);
}
