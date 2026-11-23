import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tab } from "../src/browser/tab.ts";
import { sleep } from "../src/shared/async.ts";
import { SLOW_MS } from "./fixture-actions.ts";
import { savedDir, useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, failure, openTab } = useToolsHarness("tools-data");

async function toolEntry(name: string) {
  const { tools } = await mcp.client.listTools();
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, `no tool ${name}`).toBeDefined();
  return tool;
}

const saveWithLateDialog = async (message: string) => {
  const tab = await openTab("/");
  try {
    await ok("evaluate", {
      tab: tab.id,
      expression: `setTimeout(() => alert('${message}'), 400)`,
    });
    const startedAt = performance.now();
    const result = await call("save_pages", { tabs: [tab.id], settle_ms: 5000 });
    return { result, ms: performance.now() - startedAt };
  } finally {
    await mcp.deps.manager.closeTab(tab.id);
  }
};

async function savedFile(text: string, extension: string) {
  const dir = savedDir(text);
  const name = (await readdir(dir)).find((entry) => entry.endsWith(`.${extension}`)) ?? "";
  expect(name, `no .${extension} file in ${dir}`).toMatch(/\S/);
  return path.join(dir, name);
}

async function fileHead(file: string) {
  return (await readFile(file)).subarray(0, 80).toString("latin1");
}

describe("the old tool names are gone", () => {
  test.each(["cookies", "collect_pages", "save_page"])("%s is not listed", async (name) => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain(name);
  });
});

