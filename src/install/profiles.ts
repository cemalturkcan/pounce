import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseJson } from "../shared/decode.ts";

export const BROWSERS = [
  { id: "chrome", name: "Google Chrome", dir: ["google-chrome"] },
  { id: "chromium", name: "Chromium", dir: ["chromium"] },
  { id: "brave", name: "Brave", dir: ["BraveSoftware", "Brave-Browser"] },
  { id: "edge", name: "Microsoft Edge", dir: ["microsoft-edge"] },
] as const;

export type BrowserId = (typeof BROWSERS)[number]["id"];

export type BrowserProfile = {
  browser: BrowserId;
  browserName: string;
  userDataDir: string;
  dir: string;
  name: string;
  email?: string;
};

const localState = z.object({
  profile: z.object({
    info_cache: z.record(
      z.string(),
      z.object({ name: z.string().optional(), user_name: z.string().optional() }),
    ),
  }),
});

export function browserUserDataDir(id: BrowserId, configHome: string) {
  const browser = BROWSERS.find((candidate) => candidate.id === id);
  return path.join(configHome, ...(browser?.dir ?? []));
}

export function listProfiles(configHome: string): BrowserProfile[] {
  return BROWSERS.flatMap((browser) => {
    const userDataDir = path.join(configHome, ...browser.dir);
    let text: string;
    try {
      text = readFileSync(path.join(userDataDir, "Local State"), "utf8");
    } catch {
      return [];
    }
    const parsed = parseJson(text, localState);
    if (!parsed.success) return [];
    return Object.entries(parsed.data.profile.info_cache)
      .map(([dir, info]) => ({
        browser: browser.id,
        browserName: browser.name,
        userDataDir,
        dir,
        name: info.name || dir,
        email: info.user_name || undefined,
      }))
      .toSorted((left, right) => left.dir.localeCompare(right.dir));
  });
}

export function profileKey(profile: Pick<BrowserProfile, "browser" | "dir">) {
  return `${profile.browser}:${profile.dir}`;
}

export function describeProfile(profile: BrowserProfile) {
  return `${profile.browserName}: ${profile.name}${profile.email ? ` (${profile.email})` : ""}`;
}
