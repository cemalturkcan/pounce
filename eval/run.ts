import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { startFixture } from "../e2e/fixture.ts";
import { healthy, spawnDaemon } from "../tests/daemon.ts";
import { runPool } from "../src/shared/async.ts";
import { createImage, fillRect } from "../src/visual/pixels.ts";
import { encodePng } from "../src/visual/png.ts";
import { writeStderr } from "../src/log/stderr.ts";
import { score, toolUses, type ToolUse } from "./score.ts";
import { type Family, TASKS } from "./tasks.ts";

const EVAL_DIR = import.meta.dirname;
const REPO_DIR = path.dirname(EVAL_DIR);
const SERVER_KEY = "wa";
const RUN_TIMEOUT_MS = 8 * 60_000;

const CATALOG = `<!doctype html><html><head><title>Catalog</title></head><body>
<h1>Catalog</h1><table id="items"><tr><th>Item</th></tr></table>
<button id="next">Next page</button><p id="page">page 1</p>
<script>
let page = 1;
const load = () => fetch("/api/items?page=" + page).then((response) => response.json()).then((data) => {
  const table = document.getElementById("items");
  table.querySelectorAll("tr.row").forEach((row) => row.remove());
  for (const item of data.items) table.insertAdjacentHTML("beforeend", "<tr class=row><td>" + item + "</td></tr>");
  document.getElementById("page").textContent = "page " + page;
});
document.getElementById("next").onclick = () => { page += 1; load(); };
load();
</script></body></html>`;

type Outcome = {
  id: string;
  family: Family;
  expect: string[];
  tools: ToolUse[];
  key?: ToolUse;
  pass: boolean;
  detours: string[];
  turns?: number;
  error?: string;
  ms: number;
};

const listening = z.object({ port: z.number() });

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "run" },
    server: { type: "string", default: REPO_DIR },
    only: { type: "string" },
    concurrency: { type: "string", default: "3" },
    out: { type: "string", default: path.join(EVAL_DIR, "results") },
    model: { type: "string" },
    "max-turns": { type: "string", default: "6" },
  },
});