describe("storage description", () => {
  test("the first sentence names every area", async () => {
    const description = (await toolEntry("storage"))?.description ?? "";
    expect(description.split(". ")[0]).toMatch(/cookies[\s\S]*local[\s\S]*session[\s\S]*indexeddb/);
  });

  test("the first sentence names every action", async () => {
    const description = (await toolEntry("storage"))?.description ?? "";
    expect(description.split(". ")[0]).toMatch(
      /list[\s\S]*set[\s\S]*delete[\s\S]*export[\s\S]*get/,
    );
  });

  test("is not read-only", async () => {
    expect((await toolEntry("storage"))?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("storage area cookies", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
  });

  afterAll(async () => {
    await ok("storage", { area: "cookies", action: "delete", domain: "x.com" });
    await ok("storage", { area: "cookies", action: "delete", domain: "netflix.com" });
    await mcp.deps.manager.closeTab(tab.id);
  });

  test("set with tab adds a cookie for the tab's site", async () => {
    expect(
      await ok("storage", {
        area: "cookies",
        action: "set",
        tab: tab.id,
        key: "agent_cookie",
        value: "cookie-value-1",
      }),
    ).toMatch(/Set cookie agent_cookie for http:\/\/127\.0\.0\.1/);
  });

  test("list with tab shows the cookie and its value", async () => {
    expect(await ok("storage", { area: "cookies", action: "list", tab: tab.id })).toMatch(
      /agent_cookie=cookie-value-1/,
    );
  });

  test("the cookie is sent with the tab's requests", async () => {
    const headers = await tab.page.evaluate(() => fetch("/api/echo").then((r) => r.text()));
    expect(headers).toMatch(/agent_cookie=cookie-value-1/);
  });

  test("list with key keeps only that cookie", async () => {
    await ok("storage", { area: "cookies", action: "set", tab: tab.id, key: "other", value: "2" });
    const listed = await ok("storage", {
      area: "cookies",
      action: "list",
      tab: tab.id,
      key: "other",
    });
    expect(listed).not.toMatch(/agent_cookie/);
  });

  test("list clips long values to 60 characters", async () => {
    await ok("storage", {
      area: "cookies",
      action: "set",
      tab: tab.id,
      key: "long",
      value: "v".repeat(80),
    });
    expect(
      await ok("storage", { area: "cookies", action: "list", tab: tab.id, key: "long" }),
    ).toMatch(/long=v{60}… \(80 chars\)/);
  });

  test("list with full_values shows the whole value", async () => {
    expect(
      await ok("storage", {
        area: "cookies",
        action: "list",
        tab: tab.id,
        key: "long",
        full_values: true,
      }),
    ).toMatch(/long=v{80} \[/);
  });

  test("export writes the matching cookies with their values to a JSON file", async () => {
    const exported = await ok("storage", {
      area: "cookies",
      action: "export",
      tab: tab.id,
      key: "agent_cookie",
    });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8"))[0].value).toBe("cookie-value-1");
  });

  test("set with domain adds a cookie for another site", async () => {
    expect(
      await ok("storage", {
        area: "cookies",
        action: "set",
        domain: ".x.com",
        key: "agent_cookie",
        value: "elsewhere",
      }),
    ).toMatch(/Set cookie agent_cookie for \.x\.com/);
  });

  test("delete by key alone is refused, so one name cannot sign the user out of every site", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "delete", key: "agent_cookie" }),
    ).toMatch(/delete needs tab or domain/);
  });

  test("a refused delete by key alone removes nothing", async () => {
    await call("storage", { area: "cookies", action: "delete", key: "agent_cookie" });
    expect(
      await ok("storage", {
        area: "cookies",
        action: "list",
        domain: "x.com",
        key: "agent_cookie",
      }),
    ).toMatch(/agent_cookie=elsewhere/);
  });

  test("delete with tab and key removes the cookie of the tab's site", async () => {
    await ok("storage", {
      area: "cookies",
      action: "set",
      tab: tab.id,
      key: "scoped",
      value: "here",
    });
    await ok("storage", {
      area: "cookies",
      action: "set",
      domain: ".x.com",
      key: "scoped",
      value: "there",
    });
    expect(
      await ok("storage", { area: "cookies", action: "delete", tab: tab.id, key: "scoped" }),
    ).toMatch(/Deleted 1 cookies/);
  });

  test("delete with tab and key keeps the cookie of that name on other sites", async () => {
    expect(
      await ok("storage", { area: "cookies", action: "list", domain: "x.com", key: "scoped" }),
    ).toMatch(/scoped=there/);
  });

  test("delete with domain matches that domain and its subdomains only", async () => {
    await ok("storage", {
      area: "cookies",
      action: "set",
      domain: ".netflix.com",
      key: "keep_me",
      value: "1",
    });
    await ok("storage", {
      area: "cookies",
      action: "set",
      domain: "api.x.com",
      key: "drop_me",
      value: "1",
    });
    await ok("storage", { area: "cookies", action: "delete", domain: "x.com" });
    expect(await ok("storage", { area: "cookies", action: "list", domain: "netflix" })).toMatch(
      /keep_me/,
    );
  });

  test("delete with domain removes the subdomain's cookie", async () => {
    expect(
      await ok("storage", { area: "cookies", action: "list", domain: "x.com", key: "drop_me" }),
    ).toMatch(/No matching cookies/);
  });

  test("delete without tab, domain or key is refused", async () => {
    expect(await failure("storage", { area: "cookies", action: "delete" })).toMatch(
      /delete needs tab or domain/,
    );
  });

  test("set without a value is refused", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "set", tab: tab.id, key: "x" }),
    ).toMatch(/set needs key and value/);
  });

  test("set without tab, domain or url is refused", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "set", key: "x", value: "1" }),
    ).toMatch(/set needs domain, url, or tab/);
  });

  test("get is refused for cookies with the action to use", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "get", tab: tab.id, key: "x" }),
    ).toMatch(/list with key/);
  });

  test("a set-only field on list is refused by name", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "list", tab: tab.id, value: "1" }),
    ).toMatch(/value only applies to set/);
  });

  test("max_chars is refused for cookies", async () => {
    expect(
      await failure("storage", { area: "cookies", action: "list", tab: tab.id, max_chars: 500 }),
    ).toMatch(/max_chars only applies to get/);
  });

  test("delete with tab and no key removes every cookie of the tab's site", async () => {
    await ok("storage", { area: "cookies", action: "delete", tab: tab.id });
    expect(await ok("storage", { area: "cookies", action: "list", tab: tab.id })).toMatch(
      /No matching cookies/,
    );
  });
});

