import { expect, test } from "bun:test";
import { z } from "zod";
import { useMcpHarness } from "../../tests/mcpHarness.ts";

const mcp = useMcpHarness({ name: "tabs-spec" });

test("tabs lists the server state without starting the browser", async () => {
  expect(await mcp.ok("tabs")).toMatch(
    /^Browser not started yet; it launches on the first navigate\./,
  );
});

test("tabs shows the cookie banner setting", async () => {
  expect(await mcp.ok("tabs")).toMatch(/Cookie banners: accepted on your own tabs/);
});

test("tabs refuses force without close", async () => {
  const result = await mcp.call("tabs", { force: true });
  expect(result.text).toMatch(/force only applies with close/);
});

test("tabs reports a tab it could not close and still lists the tabs", async () => {
  const result = await mcp.call("tabs", { close: ["t999999"] });
  expect([result.isError, /t999999: [\s\S]*No tabs open/.test(result.text)]).toEqual([true, true]);
});

test("tabs close takes a single tab id as a string", async () => {
  const result = await mcp.call("tabs", { close: "t999999" });
  expect(result.text).toMatch(/^t999999: /);
});

test("tabs close describes that it takes one id or a list", async () => {
  const { tools } = await mcp.client.listTools();
  const close = z
    .object({ properties: z.object({ close: z.object({ description: z.string() }) }) })
    .parse(tools.find((tool) => tool.name === "tabs")?.inputSchema);
  expect(close.properties.close.description).toMatch(/one tab id or a list/i);
});

test("navigate refuses back without a tab", async () => {
  const result = await mcp.call("navigate", { url: "back" });
  expect(result.text).toMatch(/back needs a tab/);
});

test("navigate refuses force without a tab", async () => {
  const result = await mcp.call("navigate", { url: "https://example.com", force: true });
  expect(result.text).toMatch(/force needs a tab/);
});

test("emulate names close devices for an unknown device", async () => {
  const result = await mcp.call("emulate", { tab: "t999999", device: "Pixel" });
  expect(result.text).toMatch(/Pixel 8/);
});
