import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createImage } from "../src/visual/pixels.ts";
import { encodePng } from "../src/visual/png.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";

const mcp = useMcpHarness({
  name: "color",
  env: { WEB_AGENT_DEFAULT_LAUNCH_ARGS: "--force-dark-mode" },
});
const { ok } = mcp;

const prefersDark = async (tab: string) =>
  (await ok("evaluate", { tab, expression: "matchMedia('(prefers-color-scheme: dark)').matches" }))
    .split("\n")
    .at(-1);

test("pages follow the system color scheme and emulate overrides it for one tab only", async () => {
  const tab =
    /Opened (t\d+)/.exec(
      await ok("navigate", { url: "data:text/html,<title>Scheme</title><p>scheme</p>" }),
    )?.[1] ?? "";
  const other =
    /Opened (t\d+)/.exec(
      await ok("navigate", { url: "data:text/html,<title>Other</title><p>other</p>" }),
    )?.[1] ?? "";
  expect(await prefersDark(tab)).toBe("true");
  await ok("emulate", { tab, color_scheme: "light" });
  expect(await prefersDark(tab)).toBe("false");
  expect(await prefersDark(other)).toBe("true");
  await ok("emulate", { tab, reset: true });
  expect(await prefersDark(tab)).toBe("true");

  const reference = path.join(mcp.workDir, "reference.png");
  await writeFile(reference, await encodePng(createImage(400, 300, [255, 255, 255, 255])));
  await ok("compare_design", { tab, reference, model: "none" });
  expect(await prefersDark(tab)).toBe("true");
});