describe("storage areas local, session and indexeddb", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/doc");
    await tab.page.waitForFunction(() => document.body.textContent?.includes("idb ready"));
  });

  afterAll(async () => {
    await mcp.deps.manager.closeTab(tab.id);
  });

  test("list local shows keys with value sizes", async () => {
    expect(await ok("storage", { area: "local", action: "list", tab: tab.id })).toMatch(
      /auth_token \(44 chars\)/,
    );
  });

  test("get local returns the value", async () => {
    expect(
      await ok("storage", { area: "local", action: "get", tab: tab.id, key: "auth_token" }),
    ).toMatch(/tok-x{40}/);
  });

  test("get local clips to max_chars and saves the full value", async () => {
    expect(
      await ok("storage", {
        area: "local",
        action: "get",
        tab: tab.id,
        key: "auth_token",
        max_chars: 200,
      }),
    ).toMatch(/tok-x{40}/);
  });

  test("list session shows its keys", async () => {
    expect(await ok("storage", { area: "session", action: "list", tab: tab.id })).toMatch(
      /tab_state \(2 chars\)/,
    );
  });

  test("get of a missing key names the key", async () => {
    expect(
      await failure("storage", { area: "local", action: "get", tab: tab.id, key: "nope" }),
    ).toMatch(/no key "nope"/);
  });

  test("export local writes the entries to a JSON file", async () => {
    const exported = await ok("storage", { area: "local", action: "export", tab: tab.id });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    expect(JSON.parse(await readFile(file, "utf8")).entries.prefs).toBe('{"theme":"dark"}');
  });

  test("list indexeddb shows stores with record counts", async () => {
    expect(await ok("storage", { area: "indexeddb", action: "list", tab: tab.id })).toMatch(
      /fixture-db\/items \(2 records\)/,
    );
  });

  test("get indexeddb returns the records of one store", async () => {
    expect(
      await ok("storage", { area: "indexeddb", action: "get", tab: tab.id, key: "items" }),
    ).toMatch(/"name":"alpha"/);
  });

  test("export indexeddb writes every store to a JSON file", async () => {
    const exported = await ok("storage", { area: "indexeddb", action: "export", tab: tab.id });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    const dump = JSON.parse(await readFile(file, "utf8"));
    expect(dump.databases["fixture-db"].items.records[0].value.name).toBe("alpha");
  });

  const storedValue = async (value: string) => {
    const database = `typed-${Math.random().toString(36).slice(2)}`;
    await tab.page.evaluate(
      ({ name, source }) =>
        new Promise<void>((resolve) => {
          const request = indexedDB.open(name, 1);
          request.onupgradeneeded = () => {
            request.result
              .createObjectStore("values", { keyPath: "id" })
              .put({ id: 1, value: new Function(`return ${source};`)() });
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
      { name: database, source: value },
    );
    const exported = await ok("storage", { area: "indexeddb", action: "export", tab: tab.id });
    const file = /to (\S+\.json)/.exec(exported)?.[1] ?? "";
    return JSON.parse(await readFile(file, "utf8")).databases[database].values.records[0].value
      .value;
  };

  test("an IndexedDB Map arrives as the list of its entries with their key types", async () => {
    expect(await storedValue('new Map([[0, "v"]])')).toEqual([[0, "v"]]);
  });

  test("an IndexedDB Error arrives with its name and message", async () => {
    expect(await storedValue('new RangeError("far")')).toMatchObject({
      name: "RangeError",
      message: "far",
    });
  });

  test("an IndexedDB array buffer is named by its size", async () => {
    expect(await storedValue("new Uint8Array([1, 2, 3])")).toBe("<binary 3 bytes>");
  });

  test("an IndexedDB blob is named by its size", async () => {
    expect(await storedValue('new Blob(["abcd"])')).toBe("<blob 4 bytes>");
  });

  test("parallel indexeddb reads of different lengths on one tab all succeed", async () => {
    await tab.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const request = indexedDB.open("parallel-db", 1);
          request.onupgradeneeded = () => {
            const big = request.result.createObjectStore("big", { keyPath: "id" });
            for (let id = 0; id < 1000; id += 1) big.put({ id, nested: { id } });
            request.result.createObjectStore("tiny", { keyPath: "id" }).put({ id: 1, nested: {} });
          };
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
    );
    const big = call("storage", {
      area: "indexeddb",
      action: "get",
      tab: tab.id,
      key: "parallel-db/big",
    });
    const smalls = Array.from({ length: 20 }, () =>
      call("storage", { area: "indexeddb", action: "get", tab: tab.id, key: "parallel-db/tiny" }),
    );
    const results = await Promise.all([big, ...smalls]);
    expect(results.filter((result) => result.isError).map((result) => result.text)).toEqual([]);
  });

  test.each(["set", "delete"])("%s on web storage points to evaluate", async (action) => {
    expect(await failure("storage", { area: "local", action, tab: tab.id, key: "prefs" })).toMatch(
      /change it with evaluate/,
    );
  });

  test("web storage without tab is refused", async () => {
    expect(await failure("storage", { area: "session", action: "list" })).toMatch(/needs tab/);
  });

  test("a cookie field on web storage is refused by name", async () => {
    expect(
      await failure("storage", { area: "local", action: "list", tab: tab.id, domain: "x.com" }),
    ).toMatch(/domain only applies to area cookies/);
  });

  test("full_values on web storage is refused by name", async () => {
    expect(
      await failure("storage", {
        area: "local",
        action: "list",
        tab: tab.id,
        full_values: true,
      }),
    ).toMatch(/full_values only applies to area cookies/);
  });

  test("key on list of web storage is refused", async () => {
    expect(
      await failure("storage", { area: "local", action: "list", tab: tab.id, key: "prefs" }),
    ).toMatch(/key only applies to get/);
  });
});

