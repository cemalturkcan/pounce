import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Runner } from "../cli/process.ts";
import { quotedWords, SAFE_WORD } from "../shared/words.ts";

const DESKTOP_ID = "pounce.desktop";

const KNOWN_BROWSERS =
  /^(google-chrome|chrome|chromium|brave|microsoft-edge|msedge|firefox|librewolf|vivaldi|opera|zen|epiphany|falkon|qutebrowser|floorp|waterfox|thorium|helium)/;

const SANDBOX_RUNNERS = new Set(["flatpak", "snap"]);

const DISPATCHES_TO_DEFAULT =
  /default[-_]?(web[-_]?)?browser|x-www-browser|sensible-browser|\$\{?BROWSER\b/i;

function execProgram(exec: string) {
  const words = quotedWords(exec);
  const start = words[0] === "env" || words[0]?.endsWith("/env") ? 1 : 0;
  return words.slice(start).find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
}

function startsWithShebang(file: string) {
  const head = Buffer.alloc(2);
  const fd = openSync(file, "r");
  try {
    return readSync(fd, head, 0, 2, 0) === 2 && head.toString() === "#!";
  } finally {
    closeSync(fd);
  }
}

function scriptText(file: string) {
  try {
    return statSync(file).isFile() && startsWithShebang(file)
      ? readFileSync(file, "utf8")
      : undefined;
  } catch {
    return undefined;
  }
}

function dispatchesToDefault(exec: string, env: NodeJS.ProcessEnv) {
  const program = execProgram(exec);
  if (!program) return false;
  const name = path.basename(program);
  if (SANDBOX_RUNNERS.has(name) || program.startsWith("/snap/") || KNOWN_BROWSERS.test(name))
    return false;
  const file = program.includes("/") ? program : Bun.which(program, { PATH: env.PATH ?? "" });
  const text = file ? scriptText(file) : undefined;
  return text !== undefined && DISPATCHES_TO_DEFAULT.test(text);
}

function execQuote(value: string) {
  const word = value.replaceAll("%", "%%");
  if (SAFE_WORD.test(value)) return word;
  return `"${word.replaceAll(/["`$\\]/g, "\\$&").replaceAll("\\", "\\\\")}"`;
}

function desktopEntry(command: readonly string[]) {
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
  if (exec && dispatchesToDefault(exec, env)) return { kind: "wrapper", current, exec };
  const set = await runner(["xdg-settings", "set", "default-web-browser", DESKTOP_ID]);
  if (set.code !== 0) return { kind: "failed", detail: set.stderr.trim() || `exit ${set.code}` };
  return { kind: "default" };
}