async function startSite() {
  const fixture = await startFixture();
  const server = http.createServer(async (request, response) => {
    if ((request.url ?? "").split("?")[0] === "/catalog") {
      response.writeHead(200, { "content-type": "text/html" }).end(CATALOG);
      return;
    }
    const upstream = await fetch(`${fixture.url}${request.url ?? "/"}`, {
      method: request.method,
      headers: { cookie: request.headers.cookie ?? "" },
      redirect: "manual",
    }).catch(() => undefined);
    if (!upstream) {
      response.writeHead(502).end();
      return;
    }
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      if (!["content-encoding", "content-length", "transfer-encoding"].includes(name))
        headers[name] = value;
    });
    response.writeHead(upstream.status, headers).end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${listening.parse(server.address()).port}`;
  return {
    base,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await fixture.close();
    },
  };
}

async function startDaemon(serverDir: string, dataDir: string) {
  const daemon = await spawnDaemon(
    dataDir,
    { WEB_AGENT_ASK_ADAPTER: path.join(EVAL_DIR, "fake-adapter.ts") },
    serverDir,
  );
  if (await healthy(daemon.port)) return { daemon, endpoint: daemon.endpoint.href };
  await daemon.stop();
  throw new Error(`The daemon did not start:\n${daemon.stderr()}`);
}

async function writeReference(file: string) {
  const image = createImage(1280, 800, [255, 255, 255, 255]);
  fillRect(image, { x: 0, y: 0, width: 1280, height: 72 }, [24, 32, 48, 255]);
  fillRect(image, { x: 64, y: 120, width: 520, height: 48 }, [30, 30, 30, 255]);
  fillRect(image, { x: 64, y: 200, width: 900, height: 16 }, [120, 120, 120, 255]);
  await writeFile(file, await encodePng(image));
}

async function failedRequestId(endpoint: string, base: string) {
  const client = new Client({ name: "eval-setup", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  try {
    const opened = await client.callTool({ name: "tab_open", arguments: { url: `${base}/doc` } });
    const tab = /Opened (t\d+)/.exec(JSON.stringify(opened.content))?.[1] ?? "t1";
    const failed = await client.callTool({
      name: "click",
      arguments: { tab, target: "#no-such-button", timeout_ms: 500 },
    });
    await client.callTool({ name: "tab_close", arguments: { tab } });
    const id = /\[req ([0-9a-f]+)\]/.exec(JSON.stringify(failed.content))?.[1];
    if (!id)
      throw new Error(`The setup call did not fail as expected: ${JSON.stringify(failed.content)}`);
    return id;
  } finally {
    await client.close();
  }
}

function runClaude(prompt: string, mcpConfig: string, cwd: string) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--max-turns",
    values["max-turns"] ?? "6",
    "--setting-sources",
    "project",
    "--disable-slash-commands",
    "--allowedTools",
    `mcp__${SERVER_KEY}`,
    "Read",
    "Glob",
    "Grep",
    ...(values.model ? ["--model", values.model] : []),
  ];
  return new Promise<{ stdout: string; error?: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child: ChildProcess = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        error:
          code === 0 ? undefined : `exit ${code}: ${stderr.trim().split("\n").slice(-3).join(" ")}`,
      });
    });
  });
}

async function main() {
  const tasks = values.only
    ? TASKS.filter((task) => values.only?.split(",").includes(task.id))
    : TASKS;
  const work = await mkdtemp(path.join(tmpdir(), "web-agent-eval-"));
  const site = await startSite();
  const reference = path.join(work, "doc-figma-export.png");
  await writeReference(reference);
  const { daemon, endpoint } = await startDaemon(
    path.resolve(values.server ?? REPO_DIR),
    path.join(work, "data"),
  );
  const failedRequest = await failedRequestId(endpoint, site.base);
  const mcpConfig = JSON.stringify({
    mcpServers: { [SERVER_KEY]: { type: "http", url: endpoint } },
  });
  const outcomes: Outcome[] = [];
  try {
    await runPool(tasks, Number(values.concurrency), async (task) => {
      const cwd = path.join(work, `cwd-${task.id}`);
      await mkdir(cwd, { recursive: true });
      const started = Date.now();
      const result = await runClaude(
        task.prompt(site.base, { reference, failedRequest }),
        mcpConfig,
        cwd,
      );
      const { uses, turns } = toolUses(result.stdout);
      const scored = score(task, uses);
      await mkdir(values.out ?? "", { recursive: true });
      await writeFile(
        path.join(values.out ?? "", `${values.label}-${task.id}.jsonl`),
        result.stdout,
      );
      outcomes.push({
        id: task.id,
        family: task.family,
        expect: task.expect,
        tools: uses,
        ...scored,
        turns,
        error: result.error,
        ms: Date.now() - started,
      });
      writeStderr(
        `${task.id}: ${scored.pass ? "pass" : "FAIL"} key=${scored.key?.name ?? "-"} tools=${uses.map((use) => use.name).join(",")}${result.error ? ` (${result.error})` : ""}`,
      );
    });
  } finally {
    await daemon.stop();
    await site.close();
    await rm(work, { recursive: true, force: true });
  }
  const ordered = tasks
    .map((task) => outcomes.find((outcome) => outcome.id === task.id))
    .filter((outcome): outcome is Outcome => Boolean(outcome));
  await writeFile(
    path.join(values.out ?? "", `${values.label}.json`),
    JSON.stringify(ordered, null, 2),
  );
  const rows = ordered.map(
    (outcome) =>
      `| ${outcome.id} | ${outcome.family} | ${outcome.expect.join(" / ")} | ${outcome.key?.name ?? "-"}${outcome.key?.input.mode ? ` (${String(outcome.key.input.mode)})` : ""} | ${outcome.detours.join(", ") || "-"} | ${outcome.pass ? "pass" : "fail"} |`,
  );
  process.stdout.write(
    `${[
      "| task | family | expected | key tool | detours | result |",
      "|---|---|---|---|---|---|",
      ...rows,
    ].join("\n")}\n`,
  );
  process.stdout.write(
    `\n${values.label}: ${ordered.filter((outcome) => outcome.pass).length}/${ordered.length} passed\n`,
  );
}

await main();