describe("save_pages description", () => {
  test("the first sentence names both sources", async () => {
    const description = (await toolEntry("save_pages"))?.description ?? "";
    expect(description.split(". ")[0]).toMatch(/URLs[\s\S]*tabs/);
  });

  test("the first sentence names the file kinds", async () => {
    const description = (await toolEntry("save_pages"))?.description ?? "";
    expect(description.split(". ")[0]).toMatch(/PDF[\s\S]*MHTML[\s\S]*HTML/);
  });

  test("states the PDF paper size", async () => {
    expect((await toolEntry("save_pages"))?.description).toMatch(/A4, with backgrounds/);
  });
});

describe("save_pages with urls", () => {
  let index = "";

  beforeAll(async () => {
    index = await ok("save_pages", {
      urls: [`${fixture().url}/doc`],
      include: ["text", "pdf", "mhtml", "html"],
      settle_ms: 0,
    });
  });

  test("returns an index of the saved pages", () => {
    expect(index).toMatch(/Collected 1 of 1 pages into /);
  });

  test("saves the page text", async () => {
    expect(await readFile(await savedFile(index, "txt"), "utf8")).toMatch(/Bolt/);
  });

  test("saves a PDF", async () => {
    expect(await fileHead(await savedFile(index, "pdf"))).toMatch(/^%PDF/);
  });

  test("saves an MHTML archive", async () => {
    expect(await fileHead(await savedFile(index, "mhtml"))).toMatch(
      /From: |MIME-Version|Snapshot-Content-Location/i,
    );
  });

  test("saves the DOM as HTML", async () => {
    expect(await fileHead(await savedFile(index, "html"))).toMatch(/<html|<!DOCTYPE/i);
  });

  test("a folder holding a PDF is kept with the saved pages", () => {
    expect(savedDir(index)).toStartWith(path.join(mcp.deps.store.root, "pages"));
  });

  test("a folder with text only is transient", async () => {
    const text = await ok("save_pages", { urls: [`${fixture().url}/doc`], settle_ms: 0 });
    expect(savedDir(text)).toStartWith(path.join(mcp.deps.store.root, "collect"));
  });

  test("closes the tabs it opened", () => {
    expect(mcp.deps.manager.listTabs().filter((tab) => tab.page.url().endsWith("/doc"))).toEqual(
      [],
    );
  });
});

