import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PACKAGE_DIR } from "../src/config/version.ts";

const STUB_CURL = `#!/bin/sh
echo "$*" >> "$STUB_DIR/curl.log"
out=""
url=""
while [ $# -gt 0 ]; do
    case "$1" in
        -o) out=$2; shift 2 ;;
        *) url=$1; shift ;;
    esac
done
case "$url" in
    */SHA256SUMS)
        sum=$(sha256sum "$STUB_DIR/pounce" | cut -d ' ' -f 1)
        printf '%s  pounce-linux-x64\\n%s  pounce-linux-arm64\\n' "$sum" "$sum" > "$out" ;;
    *) cp "$STUB_DIR/pounce" "$out" ;;
esac
`;

const STUB_POUNCE = `#!/bin/sh
echo "$*" > "$STUB_DIR/pounce.args"
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "pounce-install-script-"));
  await mkdir(path.join(dir, "bin"));
  await mkdir(path.join(dir, "home"));
  await writeFile(path.join(dir, "bin", "curl"), STUB_CURL);
  await chmod(path.join(dir, "bin", "curl"), 0o755);
  await writeFile(path.join(dir, "pounce"), STUB_POUNCE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runScript(script: string, args: string[] = []) {
  const child = Bun.spawn(["sh", "-s", "--", ...args], {
    stdin: new TextEncoder().encode(script),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`,
      HOME: path.join(dir, "home"),
      STUB_DIR: dir,
    },
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { stdout, code };
}

const installScript = () => readFile(path.join(PACKAGE_DIR, "install"), "utf8");

test("a copy cut off before its last line downloads nothing", async () => {
  const lines = (await installScript()).trimEnd().split("\n");
  await runScript(lines.slice(0, -1).join("\n"));

  expect(existsSync(path.join(dir, "curl.log"))).toBe(false);
});

test("without a terminal it runs pounce install with the options given", async () => {
  await runScript(await installScript(), ["-a", "claude"]);

  expect(await readFile(path.join(dir, "pounce.args"), "utf8")).toBe("install -a claude\n");
});

test("without a terminal it says pounce install runs without prompts", async () => {
  const { stdout } = await runScript(await installScript(), ["-a", "claude"]);

  expect(stdout).toContain("No terminal to ask from");
});
