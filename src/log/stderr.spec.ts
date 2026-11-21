import { expect, test } from "bun:test";
import { spawn } from "node:child_process";

async function runWriting(text: string) {
  const stderrModule = new URL("./stderr.ts", import.meta.url).href;
  const source = `
    const { writeStderr } = await import(${JSON.stringify(stderrModule)});
    writeStderr(${JSON.stringify(text)});
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  await new Promise((resolve) => child.once("exit", resolve));
  return { stdout, stderr };
}

test("writeStderr writes the text as one line to stderr and nothing to stdout", async () => {
  expect(await runWriting("web-agent-mcp running on stdio")).toStrictEqual({
    stdout: "",
    stderr: "web-agent-mcp running on stdio\n",
  });
});