describe("save_pages with challenge, block and HTTP error pages", () => {
  let saved: Awaited<ReturnType<typeof call>>;

  const page = (index: number) =>
    z
      .array(z.object({ reason: z.string().optional(), files: z.array(z.string()) }))
      .parse(saved.structured?.pages)[index];

  beforeAll(async () => {
    saved = await call("save_pages", {
      urls: [
        `${fixture().url}/challenge/cloudflare`,
        `${fixture().url}/challenge/blocked`,
        `${fixture().url}/no-such-page`,
        `${fixture().url}/empty-500`,
        `${fixture().url}/doc`,
        `${fixture().url}/sign-in-first`,
      ],
      settle_ms: 0,
    });
  });

  test("a page answered with HTTP 404 is listed with reason http-error", () => {
    expect(page(2)?.reason).toBe("http-error");
  });

  test("a page answered with an empty HTTP 500 is listed with reason http-error", () => {
    expect(page(3)?.reason).toBe("http-error");
  });

  test("a page answered with HTTP 401 is listed with reason http-error", () => {
    expect(page(5)?.reason).toBe("http-error");
  });

  test("index.json lists a page answered with HTTP 404 with reason http-error", async () => {
    const listed = JSON.parse(
      await readFile(path.join(String(saved.structured?.dir), "index.json"), "utf8"),
    );
    expect(listed[2]).toMatchObject({ reason: "http-error" });
  });

  test("the index line of a page answered with HTTP 404 says it is not counted", () => {
    expect(saved.text).toMatch(
      /^03 404 \S+\/no-such-page .* — http error: not counted as collected$/m,
    );
  });

  test("the index line of a page answered with HTTP 401 says it is not counted", () => {
    expect(saved.text).toMatch(
      /^06 401 \S+\/sign-in-first .* — http error: not counted as collected$/m,
    );
  });

  test("the index line of a page answered with an empty HTTP 500 names the http error", () => {
    expect(saved.text).toMatch(
      /^04 FAILED \S+\/empty-500 — http error: HTTP 500 with an empty body, so there is nothing to save$/m,
    );
  });

  test("a page showing a Cloudflare challenge is listed as a challenge", () => {
    expect(page(0)?.reason).toBe("challenge");
  });

  test("a page the site blocked is listed as blocked", () => {
    expect(page(1)?.reason).toBe("blocked");
  });

  test("the files saved from a challenge page are kept", () => {
    expect(page(0)?.files).toEqual([expect.stringMatching(/\.txt$/)]);
  });

  test("only the page with real content counts as collected", () => {
    expect(saved.structured?.collected).toBe(1);
  });

  test("pages with HTTP 404, 500 and 401 are counted as HTTP errors", () => {
    expect(saved.structured?.httpErrors).toBe(3);
  });

  test("the index head says which pages were not counted and why", () => {
    expect(saved.text).toContain(
      "Not counted: 3 HTTP errors (404, 500, 401), 1 challenge, 1 blocked.",
    );
  });

  test("a challenge that clears by itself is saved as the page it leads to", async () => {
    const cleared = await call("save_pages", {
      urls: [`${fixture().url}/challenge/cloudflare-wait`],
      settle_ms: 0,
    });
    expect(cleared.text).toMatch(/^01 200 \S+\/challenge\/cleared "Shop Home"/m);
  });
});

describe("save_pages with a Cloudflare check whose title is translated that outlasts timeout_ms", () => {
  test("the page is listed as a challenge", async () => {
    const saved = await call("save_pages", {
      urls: [`${fixture().url}/challenge/cloudflare-translated`],
      settle_ms: 0,
      timeout_ms: 1500,
    });
    expect(
      z.array(z.object({ reason: z.string().optional() })).parse(saved.structured?.pages)[0]
        ?.reason,
    ).toBe("challenge");
  });
});

describe("save_pages of pages answered with HTTP 429", () => {
  let saved: Awaited<ReturnType<typeof call>>;

  beforeAll(async () => {
    saved = await call("save_pages", {
      urls: [`${fixture().url}/empty-429`, `${fixture().url}/challenge/blocked`],
      settle_ms: 0,
    });
  });

  test("a 429 with an empty body is listed as blocked", () => {
    expect(saved.structured?.pages).toMatchObject([{ status: 429, reason: "blocked" }, {}]);
  });

  test("a 429 with an empty body is not counted as an HTTP error", () => {
    expect(saved.structured?.httpErrors).toBe(0);
  });

  test("a 429 with an empty body says the site rate-limited the visits", () => {
    expect(saved.text).toMatch(
      /^01 FAILED \S+\/empty-429 — rate limited: the site refused the visit \(HTTP 429, title "[^"]*"\), so the page is not counted as collected; wait before loading this site again, or raise delay_ms$/m,
    );
  });

  test("a 429 page with a body says the site rate-limited the visits", () => {
    expect(saved.text).toMatch(
      /^02 FAILED \S+\/challenge\/blocked — rate limited: the site refused the visit \(HTTP 429, title "Too Many Requests"\), so the page is not counted as collected; wait before loading this site again, or raise delay_ms/m,
    );
  });
});

