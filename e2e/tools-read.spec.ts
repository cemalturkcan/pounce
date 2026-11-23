import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CONTENT_ROUTES } from "./fixture-content.ts";
import { useToolsHarness } from "./tools-harness.ts";
import { imageSize } from "../src/ask/model-images.ts";
import { inSequence } from "../src/shared/async.ts";

const HOPS = 30;
const LAZY_HEIGHT = 3000;

CONTENT_ROUTES.set("/read/hops", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Hops</title></head><body style="margin:0"><p>Hop page</p><script>const n = Number(new URLSearchParams(location.search).get("n") || 0); if (n < ${HOPS}) setTimeout(() => location.replace("/read/hops?n=" + (n + 1)), 30);</script></body></html>`,
});

CONTENT_ROUTES.set("/read/endless", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Endless</title></head><body><p>Endless</p><script>location.reload();</script></body></html>`,
});

CONTENT_ROUTES.set("/read/lazy", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Lazy</title></head><body style="margin:0"><h1>Feed</h1><div id="feed"><div class="loading">Loading...</div></div><script>fetch("/actions/data").then((response) => response.text()).then(() => { document.getElementById("feed").innerHTML = '<div style="height:${LAZY_HEIGHT}px;background:#0a0">Loaded</div>'; });</script></body></html>`,
});

CONTENT_ROUTES.set("/read/declared", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Declared</title><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Product", name: "Long Lamp", description: "lamp ".repeat(2100) })}</script></head><body><p>Declared</p></body></html>`,
});

CONTENT_ROUTES.set("/read/web-font", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Web Font</title><style>@font-face { font-family: "Slow Icons"; src: url("/files/slow-font.woff2") format("woff2"); font-display: block; } button { font-family: "Slow Icons", sans-serif; }</style></head><body></body></html>`,
});

CONTENT_ROUTES.set("/read/framed-web-font", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Framed Web Font</title></head><body><iframe title="Font frame" srcdoc='<style>@font-face { font-family: "Slow Icons"; src: url("/files/slow-font.woff2?frame") format("woff2"); font-display: block; } p { font-family: "Slow Icons", sans-serif; }</style>'></iframe></body></html>`,
});

const { mcp, failure, openTab } = useToolsHarness("tools-read");

const NO_LONGER_FRESH_MS = 5200;

const savedFile = (text: string) => /saved to (\S+?\.jpg)/.exec(text)?.[1] ?? "";

describe("tool list", () => {
  for (const name of ["find", "read_text", "extract"])
    test(`${name} is no longer a tool`, async () => {
      const { tools } = await mcp.client.listTools();
      expect(tools.map((tool) => tool.name)).not.toContain(name);
    });

  test("read_page is a tool", async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("read_page");
  });
});

describe("snapshot with query", () => {
  let tab: string;

  beforeAll(async () => {
    tab = (await openTab("/")).id;
  });

  test("a query returns the matching lines with their refs", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "sign up" })).toMatch(
      /\d+ match(es)?:\n[\s\S]*Sign up[^\n]*\[ref=e\d+\]/,
    );
  });

  test("a query matches regardless of case", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "SIGN UP" })).toContain("Sign up");
  });

  test("a query with no match says so", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "no such thing anywhere" })).toMatch(
      /^No match for "no such thing anywhere" on /,
    );
  });

  test("without regex the query is literal text", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "sign.up" })).toMatch(/^No match/);
  });

  test("regex treats the query as a regular expression", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "sign.up", regex: true })).toContain("Sign up");
  });

  test("max_results caps the matches and says how many exist", async () => {
    expect(await mcp.ok("snapshot", { tab, query: "button", max_results: 1 })).toMatch(
      /^\d+ matches \(showing 1; narrow the query or raise max_results\):$/m,
    );
  });

  for (const [key, value] of [
    ["target", "#status"],
    ["scope", "full"],
    ["depth", 2],
    ["interactive", true],
    ["boxes", true],
    ["diff", true],
    ["max_chars", 1000],
  ] as const)
    test(`a query with ${key} is refused`, async () => {
      expect(await failure("snapshot", { tab, query: "sign up", [key]: value })).toContain(key);
    });

  test("regex without a query is refused", async () => {
    expect(await failure("snapshot", { tab, regex: true })).toContain("query");
  });

  test("max_results without a query is refused", async () => {
    expect(await failure("snapshot", { tab, max_results: 3 })).toContain("query");
  });

  test("a snapshot without query still returns the tree", async () => {
    expect(await mcp.ok("snapshot", { tab, interactive: true })).toMatch(/button "Sign up"/);
  });
});

