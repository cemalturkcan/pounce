import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_DIR } from "../config/version.ts";
import { JsoncError, parseJsonc, setJsoncMember } from "./jsonc.ts";

const ENTRY = { type: "http", url: "http://127.0.0.1:29741/mcp" };

function fixture(name: string) {
  return readFileSync(path.join(PACKAGE_DIR, "tests", "fixtures", "agent-configs", name), "utf8");
}

function withEntry(name: string) {
  return setJsoncMember(fixture(name), ["mcpServers", "pounce"], ENTRY);
}

describe("adding a server to a commented JSONC file", () => {
  test("keeps every comment", () => {
    const comments = fixture("commented.jsonc").match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];

    expect(
      comments.filter((comment) => !withEntry("commented.jsonc").includes(comment)),
    ).toStrictEqual([]);
  });

  test("adds the entry next to the existing server", () => {
    expect(parseJsonc(withEntry("commented.jsonc"))).toStrictEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "other-mcp", args: ["--flag"] },
        pounce: ENTRY,
      },
      url: "http://example.com/{not-a-brace}",
    });
  });

  test("indents the entry like its sibling", () => {
    expect(withEntry("commented.jsonc")).toContain('\n    "pounce": {\n      "type": "http",');
  });
});

describe("adding a server to a tab-indented file without a final newline", () => {
  test("uses tabs", () => {
    expect(withEntry("tabs-no-newline.json")).toContain('\n\t\t"pounce": {\n\t\t\t"type": "http"');
  });

  test("keeps the file without a final newline", () => {
    expect(withEntry("tabs-no-newline.json").endsWith("}")).toBe(true);
  });
});

describe("adding a server to a one-line file", () => {
  test("creates the servers object", () => {
    expect(parseJsonc(withEntry("single-line.json"))).toStrictEqual({
      numStartups: 3,
      projects: { "/x": { allowedTools: [] } },
      mcpServers: { pounce: ENTRY },
    });
  });

  test("keeps it on one line", () => {
    expect(withEntry("single-line.json").trimEnd().includes("\n")).toBe(false);
  });
});

test("adding a server to an empty servers object fills it", () => {
  expect(parseJsonc(withEntry("empty-servers.json"))).toStrictEqual({
    mcpServers: { pounce: ENTRY },
  });
});

test("an empty file becomes an object with the server", () => {
  expect(parseJsonc(setJsoncMember("", ["mcpServers", "pounce"], ENTRY))).toStrictEqual({
    mcpServers: { pounce: ENTRY },
  });
});

test("an existing entry is replaced in place", () => {
  const before = withEntry("commented.jsonc");
  const replaced = setJsoncMember(before, ["mcpServers", "pounce"], {
    type: "http",
    url: "http://127.0.0.1:1/mcp",
  });

  expect(parseJsonc(replaced)).toStrictEqual({
    theme: "dark",
    mcpServers: {
      other: { command: "other-mcp", args: ["--flag"] },
      pounce: { type: "http", url: "http://127.0.0.1:1/mcp" },
    },
    url: "http://example.com/{not-a-brace}",
  });
});

test("a servers key that is not an object is refused", () => {
  expect(() => setJsoncMember('{"mcpServers": []}', ["mcpServers", "pounce"], ENTRY)).toThrow(
    JsoncError,
  );
});

test("broken JSON is refused", () => {
  expect(() => setJsoncMember('{"mcpServers": {', ["mcpServers", "pounce"], ENTRY)).toThrow(
    JsoncError,
  );
});
