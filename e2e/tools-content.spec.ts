import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { AskAdapterSource } from "../src/ask/adapter-source.ts";
import { useLogger } from "../src/log/logger.ts";
import { sleep } from "../src/shared/async.ts";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import { CONTENT, FEED_TOTAL, FRAME_TEXT, SPA_TEXT } from "./fixture-content.ts";
import { fakeSecrets, useToolsHarness } from "./tools-harness.ts";

const { mcp, ok, fixture, fakeAdapter, openedTab, collectFeed, collectText } =
  useToolsHarness("tools-content");

describe("non-HTML responses", () => {
  const routes = [
    "/files/report.pdf",
    "/files/data.json",
    "/files/notes.txt",
    "/files/table.csv",
    "/files/pixel.png",
    "/files/blob.bin",
  ];
  let index = "";
  let dir = "";
  let files: string[] = [];

  beforeAll(async () => {
    index = await ok("collect_pages", {
      urls: routes.map((route) => fixture().url + route),
      include: ["text", "links", "screenshot"],
      settle_ms: 0,
      label: "non-html",
    });
    dir = /pages into (\S+)/.exec(index)?.[1] ?? "";
    files = await readdir(dir);
  });

  const saved = (number: string, extension: string) => {
    const name = files.find(
      (file) => file.startsWith(`${number}-`) && file.endsWith(`.${extension}`),
    );
    expect(name, `no ${number} .${extension} in ${files.join(", ")}`).toBeDefined();
    return path.join(dir, name ?? "");
  };

  test("collect_pages collects every type without failing", async () => {
    expect(index).toMatch(/Collected 6 of 6 pages/);
  });

  test("collect_pages extracts PDF text into a .txt file", async () => {
    expect(await readFile(saved("01", "txt"), "utf8")).toMatch(new RegExp(CONTENT.pdfText));
  });

  test("collect_pages keeps the raw PDF", async () => {
    expect((await readFile(saved("01", "pdf"))).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("collect_pages saves JSON as .json", async () => {
    expect(await readFile(saved("02", "json"), "utf8")).toBe(CONTENT.json);
  });

  test("collect_pages saves plain text as .txt", async () => {
    expect(await readFile(saved("03", "txt"), "utf8")).toBe(CONTENT.text);
  });

  test("collect_pages saves a CSV that the browser would download", async () => {
    expect(await readFile(saved("04", "csv"), "utf8")).toBe(CONTENT.csv);
  });

  test("collect_pages saves an image as .png", async () => {
    expect((await readFile(saved("05", "png"))).subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("collect_pages saves other binaries byte for byte", async () => {
    expect(await readFile(saved("06", "bin"))).toEqual(CONTENT.binary);
  });

  test("the index line names the content type", async () => {
    expect(index).toMatch(/^01 200 \S+\/files\/report\.pdf \[application\/pdf\]/m);
  });

  test("the index previews JSON content", async () => {
    expect(index).toContain(JSON.parse(CONTENT.json).name);
  });

  test("the index counts the characters of text content", async () => {
    expect(index).toMatch(new RegExp(`^03 .* ${CONTENT.text.length} chars`, "m"));
  });

  test("read_text returns the text of a PDF tab", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/files/report.pdf` }));
    try {
      expect(await ok("read_text", { tab })).toMatch(new RegExp(CONTENT.pdfText));
    } finally {
      await ok("tab_close", { tab });
    }
  });

  test("read_text returns the raw body of a JSON tab", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/files/data.json` }));
    try {
      expect(await ok("read_text", { tab, format: "markdown" })).toContain(CONTENT.json);
    } finally {
      await ok("tab_close", { tab });
    }
  });

  test("read_text on a JSON tab returns the body an intercept rule patched, from the tab's one request", async () => {
    const tab = openedTab(await ok("tab_open", {}));
    try {
      const route = `/files/data.json?patched=${Date.now()}`;
      await ok("intercept", {
        tab,
        action: "add",
        url: route,
        mode: "patch_response",
        replacements: [{ find: JSON.parse(CONTENT.json).name, replace: "patched by rule" }],
      });
      const before = fixture().requests("/files/data.json");
      await ok("navigate", { tab, url: `${fixture().url}${route}` });
      const text = await ok("read_text", { tab });
      expect(text).toContain("patched by rule");
      expect(fixture().requests("/files/data.json") - before).toBe(1);
    } finally {
      await ok("tab_close", { tab });
    }
  });

  test("read_text on a JSON tab returns an intercept rule's mocked body without asking the server", async () => {
    const tab = openedTab(await ok("tab_open", {}));
    try {
      const route = `/files/data.json?mocked=${Date.now()}`;
      await ok("intercept", {
        tab,
        action: "add",
        url: route,
        mode: "mock",
        mock_body: JSON.stringify({ mocked: "from the rule" }),
        mock_content_type: "application/json",
      });
      const before = fixture().requests("/files/data.json");
      await ok("navigate", { tab, url: `${fixture().url}${route}` });
      const text = await ok("read_text", { tab });
      expect(text).toContain('{"mocked":"from the rule"}');
      expect(fixture().requests("/files/data.json") - before).toBe(0);
    } finally {
      await ok("tab_close", { tab });
    }
  });

  test("read_text on an image tab says where the image was saved", async () => {
    const tab = openedTab(await ok("tab_open", { url: `${fixture().url}/files/pixel.png` }));
    try {
      const text = await ok("read_text", { tab });
      const file = /saved to (\S+\.png)/.exec(text)?.[1] ?? "";
      expect((await readFile(file)).subarray(1, 4).toString("latin1")).toBe("PNG");
    } finally {
      await ok("tab_close", { tab });
    }
  });
});

describe("collect_pages scrolls lazy-loading pages", () => {
  const lastItem = new RegExp(`Feed item ${FEED_TOTAL}\\b`);

  test("without scroll only the first items are collected", async () => {
    expect((await collectFeed({})).text).not.toMatch(lastItem);
  });

  test("scroll loads items until the page stops growing", async () => {
    expect((await collectFeed({ scroll: { max_steps: 40, idle_ms: 400 } })).text).toMatch(lastItem);
  });

  test("scroll stops early once the height stops growing and reports the steps", async () => {
    const steps = Number(
      /scrolled (\d+) steps?/.exec(
        (await collectFeed({ scroll: { max_steps: 40, idle_ms: 400 } })).index,
      )?.[1],
    );
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(40);
  });

  test("scroll stops at max_steps", async () => {
    expect((await collectFeed({ scroll: { max_steps: 2, idle_ms: 400 } })).index).toMatch(
      /scrolled 2 steps \(max_steps reached\)/,
    );
  });
});

describe("frames are readable", () => {
  let tab = "";
  const frames = useMcpHarness({ name: "frames", secrets: fakeSecrets, askAdapter: fakeAdapter });
  const read = frames.ok;

  beforeAll(async () => {
    tab = openedTab(await read("tab_open", { url: `${fixture().url}/framed` }));
    await read("wait_for", { tab, text: FRAME_TEXT.outer });
    await sleep(500);
  });

  afterAll(() => {
    useLogger(mcp.deps.log);
  });

  test("read_text leaves frame text out by default", async () => {
    expect(await read("read_text", { tab })).not.toContain(FRAME_TEXT.same);
  });

  test("read_text with frames includes same-origin frame text", async () => {
    expect(await read("read_text", { tab, frames: true })).toContain(FRAME_TEXT.same);
  });

  test("read_text with frames includes cross-origin frame text", async () => {
    expect(await read("read_text", { tab, frames: true })).toContain(FRAME_TEXT.cross);
  });

  test("read_text marks each frame with its URL", async () => {
    expect(await read("read_text", { tab, frames: true })).toMatch(
      /^--- frame: http:\/\/localhost:\d+\/frame-cross ---$/m,
    );
  });

  test("read_text markdown with frames includes cross-origin frame text", async () => {
    expect(await read("read_text", { tab, frames: true, format: "markdown" })).toContain(
      FRAME_TEXT.cross,
    );
  });

  test("snapshot includes same-origin frame text", async () => {
    expect(await read("snapshot", { tab })).toContain(FRAME_TEXT.same);
  });

  test("snapshot includes cross-origin frame text", async () => {
    expect(await read("snapshot", { tab })).toContain(FRAME_TEXT.cross);
  });
});

describe("collect_pages waits for client-rendered content", () => {
  test("the rendered list is captured with default options", async () => {
    expect((await collectText("/spa")).text).toContain(SPA_TEXT.item);
  });

  test("the skeleton is gone from the captured text", async () => {
    expect((await collectText("/spa")).text).not.toContain(SPA_TEXT.skeleton);
  });

  test("a page that never stops changing is reported at the cap", async () => {
    expect((await collectText("/ticker", { max_wait_ms: 2000 })).index).toMatch(
      /content still changing after 2 s/,
    );
  });

  test("the cap bounds the wait", async () => {
    const started = Date.now();
    await collectText("/ticker", { max_wait_ms: 2000 });
    expect(Date.now() - started).toBeLessThan(8000);
  });

  test("ask_pages with urls reads the rendered list", async () => {
    const saved = mcp.deps.ask;
    const sent: string[] = [];
    mcp.deps.ask = new AskAdapterSource({
      adapter: {
        name: "capture",
        complete: async ({ prompt }) => (sent.push(prompt), { text: "NOT FOUND" }),
      },
    });
    try {
      await ok("ask_pages", { question: "Which items?", urls: [`${fixture().url}/spa`] });
      expect(sent.join("\n")).toContain(SPA_TEXT.item);
    } finally {
      mcp.deps.ask = saved;
    }
  });
});