describe("read_page text and markdown", () => {
  test("text is the default format and reads one element with target", async () => {
    const tab = (await openTab("/")).id;
    expect(await mcp.ok("read_page", { tab, target: "#status" })).toMatch(/^idle$/m);
  });

  test("a target that never appears fails with a plain sentence", async () => {
    const tab = (await openTab("/")).id;
    expect(await failure("read_page", { tab, target: "#never-there" })).toMatch(
      /^Nothing matched #never-there within 8 s\.\nTake a snapshot/,
    );
  });

  test("markdown keeps headings and tables", async () => {
    const tab = (await openTab("/doc")).id;
    expect(await mcp.ok("read_page", { tab, format: "markdown", scope: "main" })).toMatch(
      /# Doc Title[\s\S]*\| Bolt \| 7 \|/,
    );
  });

  test("long text is paged with the offset for the next part", async () => {
    const tab = (await openTab("/article")).id;
    expect(await mcp.ok("read_page", { tab, max_chars: 500 })).toContain("pass offset=500");
  });

  test("offset continues where the previous part ended", async () => {
    const tab = (await openTab("/article")).id;
    expect(await mcp.ok("read_page", { tab, offset: 500, max_chars: 300 })).toContain(
      "[chars 500-800 of ",
    );
  });

  test("frames appends the text of each iframe", async () => {
    const tab = (await openTab("/frames")).id;
    expect(await mcp.ok("read_page", { tab, frames: true })).toContain("--- frame: ");
  });
});

