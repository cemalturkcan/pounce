import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Runner } from "../cli/process.ts";

export const DESKTOP_ID = "pounce.desktop";

const KNOWN_BROWSERS =
  /^(google-chrome|chrome|chromium|brave|microsoft-edge|msedge|firefox|librewolf|vivaldi|opera|zen|epiphany|falkon|qutebrowser|floorp|waterfox|thorium|helium)/;

function execQuote(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `"${value.replaceAll(/["`$\\]/g, "\\$&")}"`;
}

export function desktopEntry(command: readonly string[]) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=pounce",
    "GenericName=Agent browser",
    "Comment=Open links in the browser your AI agents share",
    `Exec=${[...command, "open"].map(execQuote).join(" ")} %U`,
    "Terminal=false",
    "Icon=web-browser",
    "Categories=Network;WebBrowser;",
    "MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;",
    "",
  ].join("\n");
}

function applicationDirs(dataHome: string, env: NodeJS.ProcessEnv) {
  const system = (env.XDG_DATA_DIRS?.trim() || "/usr/local/share:/usr/share")
    .split(":")
    .filter(Boolean);
  return [dataHome, ...system].map((dir) => path.join(dir, "applications"));
}

function execOf(desktopId: string, dataHome: string, env: NodeJS.ProcessEnv) {
  for (const dir of applicationDirs(dataHome, env)) {
    const file = path.join(dir, desktopId);
    if (!existsSync(file)) continue;
    const exec = /^Exec=(.*)$/m.exec(readFileSync(file, "utf8"))?.[1];
    if (exec) return exec.trim();
  }
  return undefined;
}

export type DesktopResult =
  | { kind: "default" }
  | { kind: "already" }
  | { kind: "wrapper"; current: string; exec: string }
  | { kind: "failed"; detail: string };

export async function installDesktop(
  command: readonly string[],
  dataHome: string,
  env: NodeJS.ProcessEnv,
  runner: Runner,
): Promise<DesktopResult> {
  const dir = path.join(dataHome, "applications");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, DESKTOP_ID), desktopEntry(command));
  await runner(["update-desktop-database", dir]);
  const current = (await runner(["xdg-settings", "get", "default-web-browser"])).stdout.trim();
  if (current === DESKTOP_ID) return { kind: "already" };
  const exec = current ? execOf(current, dataHome, env) : undefined;
  const program = path.basename(exec?.split(/\s+/)[0]?.replaceAll('"', "") ?? "");
  if (exec && program && !KNOWN_BROWSERS.test(program)) return { kind: "wrapper", current, exec };
  const set = await runner(["xdg-settings", "set", "default-web-browser", DESKTOP_ID]);
  if (set.code !== 0) return { kind: "failed", detail: set.stderr.trim() || `exit ${set.code}` };
  return { kind: "default" };
}
