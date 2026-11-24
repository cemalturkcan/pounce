import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromeExecutable } from "../browser/chrome-path.ts";
import type { Config } from "../config/config.ts";

const CHECK_TIMEOUT_MS = 60_000;
const MARKER = "pounce-chrome-check";

export type ChromeCheck =
  | { ok: true; executable: string }
  | { ok: false; executable: string; detail: string };

export async function checkChrome(config: Config): Promise<ChromeCheck> {
  const executable = chromeExecutable(config);
  if (path.isAbsolute(executable) && !existsSync(executable))
    return { ok: false, executable, detail: "not found" };
  const profile = await mkdtemp(path.join(tmpdir(), "pounce-chrome-check-"));
  try {
    const child = Bun.spawn(
      [
        executable,
        "--headless",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        `--user-data-dir=${profile}`,
        ...(config.chromeSandbox ? [] : ["--no-sandbox"]),
        "--dump-dom",
        `data:text/html,<p>${MARKER}</p>`,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: CHECK_TIMEOUT_MS },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (stdout.includes(MARKER)) return { ok: true, executable };
    const last = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    return { ok: false, executable, detail: `exit ${code}${last ? `: ${last}` : ""}` };
  } catch (cause) {
    return {
      ok: false,
      executable,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