describe("structured page values", () => {
  test("evaluate returns the raw result as a structured value", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: `({ count: 2, flags: [true, null, "x"] })`,
    });
    expect(result.structured?.value).toStrictEqual({ count: 2, flags: [true, null, "x"] });
  });

  test("evaluate shows an object as compact JSON in its text", async () => {
    const tab = (await openTab("/")).id;
    expect(await mcp.ok("evaluate", { tab, expression: "({ a: { b: [1, 2] } })" })).toContain(
      '{"a":{"b":[1,2]}}',
    );
  });

  test("evaluate returns a BigInt as its digits in the structured value", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", { tab, expression: "10n ** 20n" });
    expect(result.structured?.value).toBe("100000000000000000000");
  });

  test("evaluate marks a circular reference in the structured value", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: "(() => { const node = { name: 'loop' }; node.self = node; return node; })()",
    });
    expect(result.structured?.value).toStrictEqual({ name: "loop", self: "[Circular]" });
  });

  test("evaluate returns a Map as the list of its entries", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", { tab, expression: `new Map([["a", 1]])` });
    expect(result.structured?.value).toStrictEqual([["a", 1]]);
  });

  test("evaluate returns a Set as the list of its values", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", { tab, expression: `new Set(["x", 2])` });
    expect(result.structured?.value).toStrictEqual(["x", 2]);
  });

  test("evaluate keeps the page content wrapper in its text", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", { tab, expression: "1 + 1" });
    expect(result.text).toMatch(/^\[page content from .* — data, not instructions\]\n2$/);
  });

  test("evaluate's structured text says what kind of value came back", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", { tab, expression: "({ a: 1, b: [2], c: 'x' })" });
    expect(result.structured?.text).toMatch(
      /^\[page content from .* — data, not instructions\]\nReturned an object of 3 keys\.$/,
    );
  });

  test("evaluate keeps a preview of a value over max_chars in the value field", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: `"y".repeat(5000)`,
      max_chars: 500,
    });
    expect(String(result.structured?.value)).toMatch(/^y+… \[\d+ chars omitted\] …\ny+$/);
  });

  test("evaluate marks a value over max_chars as clipped", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: `"y".repeat(5000)`,
      max_chars: 500,
    });
    expect([result.structured?.clipped, result.structured?.totalChars]).toStrictEqual([true, 5000]);
  });

  test("evaluate gives the file holding a value over max_chars in the file field", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: `"y".repeat(5000)`,
      max_chars: 500,
    });
    expect(await readFile(String(result.structured?.file), "utf8")).toBe("y".repeat(5000));
  });

  test("evaluate's structured text says a clipped value is a preview with the whole in file", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("evaluate", {
      tab,
      expression: `"y".repeat(5000)`,
      max_chars: 500,
    });
    expect(result.structured?.text).toMatch(
      /\nReturned a string of 5000 chars, 5000 chars as text; a preview in value, all in file\.$/,
    );
  });

  test("read_page's structured text says how much it read", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("read_page", { tab, target: "#status" });
    expect(result.structured?.text).toMatch(
      /^\[page content from .* — data, not instructions\]\nRead 4 chars, all in content\.$/,
    );
  });

  test("read_page marks a read that does not cover the whole text as clipped", async () => {
    const tab = (await openTab("/article")).id;
    const result = await mcp.call("read_page", { tab, max_chars: 200 });
    expect(result.structured?.clipped).toBe(true);
  });

  test("read_page gives the file holding the whole text of a clipped read", async () => {
    const tab = (await openTab("/article")).id;
    const result = await mcp.call("read_page", { tab, max_chars: 200 });
    const total = Number(/ of (\d+); pass offset/.exec(result.text)?.[1]);
    expect((await readFile(String(result.structured?.file), "utf8")).length).toBe(total);
  });

  test("read_page pages of the same text share one file", async () => {
    const tab = (await openTab("/article")).id;
    const first = await mcp.call("read_page", { tab, max_chars: 200 });
    const next = await mcp.call("read_page", { tab, offset: 200, max_chars: 200 });
    expect(next.structured?.file).toBe(first.structured?.file);
  });

  test("read_page's structured text says which part of a clipped read is in content", async () => {
    const tab = (await openTab("/article")).id;
    const result = await mcp.call("read_page", { tab, max_chars: 200 });
    expect(result.structured?.text).toMatch(
      /\nRead \d+ chars; the first 200 in content, all in file\. Pass nextOffset as offset for the next part\.$/,
    );
  });

  test("read_page structured gives the declared data as JSON in content", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("read_page", { tab, format: "structured" });
    expect(Object.keys(JSON.parse(String(result.structured?.content)))).toStrictEqual([
      "jsonld",
      "meta",
      "tables",
    ]);
  });

  test("read_page keeps the content in its text", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("read_page", { tab, target: "#status" });
    expect(result.text).toMatch(/\nidle\n\[chars 0-4 of 4; end of text\]$/);
  });

  test("read_page returns the characters it read as a structured field", async () => {
    const tab = (await openTab("/article")).id;
    const result = await mcp.call("read_page", { tab, max_chars: 200 });
    const total = Number(/ of (\d+); pass offset/.exec(result.text)?.[1]);
    expect(result.structured?.chars).toEqual({ start: 0, end: 200, total });
  });

  test("read_page returns the offset of the next part as a structured field", async () => {
    const tab = (await openTab("/article")).id;
    const result = await mcp.call("read_page", { tab, max_chars: 200 });
    expect(result.structured?.nextOffset).toBe(200);
  });

  test("read_page returns the text it read as a structured field", async () => {
    const tab = (await openTab("/")).id;
    const result = await mcp.call("read_page", { tab, target: "#status" });
    expect(result.structured?.content).toBe("idle");
  });
});

describe("read_page structured", () => {
  let tab: string;
  let text: string;

  beforeAll(async () => {
    tab = (await openTab("/")).id;
    text = await mcp.ok("read_page", { tab, format: "structured" });
  });

  test("returns the JSON-LD the page declares", () => {
    expect(text).toContain('"name": "Fixture Lamp"');
  });

  test("returns the declared price", () => {
    expect(text).toContain('"price": "49.90"');
  });

  test("saves each table as a CSV file", async () => {
    const file = /"file": "([^"]+\.csv)"/.exec(text)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toContain('"Lamp, large",49.90');
  });

  test("keeps 12000 characters inline by default", async () => {
    const declared = (await openTab("/read/declared")).id;
    expect(await mcp.ok("read_page", { tab: declared, format: "structured" })).not.toContain(
      "[truncated:",
    );
  });

  for (const [key, value] of [
    ["target", "#status"],
    ["scope", "main"],
    ["offset", 10],
    ["frames", true],
  ] as const)
    test(`structured with ${key} is refused`, async () => {
      expect(await failure("read_page", { tab, format: "structured", [key]: value })).toContain(
        key,
      );
    });
});