describe("save_pages of a tab after a navigation answered with no content", () => {
  test("the page's own title is listed", async () => {
    const tab = await openTab("/article");
    await tab.page.evaluate(() => {
      location.href = "/to-no-content";
    });
    await sleep(500);
    const saved = await ok("save_pages", { tabs: [tab.id], settle_ms: 0 });
    expect(saved).toMatch(/^01 200 \S+\/article "Fixture Article"/m);
  });
});

describe("save_pages with short pages that look like a check", () => {
  let saved: Awaited<ReturnType<typeof call>>;

  beforeAll(async () => {
    saved = await call("save_pages", {
      urls: [
        `${fixture().url}/challenge/bot-article`,
        `${fixture().url}/challenge/please-wait`,
        `${fixture().url}/challenge/forbidden`,
      ],
      settle_ms: 0,
    });
  });

  test("a short article about bot detection is collected", () => {
    expect(saved.text).toMatch(/^01 200 \S+\/challenge\/bot-article "Bot detection 101"/m);
  });

  test("a short page titled Please wait answered with HTTP 200 is collected", () => {
    expect(saved.text).toMatch(/^02 200 \S+\/challenge\/please-wait "Please wait"/m);
  });

  test("a 403 Forbidden page without other block signals is counted as an HTTP error", () => {
    expect(saved.text).toContain("Not counted: 1 HTTP error (403).");
  });
});

describe("save_pages with a challenge that outlasts timeout_ms", () => {
  test("the page is listed as a challenge", async () => {
    const saved = await call("save_pages", {
      urls: [`${fixture().url}/challenge/cloudflare-stuck`],
      settle_ms: 0,
      timeout_ms: 3000,
    });
    expect(
      z.array(z.object({ reason: z.string().optional() })).parse(saved.structured?.pages)[0]
        ?.reason,
    ).toBe("challenge");
  });
});

describe("save_pages with an animated challenge that answers just before timeout_ms", () => {
  test("the page is listed as a challenge", async () => {
    const saved = await call("save_pages", {
      urls: [`${fixture().url}/challenge/cloudflare-slow`],
      timeout_ms: 3000,
    });
    expect(
      z.array(z.object({ reason: z.string().optional() })).parse(saved.structured?.pages)[0]
        ?.reason,
    ).toBe("challenge");
  });
});

describe("save_pages with a slow animated Turnstile page whose widget has not loaded", () => {
  test("the page is listed as a challenge", async () => {
    const saved = await call("save_pages", {
      urls: [`${fixture().url}/challenge/turnstile-slow`],
      timeout_ms: 3000,
    });
    expect(
      z.array(z.object({ reason: z.string().optional() })).parse(saved.structured?.pages)[0]
        ?.reason,
    ).toBe("challenge");
  });
});

const elapsed = (from: string, to: string) =>
  (fixture().requestedAt(to) ?? 0) - (fixture().requestedAt(from) ?? 0);

describe("save_pages with delay_ms", () => {
  beforeAll(async () => {
    const other = fixture().url.replace("127.0.0.1", "localhost");
    await ok("save_pages", {
      urls: [`${fixture().url}/article`, `${fixture().url}/doc`, `${other}/counter`],
      delay_ms: 1500,
      concurrency: 3,
      settle_ms: 0,
    });
  });

  test("spaces the starts of pages on the same site by delay_ms", () => {
    expect(elapsed("/article", "/doc")).toBeGreaterThanOrEqual(1400);
  });

  test("does not delay a page on another site", () => {
    expect(elapsed("/article", "/counter")).toBeLessThan(1000);
  });
});

describe("save_pages on one site", () => {
  beforeAll(async () => {
    const other = fixture().url.replace("127.0.0.1", "localhost");
    await ok("save_pages", {
      urls: [
        `${fixture().url}/actions/slow`,
        `${fixture().url}/actions/landing`,
        `${other}/counter`,
      ],
      concurrency: 3,
      settle_ms: 0,
    });
  });

  test("loads a page on the same site only after the previous one finished", () => {
    expect(elapsed("/actions/slow", "/actions/landing")).toBeGreaterThanOrEqual(SLOW_MS - 100);
  });

  test("loads a page on another site meanwhile", () => {
    expect(elapsed("/actions/slow", "/counter")).toBeLessThan(SLOW_MS - 100);
  });
});

