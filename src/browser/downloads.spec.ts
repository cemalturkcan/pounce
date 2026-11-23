import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadFolder, reserveDownload } from "./downloads.ts";

let home = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "downloads-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function folders() {
  return {
    profileDir: path.join(home, "profile"),
    homeDir: home,
    userDirsFile: path.join(home, ".config", "user-dirs.dirs"),
  };
}

async function writePreferences(text: string) {
  await mkdir(path.join(home, "profile", "Default"), { recursive: true });
  await writeFile(path.join(home, "profile", "Default", "Preferences"), text);
}

async function writeUserDirs(text: string) {
  await mkdir(path.join(home, ".config"), { recursive: true });
  await writeFile(path.join(home, ".config", "user-dirs.dirs"), text);
}

test("the folder is Chrome's download directory from the profile preferences", async () => {
  await writePreferences(JSON.stringify({ download: { default_directory: "/data/chrome-saves" } }));
  expect(await downloadFolder(folders())).toBe("/data/chrome-saves");
});

test("the folder is the XDG download directory when Chrome has none set", async () => {
  await writePreferences(JSON.stringify({ download: { prompt_for_download: false } }));
  await writeUserDirs('XDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOWNLOAD_DIR="$HOME/İndirilenler"\n');
  expect(await downloadFolder(folders())).toBe(path.join(home, "İndirilenler"));
});

test("the folder is the XDG download directory when the preferences are not JSON", async () => {
  await writePreferences("{ not json");
  await writeUserDirs('XDG_DOWNLOAD_DIR="/srv/inbox"\n');
  expect(await downloadFolder(folders())).toBe("/srv/inbox");
});

test("the folder is Downloads in the home folder when neither is set", async () => {
  expect(await downloadFolder(folders())).toBe(path.join(home, "Downloads"));
});

test("a download keeps its suggested name in a free folder", async () => {
  const target = await reserveDownload(path.join(home, "Downloads"), "report.csv");
  expect(target).toBe(path.join(home, "Downloads", "report.csv"));
});

test("a taken name gets a number before the extension like Chrome", async () => {
  const folder = path.join(home, "Downloads");
  await reserveDownload(folder, "report.csv");
  await reserveDownload(folder, "report.csv");
  expect(path.basename(await reserveDownload(folder, "report.csv"))).toBe("report (2).csv");
});

test("a taken name without an extension gets the number at its end", async () => {
  const folder = path.join(home, "Downloads");
  await reserveDownload(folder, "LICENSE");
  expect(path.basename(await reserveDownload(folder, "LICENSE"))).toBe("LICENSE (1)");
});

test("downloads that start together get different names", async () => {
  const folder = path.join(home, "Downloads");
  await Promise.all([1, 2, 3].map(() => reserveDownload(folder, "a.txt")));
  expect((await readdir(folder)).toSorted()).toEqual(["a (1).txt", "a (2).txt", "a.txt"]);
});

test("a suggested name with folders in it stays inside the download folder", async () => {
  const folder = path.join(home, "Downloads");
  expect(await reserveDownload(folder, "../../etc/passwd")).toBe(path.join(folder, "passwd"));
});