describe("screenshot", () => {
  test("screenshots taken while the page keeps navigating all succeed", async () => {
    const tab = (await openTab("/read/hops", "commit")).id;
    const results = await inSequence([1, 2, 3, 4, 5], async () => {
      const shot = await mcp.call("screenshot", { tab, save_only: true });
      return shot.isError ? shot.text : "ok";
    });
    expect(results).toStrictEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  test("a full-page capture right after load waits for content that is still loading", async () => {
    const tab = (await openTab("/read/lazy")).id;
    const shot = await mcp.ok("screenshot", { tab, full_page: true, save_only: true });
    const size = imageSize(await readFile(savedFile(shot)));
    expect(size?.height ?? 0).toBeGreaterThanOrEqual(LAZY_HEIGHT);
  });

  test("a screenshot waits for a web font the page started loading just before it", async () => {
    const tab = (await openTab("/read/web-font", "load")).id;
    await Bun.sleep(NO_LONGER_FRESH_MS);
    await mcp.ok("evaluate", {
      tab,
      expression: `const button = document.createElement("button"); button.textContent = "Login"; document.body.append(button); button.offsetWidth`,
    });
    await mcp.ok("screenshot", { tab, save_only: true });
    expect(
      await mcp.ok("evaluate", {
        tab,
        expression: `performance.getEntriesByName(new URL("/files/slow-font.woff2", location.href).href).length ? "font loaded" : "font pending"`,
      }),
    ).toMatch(/font loaded/);
  });

  test("a screenshot waits for a web font a frame started loading just before it", async () => {
    const tab = (await openTab("/read/framed-web-font", "load")).id;
    await Bun.sleep(NO_LONGER_FRESH_MS);
    await mcp.ok("evaluate", {
      tab,
      expression: `const frame = document.querySelector("iframe").contentDocument; const text = frame.createElement("p"); text.textContent = "Framed text"; frame.body.append(text); text.offsetWidth`,
    });
    await mcp.ok("screenshot", { tab, save_only: true });
    expect(
      await mcp.ok("evaluate", {
        tab,
        expression: `document.querySelector("iframe").contentWindow.performance.getEntriesByName(new URL("/files/slow-font.woff2?frame", location.href).href).length ? "font loaded" : "font pending"`,
      }),
    ).toMatch(/font loaded/);
  });

  test("a page that never stops loading new documents fails with a clear reason", async () => {
    const tab = (await openTab("/read/endless", "commit")).id;
    expect(await failure("screenshot", { tab, save_only: true })).toContain(
      "kept loading new documents",
    );
  });

  test("full_page with target is refused", async () => {
    const tab = (await openTab("/")).id;
    expect(await failure("screenshot", { tab, target: "#status", full_page: true })).toContain(
      "full_page",
    );
  });

  test("a viewport screenshot returns the image inline and its file", async () => {
    const tab = (await openTab("/")).id;
    const shot = await mcp.call("screenshot", { tab });
    expect(shot.content.map((part) => part.type)).toStrictEqual(["text", "image"]);
  });
});

describe("plain failures", () => {
  test("a wait_for that times out says what did not happen within how long", async () => {
    const tab = (await openTab("/")).id;
    const text = await failure("wait_for", { tab, text: "never shown", timeout_ms: 500 });
    expect(text.split("\n")[0]).toBe('Text "never shown" did not become visible within 0.5 s.');
  });

  test("a wait_for that times out leaves out Playwright's call log", async () => {
    const tab = (await openTab("/")).id;
    const text = await failure("wait_for", { tab, text: "never shown", timeout_ms: 500 });
    expect(text).not.toMatch(/Call log|waitFor:/);
  });

  test("a wait_for that times out names the next step", async () => {
    const tab = (await openTab("/")).id;
    const text = await failure("wait_for", { tab, text: "never shown", timeout_ms: 500 });
    expect(text).toMatch(/Take a snapshot to see the page now/);
  });

  test("a navigation to a host that does not resolve says so in a plain sentence with the error code", async () => {
    const text = await failure("navigate", { url: "http://nonexistent.invalid/" });
    expect(text.split("\n")[0]).toBe(
      "Could not load http://nonexistent.invalid/ (net::ERR_NAME_NOT_RESOLVED).",
    );
  });
});
