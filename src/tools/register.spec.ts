import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { loadConfig } from "../config/config.ts";
import { createDeps } from "../server/setup.ts";
import { NoSecretStore } from "../shared/secrets.ts";
import type { ToolDeps } from "./common.ts";
import { recordedTools } from "./register.ts";

let workDir: string;
let deps: ToolDeps;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "web-agent-register-"));
  deps = createDeps(
    loadConfig({ HOME: workDir, WEB_AGENT_DATA_DIR: workDir }),
    new NoSecretStore(),
  );
});

afterAll(async () => {
  await deps.log.close();
  await rm(workDir, { recursive: true, force: true });
});

const jsonList = z.array(z.json());
const jsonNode = z.record(z.string(), z.json());

function openObjects(schema: z.infer<ReturnType<typeof z.json>>, at: string): string[] {
  const list = jsonList.safeParse(schema);
  if (list.success) return list.data.flatMap((item, index) => openObjects(item, `${at}[${index}]`));
  const node = jsonNode.safeParse(schema);
  if (!node.success) return [];
  const own =
    node.data.type === "object" && node.data.additionalProperties === undefined ? [at] : [];
  return [
    ...own,
    ...Object.entries(node.data).flatMap(([key, value]) => openObjects(value, `${at}.${key}`)),
  ];
}

test("no tool accepts undeclared fields at any level of its input", () => {
  const open = recordedTools(deps).flatMap(({ name, config }) =>
    openObjects(z.json().parse(z.toJSONSchema(config.inputSchema, { io: "input" })), name),
  );
  expect(open).toEqual([]);
});
