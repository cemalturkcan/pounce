import path from "node:path";
import { PACKAGE_DIR } from "../config/version.ts";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type Runner = (command: readonly string[]) => Promise<CommandResult>;

export function selfCommand(): string[] {
  return Bun.isStandaloneExecutable
    ? [process.execPath]
    : [process.execPath, path.join(PACKAGE_DIR, "src", "server.ts")];
}

export const runCommand: Runner = async (command) => {
  try {
    const child = Bun.spawn([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr };
  } catch (cause) {
    return {
      code: 127,
      stdout: "",
      stderr: cause instanceof Error ? cause.message : String(cause),
    };
  }
};