describe("save_pages status without a fresh load", () => {
  let restored: Awaited<ReturnType<typeof call>>;
  let inline: Awaited<ReturnType<typeof call>>;

  const firstPage = (result: Awaited<ReturnType<typeof call>>) =>
    z
      .array(
        z.object({
          status: z.number().optional(),
          statusNote: z.string().optional(),
          chars: z.number().optional(),
        }),
      )
      .parse(result.structured?.pages)[0];

  beforeAll(async () => {
    const tab = await openTab("/doc");
    await tab.page.goto(`${fixture().url}/article`);
    await tab.page.goBack({ waitUntil: "commit" });
    restored = await call("save_pages", { tabs: [tab.id], settle_ms: 0 });
    const data = await openTab("/doc");
    await data.page.goto("data:text/html,<title>inline</title><p>inline text</p>");
    inline = await call("save_pages", { tabs: [data.id], settle_ms: 0 });
  });

  test("a tab saved as it is gives its page's HTTP status", () => {
    expect(firstPage(restored)?.status).toBe(200);
  });

  test("a page not loaded over HTTP says why it has no status", () => {
    expect(firstPage(inline)?.statusNote).toBe("not loaded over HTTP");
  });

  test("the index says why a page has no status", () => {
    expect(inline.text).toContain("status unknown: not loaded over HTTP");
  });

  test("the structured pages give the text length", () => {
    expect(firstPage(inline)?.chars).toBeGreaterThan(0);
  });
});

