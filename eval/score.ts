import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJson } from "../src/shared/decode.ts";
import { SETUP_TOOLS, type Task, TASKS } from "./tasks.ts";

const toolInput = z.record(z.string(), z.json());

export type ToolUse = { name: string; input: z.infer<typeof toolInput> };

const streamEvent = z.object({
  type: z.string().optional(),
  num_turns: z.number().optional(),
  message: z
    .object({
      content: z
        .array(
          z.object({
            type: z.string().optional(),
            name: z.string().optional(),
            input: toolInput.optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

const MCP_PREFIX = "mcp__wa__";

export function toolUses(stream: string) {
  const uses: ToolUse[] = [];
  let turns: number | undefined;
  for (const line of stream.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseJson(line, streamEvent);
    if (!parsed.success) continue;
    const event = parsed.data;
    if (event.type === "result") turns = event.num_turns;
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name)
        uses.push({
          name: block.name.startsWith(MCP_PREFIX)
            ? block.name.slice(MCP_PREFIX.length)
            : block.name,
          input: block.input ?? {},
        });
    }
  }
  return { uses, turns };
}

export function score(task: Task, uses: ToolUse[]) {
  const prelude = new Set([...SETUP_TOOLS, ...(task.prelude ?? [])]);
  const key = uses.find((use) => !prelude.has(use.name));
  const argsMatch =
    !task.expectArgs ||
    Object.entries(task.expectArgs).every(([name, value]) => key?.input[name] === value);
  const detours = [
    ...new Set(uses.filter((use) => task.forbidden?.includes(use.name)).map((use) => use.name)),
  ];
  const pass = Boolean(key && task.expect.includes(key.name) && argsMatch && detours.length === 0);
  return { key, pass, detours };
}

async function rescore(dir: string, labels: string[]) {
  const rows: string[] = [
    "| task | family | expected | " +
      labels.map((label) => `${label} key tool (detours)`).join(" | ") +
      " |",
    `|---|---|---|${labels.map(() => "---|").join("")}`,
  ];
  const totals = new Map<string, Map<string, [number, number]>>();
  const streams = await Promise.all(
    TASKS.map((task) =>
      Promise.all(
        labels.map((label) =>
          readFile(path.join(dir, `${label}-${task.id}.jsonl`), "utf8").catch(() => undefined),
        ),
      ),
    ),
  );
  for (const [taskIndex, task] of TASKS.entries()) {
    const cells: string[] = [];
    for (const [labelIndex, label] of labels.entries()) {
      const stream = streams[taskIndex]?.[labelIndex];
      if (stream === undefined) {
        cells.push("not run");
        continue;
      }
      const { key, pass, detours } = score(task, toolUses(stream).uses);
      const family = totals.get(label) ?? new Map<string, [number, number]>();
      const [passed, total] = family.get(task.family) ?? [0, 0];
      family.set(task.family, [passed + (pass ? 1 : 0), total + 1]);
      totals.set(label, family);
      const mode = key?.input.mode ? ` (${String(key.input.mode)})` : "";
      cells.push(
        `${pass ? "pass" : "fail"}: ${key?.name ?? "-"}${mode}${detours.length ? `; detour ${detours.join(", ")}` : ""}`,
      );
    }
    rows.push(
      `| ${task.id} | ${task.family} | ${task.expect.join(" / ")} | ${cells.join(" | ")} |`,
    );
  }
  const families = [...new Set(TASKS.map((task) => task.family))];
  rows.push("", `| family | ${labels.join(" | ")} |`, `|---|${labels.map(() => "---|").join("")}`);
  for (const family of families)
    rows.push(
      `| ${family} | ${labels.map((label) => (totals.get(label)?.get(family) ?? [0, 0]).join("/")).join(" | ")} |`,
    );
  return rows.join("\n");
}

if (import.meta.main) {
  const [dir, ...labels] = process.argv.slice(2);
  const table = await rescore(
    dir ?? path.join(import.meta.dirname, "results"),
    labels.length ? labels : ["before", "after"],
  );
  process.stdout.write(`${table}\n`);
}
