import { expect, test } from "bun:test";
import { parseToml, removeTomlTable, setTomlTable } from "./toml.ts";

const TWO_SERVERS =
  '[mcp_servers.old]\nurl = "http://127.0.0.1:1/mcp"\n\n# Figma server\n[mcp_servers.figma]\nurl = "http://127.0.0.1:2/mcp"\n';

test("removing a table keeps the comment above the next one", () => {
  expect(removeTomlTable(TWO_SERVERS, ["mcp_servers", "old"])).toContain("# Figma server");
});

test("removing a table keeps the next one", () => {
  expect(parseToml(removeTomlTable(TWO_SERVERS, ["mcp_servers", "old"]))).toStrictEqual({
    mcp_servers: { figma: { url: "http://127.0.0.1:2/mcp" } },
  });
});

test("replacing a table keeps the comment above the next one", () => {
  expect(
    setTomlTable(TWO_SERVERS, ["mcp_servers", "old"], { url: "http://127.0.0.1:3/mcp" }),
  ).toContain("# Figma server");
});

test("replacing a table keeps a blank line before the next one", () => {
  expect(setTomlTable(TWO_SERVERS, ["mcp_servers", "old"], { url: "http://127.0.0.1:3/mcp" })).toBe(
    '[mcp_servers.old]\nurl = "http://127.0.0.1:3/mcp"\n\n# Figma server\n[mcp_servers.figma]\nurl = "http://127.0.0.1:2/mcp"\n',
  );
});

test("replacing a table keeps the other tables", () => {
  expect(
    parseToml(setTomlTable(TWO_SERVERS, ["mcp_servers", "old"], { url: "http://127.0.0.1:3/mcp" })),
  ).toStrictEqual({
    mcp_servers: {
      old: { url: "http://127.0.0.1:3/mcp" },
      figma: { url: "http://127.0.0.1:2/mcp" },
    },
  });
});