describe("save_pages with tabs", () => {
  let first: Tab;
  let second: Tab;
  let result: Awaited<ReturnType<typeof call>>;

  beforeAll(async () => {
    first = await openTab("/doc");
    second = await openTab("/article");
    result = await call("save_pages", {
      tabs: [first.id, second.id],
      include: ["markdown", "pdf"],
      settle_ms: 0,
    });
  });

  afterAll(async () => {
    await mcp.deps.manager.closeTab(first.id);
    await mcp.deps.manager.closeTab(second.id);
  });

  test("saves every tab", () => {
    expect(result.text).toMatch(/Collected 2 of 2 pages into /);
  });

  test("saves each tab's current content as Markdown", async () => {
    const dir = savedDir(result.text);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).toSorted();
    expect(await readFile(path.join(dir, names[1] ?? ""), "utf8")).toMatch(/Paragraph 7 of/);
  });

  test("saves a PDF of each tab", async () => {
    const dir = savedDir(result.text);
    expect((await readdir(dir)).filter((name) => name.endsWith(".pdf")).length).toBe(2);
  });

  test("lists the PDF in the structured pages", () => {
    const pages = result.structured?.pages;
    expect(JSON.stringify(pages)).toMatch(/01-[^"]*\.pdf/);
  });

  test("leaves the tabs open where they were", () => {
    expect([first.page.isClosed(), first.page.url()]).toEqual([false, `${fixture().url}/doc`]);
  });

  test("a folder from tabs answers ask_pages through dir", async () => {
    const answer = await ok("ask_pages", {
      question: "Which page has paragraph 7?",
      dir: savedDir(result.text),
      browse: "off",
    });
    expect(answer).toMatch(/Paragraph 7 is in the article \[02-/);
  });
});

describe("save_pages tab checks", () => {
  test("a tab with an open dialog is listed as failed with the dialog", async () => {
    const tab = await openTab("/");
    try {
      await ok("evaluate", { tab: tab.id, expression: "setTimeout(() => alert('Hold on'), 0)" });
      await tab.page.waitForTimeout(300);
      const result = await call("save_pages", { tabs: [tab.id], settle_ms: 0 });
      expect(result.text).toMatch(/FAILED .* An alert dialog is open: "Hold on"/);
    } finally {
      await mcp.deps.manager.closeTab(tab.id);
    }
  });

  test("a dialog that opens while a tab is saved fails that page with the dialog", async () => {
    const { result } = await saveWithLateDialog("Late notice");
    expect(result.text).toMatch(/FAILED .* An alert dialog is open: "Late notice"/);
  });

  test("a dialog that opens while a tab is saved ends the call promptly", async () => {
    const { ms } = await saveWithLateDialog("Late again");
    expect(ms).toBeLessThan(10_000);
  });

  test("a tab whose save a dialog ended writes nothing after the dialog is answered", async () => {
    const tab = await openTab("/");
    try {
      await ok("evaluate", {
        tab: tab.id,
        expression: "setTimeout(() => alert('Answer me'), 400)",
      });
      const result = await call("save_pages", { tabs: [tab.id], settle_ms: 1000 });
      await ok("dialog", { tab: tab.id, action: "accept" });
      await sleep(3000);
      expect(await readdir(savedDir(result.text))).toEqual(["index.json"]);
    } finally {
      await mcp.deps.manager.closeTab(tab.id);
    }
  });

  test("a dialog that opens in a later tab while an earlier one is saved fails that tab with the dialog", async () => {
    const first = await openTab("/doc");
    const later = await openTab("/");
    try {
      await ok("evaluate", {
        tab: later.id,
        expression: "setTimeout(() => alert('Meanwhile'), 400)",
      });
      const result = await call("save_pages", { tabs: [first.id, later.id], settle_ms: 3000 });
      expect(result.text).toMatch(/FAILED .* An alert dialog is open: "Meanwhile"/);
    } finally {
      await mcp.deps.manager.closeTab(first.id);
      await mcp.deps.manager.closeTab(later.id);
    }
  });

  test("a tab with an open dialog does not stop the other tabs", async () => {
    const blocked = await openTab("/");
    const free = await openTab("/doc");
    try {
      await ok("evaluate", { tab: blocked.id, expression: "setTimeout(() => alert('Wait'), 0)" });
      await blocked.page.waitForTimeout(300);
      const result = await call("save_pages", { tabs: [blocked.id, free.id], settle_ms: 0 });
      expect(result.text).toMatch(/Collected 1 of 2 pages/);
    } finally {
      await mcp.deps.manager.closeTab(blocked.id);
      await mcp.deps.manager.closeTab(free.id);
    }
  });

  test("a tab of another session is saved with a note", async () => {
    const tab = await openTab("/doc");
    tab.owner = "someone-else";
    try {
      expect(await ok("save_pages", { tabs: [tab.id], settle_ms: 0 })).toMatch(
        new RegExp(`Note: ${tab.id} belongs to another session\\.`),
      );
    } finally {
      await mcp.deps.manager.closeTab(tab.id);
    }
  });

  test("an unknown tab is refused", async () => {
    expect(await failure("save_pages", { tabs: ["t999999"] })).toMatch(/t999999/);
  });
});

describe("save_pages input rules", () => {
  test("urls and tabs together are refused", async () => {
    expect(await failure("save_pages", { urls: [`${fixture().url}/doc`], tabs: ["t1"] })).toMatch(
      /exactly one of urls or tabs/,
    );
  });

  test("neither urls nor tabs is refused", async () => {
    expect(await failure("save_pages", { include: ["pdf"] })).toMatch(
      /exactly one of urls or tabs/,
    );
  });

  test.each([
    ["wait_until", "load"],
    ["concurrency", 2],
    ["timeout_ms", 5000],
    ["delay_ms", 500],
  ] as const)("%s with tabs is refused", async (field, value) => {
    expect(await failure("save_pages", { tabs: ["t1"], [field]: value })).toMatch(
      new RegExp(`${field} only applies to urls`),
    );
  });
});

describe("ask_pages names save_pages", () => {
  test("the description calls a folder source a save_pages folder", async () => {
    expect((await toolEntry("ask_pages"))?.description).toMatch(/a save_pages folder/);
  });

  test("the description says the adapter is listed by tabs", async () => {
    expect((await toolEntry("ask_pages"))?.description).toMatch(/listed by tabs/);
  });

  test("the description keeps the dropped-issue evidence rule", async () => {
    expect((await toolEntry("ask_pages"))?.description).toMatch(
      /browse disagreed, without evidence on the page/,
    );
  });

  test("the description keeps the count check", async () => {
    expect((await toolEntry("ask_pages"))?.description).toMatch(/count checked: 6, not 7/);
  });
});
