import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ToolArgs } from "../tests/mcpHarness.ts";
import { VALUE_CASES } from "../tests/valueCases.ts";
import { useToolsHarness } from "./tools-harness.ts";
import { sleep } from "../src/shared/async.ts";
import type { Tab } from "../src/browser/tab.ts";

const { mcp, fixture, failure, openTab } = useToolsHarness("tools-network-script");

const fetchIn = (tab: Tab, path: string) =>
  tab.page.evaluate((target) => fetch(target).then((response) => response.status), path);

describe("network list across pages", () => {
  let tab: Tab;
  let list: string;

  beforeAll(async () => {
    tab = await openTab("/");
    await fetchIn(tab, "/api/data?first-page");
    await tab.page.goto(`${fixture().url}/pending-request`);
    await fetchIn(tab, "/api/items?second-page");
    await sleep(500);
    list = await mcp.ok("network", { tab: tab.id });
  });

  test("an earlier page's request sits under that page's URL", () => {
    expect(list).toMatch(
      new RegExp(`Page ${fixture().url}/:\\n(?:#\\d+ .*\\n)*#\\d+ GET 200 fetch \\S+first-page`),
    );
  });

  test("the current page's request sits under the current page's URL", () => {
    const current = list.split(`Page ${fixture().url}/pending-request`)[1] ?? "";
    expect(current).toMatch(/second-page/);
  });

  test("the earlier page's request is not shown under the current page", () => {
    const current = list.split(`Page ${fixture().url}/pending-request`)[1] ?? "";
    expect(current).not.toMatch(/first-page/);
  });

  test("the newest page comes last and is marked as current", () => {
    expect(list.lastIndexOf("Page ")).toBe(
      list.indexOf(`Page ${fixture().url}/pending-request (current)`),
    );
  });

  test("a request still waiting is listed under the page it belongs to", () => {
    const current = list.split(`Page ${fixture().url}/pending-request`)[1] ?? "";
    expect(current).toMatch(/Still waiting for a response:\n#\d+ GET fetch \S+\/api\/pending/);
  });

  test("a filter with * stands for any characters in the URL", async () => {
    expect(await mcp.ok("network", { tab: tab.id, pattern: "**/api/*?second-*" })).toMatch(
      /#\d+ GET 200 fetch \S+\/api\/items\?second-page/,
    );
  });

  test("a har export with a * filter keeps the matching request", async () => {
    const text = await mcp.ok("network", { tab: tab.id, pattern: "*/api/*?first-*", har: true });
    const file = /to (\S+\.har)/.exec(text)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toContain("first-page");
  });

  test("a filter matching only the earlier page lists that page", async () => {
    const filtered = await mcp.ok("network", { tab: tab.id, pattern: "first-page" });
    expect(filtered).toMatch(
      new RegExp(`Page ${fixture().url}/:\\n#\\d+ GET 200 fetch \\S+first-page`),
    );
  });

  test("a filter matching only the earlier page says the current page has no matching requests", async () => {
    const filtered = await mcp.ok("network", { tab: tab.id, pattern: "first-page" });
    expect(filtered).toContain(
      `Page ${fixture().url}/pending-request (current): no matching requests`,
    );
  });

  test("the filtered result names pages with the same header as the unfiltered one", async () => {
    const filtered = await mcp.ok("network", { tab: tab.id, pattern: "first-page" });
    expect(filtered).toContain(`Page ${fixture().url}/:`);
  });

  test("a filter matching nothing anywhere says so for the whole tab", async () => {
    const filtered = await mcp.ok("network", { tab: tab.id, pattern: "no-such-request-anywhere" });
    expect(filtered).toMatch(/No network entries match the filter in \d+ captured requests of /);
  });

  test("types keeps only the requested resource types", async () => {
    const filtered = await mcp.ok("network", { tab: tab.id, types: ["document"] });
    expect(filtered).not.toMatch(/ fetch /);
  });

  test("limit keeps the newest entries", async () => {
    const limited = await mcp.ok("network", { tab: tab.id, limit: 1 });
    expect(limited).toMatch(/second-page|api\/pending/);
  });

  test("limit drops the older page when only the newest entries are kept", async () => {
    const limited = await mcp.ok("network", { tab: tab.id, limit: 1 });
    expect(limited).not.toContain(`Page ${fixture().url}/:`);
  });
});

describe("network list after a redirect", () => {
  test("the redirecting navigation and its landing page form one page group", async () => {
    const tab = await openTab("/actions/redirect");
    const list = await mcp.ok("network", { tab: tab.id });
    expect(list.match(/^Page /gm)).toHaveLength(1);
    expect(list).toContain(`Page ${fixture().url}/actions/landing (current):`);
  });
});

describe("network list on a data URL page", () => {
  let list: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    const script = `fetch(${JSON.stringify(`${fixture().url}/api/data?data-page`)})`;
    await tab.page.goto(`data:text/html,<title>d</title><script>${script}</script>`);
    await sleep(500);
    list = await mcp.ok("network", { tab: tab.id });
  });

  test("the data URL page is the current page", () => {
    expect(list).toMatch(/^Page data:text\/html… \(\d+ chars\) \(current\):/m);
  });

  test("the data URL page's request sits under that page", () => {
    expect(list.split("Page data:text/html")[1]).toMatch(/data-page/);
  });
});

const abortReported = process.env.WEB_AGENT_ENGINE === "playwright";

describe("network list after leaving a page with a request still waiting", () => {
  let tab: Tab;
  let list: string;

  beforeAll(async () => {
    tab = await openTab("/pending-request");
    await sleep(300);
    await tab.page.goto(`${fixture().url}/`);
    list = await mcp.ok("network", { tab: tab.id });
  });

  const leftGroup = () =>
    list.split(`Page ${fixture().url}/pending-request:`)[1]?.split("\nPage ")[0] ?? "";

  test.skipIf(abortReported)(
    "the request is listed as abandoned under the page it belonged to",
    () => {
      expect(leftGroup()).toMatch(
        /Abandoned without a response when the tab left the page:\n#\d+ GET fetch \S+\/api\/pending\n?/,
      );
    },
  );

  test("the request is no longer listed as waiting", () => {
    expect(leftGroup()).not.toMatch(/Still waiting for a response/);
  });

  test.skipIf(abortReported)(
    "the request read by id says the tab left the page before an answer",
    async () => {
      const id = /#(\d+) GET fetch \S+\/api\/pending/.exec(leftGroup())?.[1];
      expect(await mcp.ok("network", { tab: tab.id, id: Number(id) })).toMatch(
        /\nNo response: the tab left the page before the server answered\.$/,
      );
    },
  );
});

describe("a navigation answered with no content", () => {
  let list: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    await tab.page.evaluate(() => {
      location.href = "/no-content";
    });
    await sleep(500);
    await fetchIn(tab, "/api/data?after-no-content");
    await sleep(300);
    list = await mcp.ok("network", { tab: tab.id });
  });

  test("a later request sits under the page that stayed open", () => {
    expect(list).toMatch(
      new RegExp(
        `Page ${fixture().url}/ \\(current\\):\\n(?:#\\d+ .*\\n)*#\\d+ GET 200 fetch \\S+after-no-content`,
      ),
    );
  });
  test("the only page listed is the page that stayed open", () => {
    expect(list.match(/^Page .*$/gm)).toEqual([`Page ${fixture().url}/ (current):`]);
  });

  test("the navigation answered with no content is listed once", () => {
    expect(list.match(/^#\d+ .*\/no-content$/gm)).toHaveLength(1);
  });

  test("the navigation answered with no content is listed under the page that stayed open", () => {
    expect(list).toMatch(
      new RegExp(
        `Page ${fixture().url}/ \\(current\\):\\n(?:#\\d+ .*\\n)*#\\d+ GET 204 document \\S+/no-content\\n`,
      ),
    );
  });
});

describe("a navigation redirected to no content", () => {
  let list: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    await tab.page.evaluate(() => {
      location.href = "/to-no-content";
    });
    await sleep(500);
    await fetchIn(tab, "/api/data?after-redirect-to-no-content");
    await sleep(300);
    list = await mcp.ok("network", { tab: tab.id });
  });

  test("a later request sits under the page that stayed open", () => {
    expect(list).toMatch(
      new RegExp(
        `Page ${fixture().url}/ \\(current\\):\\n(?:#\\d+ .*\\n)*#\\d+ GET 200 fetch \\S+after-redirect-to-no-content`,
      ),
    );
  });
  test("the only page listed is the page that stayed open", () => {
    expect(list.match(/^Page .*$/gm)).toEqual([`Page ${fixture().url}/ (current):`]);
  });

  test("the no content answer the redirect ends in is listed once", () => {
    expect(list.match(/^#\d+ .*\/no-content$/gm)).toHaveLength(1);
  });

  test("the redirect that ends in no content is listed under the page that stayed open", () => {
    expect(list).toMatch(
      new RegExp(
        `Page ${fixture().url}/ \\(current\\):\\n(?:#\\d+ .*\\n)*#\\d+ GET 302 document \\S+/to-no-content\\n`,
      ),
    );
  });
});

describe("a post to the page's own URL answered with no content", () => {
  test("read_page returns the response body of the page shown", async () => {
    const tab = await openTab("/no-content-on-post");
    await tab.page.evaluate(() => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = location.href;
      document.body.append(form);
      form.submit();
    });
    await sleep(500);
    expect(await mcp.ok("read_page", { tab: tab.id })).toMatch(
      /\n\{"form":"kept after a post"\}\n\[chars 0-\d+ of \d+; end of text\]$/,
    );
  });
});

describe("a post to the page's own URL redirected to no content", () => {
  test("read_page returns the response body of the page shown", async () => {
    const tab = await openTab("/redirect-on-post");
    await tab.page.evaluate(() => {
      const form = document.createElement("form");
      form.method = "post";
      form.action = location.href;
      document.body.append(form);
      form.submit();
    });
    await sleep(500);
    expect(await mcp.ok("read_page", { tab: tab.id })).toMatch(
      /\n\{"form":"kept after a redirected post"\}\n\[chars 0-\d+ of \d+; end of text\]$/,
    );
  });
});

describe("a page shown again with back", () => {
  let list: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    await tab.page.goto(`${fixture().url}/article`);
    await tab.page.goBack({ waitUntil: "commit" });
    await sleep(500);
    list = await mcp.ok("network", { tab: tab.id });
  });

  test("the current page lists the request that loaded it", () => {
    expect(list).toMatch(
      new RegExp(
        `Page ${fixture().url}/ \\(current\\):\\n#\\d+ GET 200 document ${fixture().url}/(?:\\n|$)`,
      ),
    );
  });
});

describe("a reload of the same URL", () => {
  let network: string;
  let logs: string;

  beforeAll(async () => {
    const tab = await openTab("/");
    await tab.page.reload();
    await sleep(500);
    network = await mcp.ok("network", { tab: tab.id });
    logs = await mcp.ok("logs", { source: "page", tab: tab.id });
  });

  test("network lists each load as a page of its own", () => {
    expect(network.split(`Page ${fixture().url}/`).length - 1).toBe(2);
  });

  test("logs lists each load as a page of its own", () => {
    expect(logs.split(`[page content from ${fixture().url}/ — `).length - 1).toBe(2);
  });
});

describe("network failed_only", () => {
  test("lists only requests with an error status", async () => {
    const tab = await openTab("/");
    await fetchIn(tab, "/empty-500");
    await fetchIn(tab, "/api/data");
    const list = await mcp.ok("network", { tab: tab.id, failed_only: true });
    expect(list).toMatch(/GET 500 fetch \S+\/empty-500/);
    expect(list).not.toMatch(/\/api\/data/);
  });
});

describe("network id", () => {
  let tab: Tab;
  let detail: string;

  beforeAll(async () => {
    tab = await openTab("/");
    await fetchIn(tab, "/api/data");
    const list = await mcp.ok("network", { tab: tab.id, pattern: "/api/data" });
    const id = Number(/#(\d+) GET 200/.exec(list)?.[1]);
    detail = await mcp.ok("network", { tab: tab.id, id });
  });

  test("returns the request and response in full", () => {
    expect(detail).toMatch(/Request headers:[\s\S]*Response headers:[\s\S]*loaded from api/);
  });

  test("an unknown id is an error naming the tab", async () => {
    expect(await failure("network", { tab: tab.id, id: 99999 })).toMatch(
      /Request 99999 is no longer in the buffer of /,
    );
  });

  test("id together with pattern is rejected", async () => {
    expect(await failure("network", { tab: tab.id, id: 1, pattern: "x" })).toMatch(/id .*pattern/);
  });

  test("id together with types is rejected", async () => {
    expect(await failure("network", { tab: tab.id, id: 1, types: ["xhr"] })).toMatch(/id .*types/);
  });

  test("id together with failed_only is rejected", async () => {
    expect(await failure("network", { tab: tab.id, id: 1, failed_only: true })).toMatch(
      /id .*failed_only/,
    );
  });

  test("id together with limit is rejected", async () => {
    expect(await failure("network", { tab: tab.id, id: 1, limit: 5 })).toMatch(/id .*limit/);
  });

  test("id together with har is rejected", async () => {
    expect(await failure("network", { tab: tab.id, id: 1, har: true })).toMatch(/id .*har/);
  });

  test("max_chars without id is rejected", async () => {
    expect(await failure("network", { tab: tab.id, max_chars: 500 })).toMatch(/max_chars needs id/);
  });
});

describe("network har", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
    await fetchIn(tab, "/api/data");
    await fetchIn(tab, "/api/items?page=2");
  });

  async function exported(args: ToolArgs) {
    const text = await mcp.ok("network", { tab: tab.id, har: true, ...args });
    const file = /to (\S+\.har)/.exec(text)?.[1] ?? "";
    expect(file, text).toMatch(/\.har$/);
    return { text, file, har: JSON.parse(await readFile(file, "utf8")) };
  }

  test("writes a HAR 1.2 file and names its path", async () => {
    const { text, har } = await exported({});
    expect(text).toMatch(/^Exported \d+ requests to /);
    expect(har.log.version).toBe("1.2");
  });

  test("the file holds the response bodies by default", async () => {
    const { har } = await exported({ pattern: "/api/data" });
    expect(JSON.stringify(har.log.entries)).toContain("loaded from api");
  });

  test("include_bodies false leaves the response bodies out", async () => {
    const { har } = await exported({ pattern: "/api/data", include_bodies: false });
    expect(JSON.stringify(har.log.entries)).not.toContain("loaded from api");
  });

  test("pattern keeps only matching requests", async () => {
    const { har } = await exported({ pattern: "/api/items" });
    expect(har.log.entries).toHaveLength(1);
  });

  test("types keeps only the requested resource types", async () => {
    const { text } = await exported({ types: ["fetch"] });
    expect(text).toMatch(/^Exported 2 requests/);
  });

  test("label names the file", async () => {
    const { file } = await exported({ label: "checkout-trace" });
    expect(file).toContain("checkout-trace");
  });

  test("a filter matching nothing says so without writing a file", async () => {
    const text = await mcp.ok("network", { tab: tab.id, har: true, pattern: "no-such-request" });
    expect(text).toMatch(/No matching network entries captured for /);
  });

  test("har together with limit is rejected", async () => {
    expect(await failure("network", { tab: tab.id, har: true, limit: 5 })).toMatch(/har .*limit/);
  });

  test("har together with failed_only is rejected", async () => {
    expect(await failure("network", { tab: tab.id, har: true, failed_only: true })).toMatch(
      /har .*failed_only/,
    );
  });

  test("har together with max_chars is rejected", async () => {
    expect(await failure("network", { tab: tab.id, har: true, max_chars: 500 })).toMatch(
      /har .*max_chars/,
    );
  });

  test("include_bodies without har is rejected", async () => {
    expect(await failure("network", { tab: tab.id, include_bodies: false })).toMatch(
      /include_bodies needs har/,
    );
  });

  test("label without har is rejected", async () => {
    expect(await failure("network", { tab: tab.id, label: "x" })).toMatch(/label needs har/);
  });
});

describe("intercept add", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
  });

  test("mock fields without a mode are rejected instead of adding a rule that does nothing", async () => {
    const text = await failure("intercept", {
      tab: tab.id,
      action: "add",
      url: "/api/data",
      mock_body: '{"message":"mocked"}',
    });
    expect(text).toMatch(/add needs mode/);
  });

  test("a rejected add leaves no rule behind", async () => {
    expect(await mcp.ok("intercept", { tab: tab.id, action: "list" })).toMatch(
      /has no intercept rules/,
    );
  });

  test("a mock rule with its mode answers the request", async () => {
    await mcp.ok("intercept", {
      tab: tab.id,
      action: "add",
      mode: "mock",
      url: "/api/data",
      mock_body: '{"message":"mocked"}',
    });
    const body = await tab.page.evaluate(() =>
      fetch("/api/data").then((response) => response.text()),
    );
    expect(body).toBe('{"message":"mocked"}');
  });

  test("mock fields on a modify rule are rejected and name the mode they belong to", async () => {
    const text = await failure("intercept", {
      tab: tab.id,
      action: "add",
      mode: "modify",
      url: "/api/data",
      mock_status: 404,
    });
    expect(text).toMatch(/mock_status .*mock/);
  });

  test("replacements on a mock rule are rejected and name patch_response", async () => {
    const text = await failure("intercept", {
      tab: tab.id,
      action: "add",
      mode: "mock",
      url: "/api/data",
      replacements: [{ find: "a", replace: "b" }],
    });
    expect(text).toMatch(/replacements .*patch_response/);
  });

  test("a block rule takes no other rule fields", async () => {
    const text = await failure("intercept", {
      tab: tab.id,
      action: "add",
      mode: "block",
      url: "/api/data",
      method: "POST",
    });
    expect(text).toMatch(/method .*modify/);
  });

  test("add fields on list are rejected", async () => {
    expect(await failure("intercept", { tab: tab.id, action: "list", url: "/x" })).toMatch(
      /url .*add/,
    );
  });

  test("rule_id on add is rejected", async () => {
    expect(
      await failure("intercept", {
        tab: tab.id,
        action: "add",
        mode: "block",
        url: "/x",
        rule_id: 1,
      }),
    ).toMatch(/rule_id .*remove/);
  });

  test("remove without rule_id is rejected", async () => {
    expect(await failure("intercept", { tab: tab.id, action: "remove" })).toMatch(
      /remove needs rule_id/,
    );
  });

  test("clear removes every rule", async () => {
    expect(await mcp.ok("intercept", { tab: tab.id, action: "clear" })).toMatch(/Removed 1 rules/);
  });
});

describe("run_script openTab", () => {
  test("a tab the script opens that draws no frame gets a note in the script log", async () => {
    const { manager } = mcp.deps;
    const openTabFor = manager.openTab.bind(manager);
    manager.openTab = async (owner) => {
      const tab = await openTabFor(owner);
      const session = await tab.session;
      const send = session.send.bind(session);
      session.send = (method, params) =>
        method === "Runtime.evaluate" && JSON.stringify(params).includes("requestAnimationFrame")
          ? new Promise<never>(() => undefined)
          : send(method, params);
      return tab;
    };
    try {
      const result = await mcp.ok("run_script", {
        code: `const page = await openTab(${JSON.stringify(`${fixture().url}/`)}); await closeTab(page); return "done";`,
      });
      expect(result).toMatch(/Note: t\d+ had not drawn a frame within 1 s after openTab/);
    } finally {
      manager.openTab = openTabFor;
    }
  });
});

describe("intercept url patterns", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
  });

  async function answered(url: string, path: string, regex?: boolean) {
    await mcp.ok("intercept", { tab: tab.id, action: "clear" });
    await mcp.ok("intercept", {
      tab: tab.id,
      action: "add",
      mode: "mock",
      url,
      regex,
      mock_body: "mocked",
    });
    return tab.page.evaluate(
      (target) => fetch(target, { cache: "no-store" }).then((response) => response.text()),
      path,
    );
  }

  test("* matches every request", async () => {
    expect(await answered("*", "/api/data")).toBe("mocked");
  });

  test("*.png matches a png request", async () => {
    expect(await answered("*.png", "/pixel.png")).toBe("mocked");
  });

  test("*.png leaves a JSON request alone", async () => {
    expect(await answered("*.png", "/api/data")).not.toBe("mocked");
  });

  test("a full URL ending in /* matches a request under that path", async () => {
    expect(await answered(`${fixture().url}/api/*`, "/api/items")).toBe("mocked");
  });

  test("a full URL ending in /* leaves a request outside that path alone", async () => {
    expect(await answered(`${fixture().url}/api/*`, "/pixel.png")).not.toBe("mocked");
  });

  test("**/api/** matches a request with /api/ in its path", async () => {
    expect(await answered("**/api/**", "/api/data")).toBe("mocked");
  });

  test("**/api/** leaves a request without /api/ alone", async () => {
    expect(await answered("**/api/**", "/pixel.png")).not.toBe("mocked");
  });

  test("**/api/data matches the request for that path", async () => {
    expect(await answered("**/api/data", "/api/data")).toBe("mocked");
  });

  test("a glob keeps the other characters literal, so . does not match any character", async () => {
    expect(await answered("*/api.data", "/api/data")).not.toBe("mocked");
  });

  test("a regex rule matches by the regular expression", async () => {
    expect(await answered("pixel\\.png$", "/pixel.png", true)).toBe("mocked");
  });

  test("a rule's listing names the glob it matches", async () => {
    await answered("**/api/**", "/api/data");
    expect(await mcp.ok("intercept", { tab: tab.id, action: "list" })).toMatch(
      /where URL matches "\*\*\/api\/\*\*"/,
    );
  });

  test("an invalid regex is refused with the reason", async () => {
    expect(
      await failure("intercept", {
        tab: tab.id,
        action: "add",
        mode: "block",
        url: "*",
        regex: true,
      }),
    ).toMatch(/not a valid regular expression/);
  });
});

describe("wait_for request patterns", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
  });

  async function waited(request: string, path: string) {
    await tab.page.evaluate((target) => {
      setTimeout(() => void fetch(target, { cache: "no-store" }), 300);
    }, path);
    return mcp.ok("wait_for", { tab: tab.id, request, timeout_ms: 5000 });
  }

  test("a request filter with * waits for a response whose URL matches it", async () => {
    expect(await waited("**/api/*?glob-*", "/api/items?glob-wait")).toMatch(
      /^GET 200 \S+\/api\/items\?glob-wait$/,
    );
  });

  test("a request filter without * still waits for a response whose URL contains it", async () => {
    expect(await waited("api/data?plain-wait", "/api/data?plain-wait")).toMatch(
      /^GET 200 \S+\/api\/data\?plain-wait$/,
    );
  });
});

describe("run_script reads the page's own globals", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/page-globals");
  });

  const read = async (code: string) =>
    (await mcp.call("run_script", { tab: tab.id, code: `return ${code};` })).structured?.value;

  test("page.evaluate sees a number the page set on window", async () => {
    expect(await read("await page.evaluate(() => typeof window.n)")).toBe("number");
  });

  test("page.evaluate sees a function the page set on window over an element with the same id", async () => {
    expect(await read("await page.evaluate(() => typeof window.rerender)")).toBe("function");
  });

  test("page.evaluate calls a function the page defined", async () => {
    expect(await read("await page.evaluate(() => window.rerender())")).toBe("rerendered");
  });

  test("page.evaluate with a string sees the page's globals", async () => {
    expect(await read('await page.evaluate("typeof window.n")')).toBe("number");
  });

  test("page.evaluate with an argument sees the page's globals", async () => {
    expect(await read('await page.evaluate((name) => typeof window[name], "n")')).toBe("number");
  });

  test("mainFrame().evaluate sees the page's globals", async () => {
    expect(await read("await page.mainFrame().evaluate(() => typeof window.rerender)")).toBe(
      "function",
    );
  });

  test("a handle from evaluateHandle is the page's window", async () => {
    expect(
      await read(
        "await (await page.evaluateHandle(() => window)).evaluate((win) => typeof win.rerender)",
      ),
    ).toBe("function");
  });

  test("a locator's evaluate sees the page's globals", async () => {
    expect(await read('await page.locator("#rerender").evaluate(() => typeof window.n)')).toBe(
      "number",
    );
  });

  test("a locator's evaluateAll sees the page's globals", async () => {
    expect(await read('await page.locator("p").evaluateAll(() => typeof window.n)')).toBe("number");
  });

  test("page.$$eval sees the page's globals", async () => {
    expect(await read('await page.$$eval("p", () => typeof window.n)')).toBe("number");
  });

  test("an element handle's evaluate sees the page's globals", async () => {
    expect(await read('await (await page.$("#rerender")).evaluate(() => typeof window.n)')).toBe(
      "number",
    );
  });

  test("a ref's evaluate sees the page's globals", async () => {
    const snapshot = await mcp.ok("snapshot", { tab: tab.id, query: "Rerender me" });
    const ref = /button "Rerender me" \[ref=(\w+)\]/.exec(snapshot)?.[1] ?? "";
    expect(await read(`await ref("${ref}").evaluate(() => typeof window.n)`)).toBe("number");
  });

  test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
    "patchright's explicit isolated world still hides the page's globals",
    async () => {
      expect(
        await read("await page.evaluate(() => typeof window.n, undefined, undefined, true)"),
      ).toBe("undefined");
    },
  );
});

describe("run_script popups", () => {
  test("a popup the script's click opens that draws no frame gets a note in the script log", async () => {
    const result = await mcp.ok("run_script", {
      code: `const page = await openTab(${JSON.stringify(`${fixture().url}/popup-busy-opener`)}); const [popup] = await Promise.all([page.waitForEvent("popup"), page.click("#open-busy")]); await closeTab(popup); await closeTab(page); return "done";`,
    });
    expect(result).toMatch(
      /Note: t\d+ had not drawn a frame within 1 s after the script reached it/,
    );
  });
});

const thrownTypeError = "const ready = 1;\nthrow new TypeError('bad');";
const typeErrorFields = {
  name: "TypeError",
  message: "bad",
  stack: expect.stringMatching(/^at .*run_script\.js:2:\d+/),
};

describe("run_script errors", () => {
  test("a thrown error gives its name, message and stack in the structured error", async () => {
    const result = await mcp.call("run_script", { code: thrownTypeError });
    expect(result.structured?.error).toEqual(typeErrorFields);
  });

  test("a thrown error's text names it and the script line it was thrown on", async () => {
    expect(await failure("run_script", { code: thrownTypeError })).toMatch(
      /^TypeError: bad\n {4}at .*run_script\.js:2:\d+/,
    );
  });

  test("a thrown error's server log entry keeps its stack", async () => {
    const text = await failure("run_script", { code: thrownTypeError });
    const requestId = /\[req (\w+)\]/.exec(text)?.[1] ?? "";
    const listed = await mcp.call("logs", { source: "server", request_id: requestId });
    expect(listed.structured?.entries).toEqual([
      expect.objectContaining({ stack: expect.stringContaining("run_script.js") }),
    ]);
  });

  test("a thrown error with a number for its name fails with that name", async () => {
    const result = await mcp.call("run_script", {
      code: "const error = new Error('x'); error.name = 42; throw error;",
      timeout_ms: 3000,
    });
    expect(result.structured?.error).toMatchObject({ name: "42", message: "x" });
  });

  test("a thrown error whose stack getter throws fails with its message", async () => {
    const result = await mcp.call("run_script", {
      code: "const error = new Error('y'); Object.defineProperty(error, 'stack', { get() { throw new Error('nope'); } }); throw error;",
      timeout_ms: 3000,
    });
    expect(result.structured?.error).toStrictEqual({ name: "Error", message: "y" });
  });

  test("a thrown error whose stack is the list of frames fails with its message", async () => {
    const result = await mcp.call("run_script", {
      code: "Error.prepareStackTrace = (error, frames) => frames;\nthrow new Error('pst');",
      timeout_ms: 3000,
    });
    expect(result.structured?.error).toStrictEqual({ name: "Error", message: "pst" });
  });
});

const missingClick = "await page.click('#missing', { timeout: 500 });";
const missingError = {
  name: "Error",
  message:
    "Nothing matched #missing within 0.5 s.\nTake a snapshot to see the current page, then retry with a ref or selector from it.",
};

const missingRefClick = "await ref('e999').click({ timeout: 500 });";
const missingTab = "tab('t999');";
const missingTabText = expect.stringMatching(/^.*t999.*\n(Open tabs: |No tabs are open)/);
const messageOf = <Fields>(error: Fields) => z.object({ message: z.string() }).parse(error).message;

describe("run_script failed browser calls", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/form");
  });

  test("a failed click gives its described text as the structured error", async () => {
    const result = await mcp.call("run_script", { code: missingClick, tab: tab.id });
    expect(result.structured?.error).toStrictEqual(missingError);
  });

  test("a failed ref click's text starts with its structured error message", async () => {
    const result = await mcp.call("run_script", { code: missingRefClick, tab: tab.id });
    expect(result.text).toStartWith(messageOf(result.structured?.error));
  });

  test("a failed helper call gives its text and hint as the structured error", async () => {
    const result = await mcp.call("run_script", { code: missingTab });
    expect(result.structured?.error).toStrictEqual({ name: "Error", message: missingTabText });
  });

  test("a script error quoting a failed helper call gives the call's hint after its sentence", async () => {
    const result = await mcp.call("run_script", {
      code: "try { tab('t999'); } catch (error) { throw new Error('step 2: ' + error.message); }",
    });
    expect(result.structured?.error).toMatchObject({
      message: expect.stringMatching(/^step 2: .*t999.*\n(Open tabs: |No tabs are open)/),
    });
  });

  test("a job whose click failed gives its described text as the structured error", async () => {
    const id = await startJob({ code: missingClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toStrictEqual(missingError);
  });

  test("a job whose click failed gives its described text in the result file", async () => {
    const id = await startJob({ code: missingClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toStrictEqual({ error: missingError });
  });

  test("a job whose click failed gives its described text on the stopped line", async () => {
    const id = await startJob({ code: missingClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.text).toContain(`Stopped: ${missingError.message}`);
  });

  test("a job whose ref click failed gives the stopped line's text as the structured error", async () => {
    const id = await startJob({ code: missingRefClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.text).toContain(`Stopped: ${messageOf(waited.structured?.error)}`);
  });

  test("a job whose helper call failed gives its text and hint as the structured error", async () => {
    const id = await startJob({ code: missingTab });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toStrictEqual({ name: "Error", message: missingTabText });
  });

  test("a job whose thrown error has a number for its name fails with that name", async () => {
    const id = await startJob({
      code: "const error = new Error('x'); error.name = 42; throw error;",
    });
    const waited = await mcp.call("run_script", { job: id, wait: true, timeout_ms: 5000 });
    expect(waited.structured?.error).toMatchObject({ name: "42", message: "x" });
  });

  test("a job whose thrown error's stack is the list of frames fails with its message", async () => {
    const id = await startJob({
      code: "Error.prepareStackTrace = (error, frames) => frames;\nthrow new Error('pst');",
    });
    const waited = await mcp.call("run_script", { job: id, wait: true, timeout_ms: 5000 });
    expect(waited.structured?.error).toStrictEqual({ name: "Error", message: "pst" });
  });
});

const wrappedClick =
  "try { await page.click('#missing', { timeout: 500 }); } catch (error) { throw new Error('step 2: ' + error.message); }";
const wrappedMessage = `step 2: ${missingError.message}`;

describe("run_script errors wrapping a failed browser call", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/form");
  });

  test("the text keeps the script's words with the described call", async () => {
    const result = await mcp.call("run_script", { code: wrappedClick, tab: tab.id });
    expect(result.text).toStartWith(`Error: ${wrappedMessage}\n    at `);
  });

  test("the structured error keeps the script's words with the described call", async () => {
    const result = await mcp.call("run_script", { code: wrappedClick, tab: tab.id });
    expect(result.structured?.error).toMatchObject({ name: "Error", message: wrappedMessage });
  });

  test("a job's structured error keeps the script's words with the described call", async () => {
    const id = await startJob({ code: wrappedClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toMatchObject({ name: "Error", message: wrappedMessage });
  });

  test("a job's result file keeps the script's words with the described call", async () => {
    const id = await startJob({ code: wrappedClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      error: { name: "Error", message: wrappedMessage },
    });
  });

  test("a job's stopped line keeps the script's words with the described call", async () => {
    const id = await startJob({ code: wrappedClick, tab: tab.id });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.text).toContain(`Stopped: Error: ${wrappedMessage}`);
  });
});

describe("run_script thrown values that are not errors", () => {
  test("a thrown plain object gives its message", async () => {
    const result = await mcp.call("run_script", {
      code: "throw { message: 'login failed', code: 7 };",
    });
    expect(result.structured?.error).toStrictEqual({ name: "Error", message: "login failed" });
  });

  test("a job's thrown plain object gives its message in the result file", async () => {
    const id = await startJob({ code: "throw { message: 'login failed', code: 7 };" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toStrictEqual({
      error: { name: "Error", message: "login failed" },
    });
  });

  test("a script error named ToolError keeps its name", async () => {
    const result = await mcp.call("run_script", {
      code: "const error = new Error('x'); error.name = 'ToolError'; error.hint = 'fake hint'; throw error;",
    });
    expect(result.structured?.error).toMatchObject({ name: "ToolError", message: "x" });
  });

  test("the script's own aborted signal reason keeps its name", async () => {
    const result = await mcp.call("run_script", {
      code: "const controller = new AbortController(); controller.abort(); throw controller.signal.reason;",
    });
    expect(result.structured?.error).toMatchObject({ name: "AbortError" });
  });
});

const rows = Array.from({ length: 200 }, (_, index) => `row ${index}`).join("\n");
const rowsCode = `return ${JSON.stringify(rows)};`;
const rowsChars = rows.length;

async function startJob(args: ToolArgs) {
  const started = await mcp.ok("run_script", { ...args, background: true });
  return /job (j\d+)/.exec(started)?.[1] ?? "";
}

const cancel = (id: string) => mcp.ok("run_script", { job: id, cancel: true });

describe("run_script jobs on one tab", () => {
  const blocking = "await sleep(20000);";

  async function behindBlocker() {
    const tab = await openTab("/");
    const first = await startJob({ code: blocking, tab: tab.id });
    const second = await mcp.call("run_script", {
      tab: tab.id,
      code: "return 1;",
      background: true,
    });
    const id = /job (j\d+)/.exec(second.text)?.[1] ?? "";
    return { tab, first, second, id };
  }

  test("a job started after another job on the same tab starts once that job ends", async () => {
    const tab = await openTab("/");
    const first = await startJob({ code: "await sleep(3000); return Date.now();", tab: tab.id });
    const second = await startJob({
      code: "const started = Date.now(); await sleep(500); return started;",
      tab: tab.id,
    });
    const waited = await mcp.call("run_script", { job: second, wait: true });
    const ended = await mcp.call("run_script", { job: first });
    expect(Number(waited.structured?.value)).toBeGreaterThanOrEqual(
      Number(ended.structured?.value),
    );
  });

  test("a job started on a tab where another job runs is queued", async () => {
    const { first, second } = await behindBlocker();
    await cancel(first);
    expect(second.structured?.state).toBe("queued");
  });

  test("a queued job's start reply names the job it waits behind as a field", async () => {
    const { first, second } = await behindBlocker();
    await cancel(first);
    expect(second.structured?.queuedBehind).toBe(first);
  });

  test("a queued job's start reply says when it starts and how to run in parallel", async () => {
    const { tab, first, second, id } = await behindBlocker();
    await cancel(first);
    expect(second.text).toContain(
      `Queued background job ${id} behind ${first} on ${tab.id}; it starts when ${first} ends. To run in parallel, use another tab or combine the work in one script.`,
    );
  });

  test("a job started on another tab runs at once", async () => {
    const tab = await openTab("/");
    const other = await openTab("/");
    const first = await startJob({ code: blocking, tab: tab.id });
    const second = await mcp.call("run_script", {
      tab: other.id,
      code: blocking,
      background: true,
    });
    await cancel(first);
    await cancel(/job (j\d+)/.exec(second.text)?.[1] ?? "");
    expect(second.structured?.state).toBe("running");
  });

  test("the status of a queued job names the job it waits behind", async () => {
    const { first, id } = await behindBlocker();
    const status = await mcp.call("run_script", { job: id });
    await cancel(first);
    expect(status.structured?.queuedBehind).toBe(first);
  });

  test("the job list gives the job a queued job waits behind as a structured field", async () => {
    const { first, id } = await behindBlocker();
    const list = await mcp.call("run_script", {});
    await cancel(first);
    expect(list.structured?.jobs).toContainEqual(
      expect.objectContaining({ id, state: "queued", queuedBehind: first }),
    );
  });

  test("the job list shows a queued job behind the job it waits for", async () => {
    const { first, id } = await behindBlocker();
    const list = await mcp.ok("run_script", {});
    await cancel(first);
    expect(list).toMatch(new RegExp(`^${id} queued behind ${first} `, "m"));
  });

  test("cancelling a queued job ends it as cancelled", async () => {
    const { first, id } = await behindBlocker();
    const cancelled = await mcp.call("run_script", { job: id, cancel: true });
    await cancel(first);
    expect(cancelled.structured?.state).toBe("cancelled");
  });

  test("a queued job starts when the job ahead of it is cancelled", async () => {
    const { first, id } = await behindBlocker();
    await cancel(first);
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.state).toBe("done");
  });

  test("wait that reaches timeout_ms while the job is queued says it is still queued", async () => {
    const { first, id } = await behindBlocker();
    const waited = await mcp.ok("run_script", { job: id, wait: true, timeout_ms: 1000 });
    await cancel(first);
    expect(waited).toContain(`Still queued behind ${first} after waiting 1000 ms.`);
  });

  test("a queued job whose tab is closed fails with the reason", async () => {
    const tab = await openTab("/");
    const first = await startJob({ code: "await sleep(1500);", tab: tab.id });
    const second = await startJob({ code: "return 1;", tab: tab.id });
    await mcp.ok("tabs", { close: [tab.id] });
    await mcp.ok("run_script", { job: first, wait: true });
    const waited = await mcp.call("run_script", { job: second, wait: true });
    expect(waited.text).toContain(
      `Stopped: Tab ${tab.id} was closed before job ${second} started.`,
    );
  });
});

describe("run_script jobs", () => {
  let jobId: string;

  beforeAll(async () => {
    const started = await mcp.ok("run_script", {
      code: "log('working'); await new Promise((resolve) => setTimeout(resolve, 300)); return 42;",
      background: true,
      label: "short job",
    });
    jobId = /job (j\d+)/.exec(started)?.[1] ?? "";
    expect(started).toMatch(/run_script with job j\d+/);
  });

  test("the list shows the job with its label", async () => {
    expect(await mcp.ok("run_script", {})).toMatch(
      new RegExp(`${jobId} \\w+ \\d+s \\d+ log lines — short job`),
    );
  });

  test("the list gives the job with its label as a structured field", async () => {
    const list = await mcp.call("run_script", {});
    expect(list.structured?.jobs).toContainEqual(
      expect.objectContaining({ id: jobId, label: "short job" }),
    );
  });

  test("the list gives a job's state as a structured field", async () => {
    const id = await startJob({ code: "await sleep(20000);" });
    const list = await mcp.call("run_script", {});
    await cancel(id);
    expect(list.structured?.jobs).toContainEqual(expect.objectContaining({ id, state: "running" }));
  });

  test("the list gives a job's tab as a structured field", async () => {
    const tab = await openTab("/");
    const id = await startJob({ code: "await sleep(20000);", tab: tab.id });
    const list = await mcp.call("run_script", {});
    await cancel(id);
    expect(list.structured?.jobs).toContainEqual(expect.objectContaining({ id, tab: tab.id }));
  });

  test("a finished job reports its state and result file", async () => {
    await sleep(1500);
    const status = await mcp.ok("run_script", { job: jobId });
    expect(status).toMatch(new RegExp(`${jobId} done`));
    const file = /Result: (\S+)/.exec(status)?.[1] ?? "";
    expect(await readFile(file, "utf8")).toContain("42");
  });

  test("a running job is cancelled with job and cancel", async () => {
    const started = await mcp.ok("run_script", {
      code: "await new Promise(() => undefined);",
      background: true,
    });
    const id = /job (j\d+)/.exec(started)?.[1] ?? "";
    expect(await mcp.ok("run_script", { job: id, cancel: true })).toMatch(
      new RegExp(`${id} cancelled`),
    );
  });

  test("an unknown job names run_script to list the known ones", async () => {
    expect(await failure("run_script", { job: "j999" })).toMatch(/No job j999\.[\s\S]*run_script/);
  });

  test("code together with job is rejected", async () => {
    expect(await failure("run_script", { code: "return 1", job: jobId })).toMatch(/code .*job/);
  });

  test("cancel without job is rejected", async () => {
    expect(await failure("run_script", { cancel: true })).toMatch(/cancel needs job/);
  });

  test("cancel together with code is rejected", async () => {
    expect(await failure("run_script", { code: "return 1", cancel: true })).toMatch(
      /cancel needs job/,
    );
  });

  for (const [name, value] of [
    ["tab", "t1"],
    ["timeout_ms", 5000],
    ["background", true],
    ["label", "x"],
  ] as const) {
    test(`${name} without code is rejected`, async () => {
      expect(await failure("run_script", { job: jobId, [name]: value })).toMatch(
        new RegExp(`${name} needs code`),
      );
    });
  }

  test("wait returns the job's final state once it ends", async () => {
    const id = await startJob({ code: "await sleep(800); return 42;" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.state).toBe("done");
  });

  test("wait returns a finished job's returned value inline", async () => {
    const id = await startJob({ code: "await sleep(300); return { answer: 42 };" });
    expect(await mcp.ok("run_script", { job: id, wait: true })).toMatch(
      /Returned: \{"answer":42\}/,
    );
  });

  test("wait returns a finished job's returned value as a structured field", async () => {
    const id = await startJob({ code: "await sleep(300); return { answer: 42 };" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.value).toStrictEqual({ answer: 42 });
  });

  test("a finished job's structured text says what kind of value it returned", async () => {
    const id = await startJob({ code: "return { answer: 42 };" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.text).toContain("\nReturned an object of 1 key.");
  });

  test("a script run in the foreground returns its value as a structured field", async () => {
    const result = await mcp.call("run_script", { code: "return [1, 'two'];" });
    expect(result.structured?.value).toStrictEqual([1, "two"]);
  });

  test("a script run in the foreground keeps its value in the text", async () => {
    const result = await mcp.call("run_script", { code: "return [1, 'two'];" });
    expect(result.text).toMatch(/^Returned: \[1,"two"\]/);
  });

  test("a script whose logs go over max_chars still returns its value as a structured field", async () => {
    const result = await mcp.call("run_script", {
      code: "for (let i = 0; i < 50; i++) log('line ' + i + ' ' + 'y'.repeat(40)); return { small: 1 };",
      max_chars: 500,
    });
    expect(result.structured?.value).toStrictEqual({ small: 1 });
  });

  test("a script whose logs go over max_chars names the file holding the full logs", async () => {
    const result = await mcp.call("run_script", {
      code: "for (let i = 0; i < 50; i++) log('line ' + i + ' ' + 'y'.repeat(40)); return { small: 1 };",
      max_chars: 500,
    });
    const file = String(result.structured?.file);
    expect(await readFile(file, "utf8")).toContain("line 49 ");
  });

  test("a script whose logs go over max_chars keeps a preview of the first log lines in the logs field", async () => {
    const result = await mcp.call("run_script", {
      code: "for (let i = 0; i < 50; i++) log('line ' + i + ' ' + 'y'.repeat(40)); return { small: 1 };",
      max_chars: 500,
    });
    expect(result.structured?.logs).toContainEqual(expect.stringMatching(/^line 0 y+$/));
  });

  test("a script whose logs go over max_chars keeps a preview of the last log lines in the logs field", async () => {
    const result = await mcp.call("run_script", {
      code: "for (let i = 0; i < 50; i++) log('line ' + i + ' ' + 'y'.repeat(40)); return { small: 1 };",
      max_chars: 500,
    });
    expect(result.structured?.logs).toContainEqual(expect.stringMatching(/^line 49 y+$/));
  });

  test("a script whose logs go over max_chars marks them as clipped with their full size", async () => {
    const result = await mcp.call("run_script", {
      code: "for (let i = 0; i < 50; i++) log('line ' + i + ' ' + 'y'.repeat(40)); return { small: 1 };",
      max_chars: 500,
    });
    const file = String(result.structured?.file);
    expect([result.structured?.clipped, result.structured?.totalChars]).toStrictEqual([
      true,
      (await readFile(file, "utf8")).length,
    ]);
  });

  test("a script whose logs fit max_chars is not marked as clipped", async () => {
    const result = await mcp.call("run_script", {
      code: "log('one line'); return 1;",
      max_chars: 500,
    });
    expect(result.structured?.clipped).toBeUndefined();
  });

  test("a script whose value goes over max_chars names the file holding the value", async () => {
    const result = await mcp.call("run_script", {
      code: "return 'v'.repeat(2000) + 'end';",
      max_chars: 500,
    });
    const file = String(result.structured?.file);
    expect(await readFile(file, "utf8")).toContain("vend");
  });

  test("a script whose value goes over max_chars keeps a preview of it in the value field", async () => {
    const result = await mcp.call("run_script", {
      code: "return 'v'.repeat(2000) + 'end';",
      max_chars: 500,
    });
    expect(String(result.structured?.value)).toMatch(/^v+… \[\d+ chars omitted\] …\nv*end$/);
  });

  test("a script whose value fills max_chars exactly is not marked as clipped", async () => {
    const result = await mcp.call("run_script", {
      code: "return 'v'.repeat(500);",
      max_chars: 500,
    });
    expect(result.structured?.clipped).toBeUndefined();
  });

  test("a script whose value goes over max_chars marks it as clipped", async () => {
    const result = await mcp.call("run_script", {
      code: "return 'v'.repeat(2000) + 'end';",
      max_chars: 500,
    });
    expect([result.structured?.clipped, result.structured?.totalChars]).toStrictEqual([true, 2003]);
  });

  test("a script's structured text says what kind of value it returned", async () => {
    const result = await mcp.call("run_script", { code: "return [1, 'two'];" });
    expect(result.structured?.text).toBe("Returned a list of 2 items.");
  });

  test("a job whose value goes over max_chars keeps a preview of it in the value field", async () => {
    const id = await startJob({ code: "return 'w'.repeat(2000) + 'end';" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 500 });
    expect(String(waited.structured?.value)).toMatch(/^w+… \[\d+ chars omitted\] …\nw*end$/);
  });

  test("a job whose value goes over max_chars gives its result file in the file field", async () => {
    const id = await startJob({ code: "return 'w'.repeat(2000) + 'end';" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 500 });
    expect(waited.structured?.file).toBe(waited.structured?.resultFile);
  });

  test("a job's structured text says its clipped value is a preview with the whole in file", async () => {
    const id = await startJob({ code: "return 'w'.repeat(2000) + 'end';" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 500 });
    expect(String(waited.structured?.text)).toMatch(
      /\nReturned a string of 2003 chars, 2003 chars as text; a preview in value, all in file\.(\n|$)/,
    );
  });

  test("wait that reaches timeout_ms first returns the job as still running", async () => {
    const id = await startJob({ code: "await sleep(20000);" });
    const waited = await mcp.call("run_script", { job: id, wait: true, timeout_ms: 1000 });
    await mcp.ok("run_script", { job: id, cancel: true });
    expect(waited.structured?.state).toBe("running");
  });

  test("wait without job is rejected", async () => {
    expect(await failure("run_script", { wait: true })).toMatch(/wait needs job/);
  });

  test("a job's status reports its elapsed time in milliseconds", async () => {
    const id = await startJob({ code: "await sleep(300); return 1;" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.elapsedMs).toBeGreaterThanOrEqual(300);
  });

  test("a failed job's status has the failed state", async () => {
    const id = await startJob({ code: "throw new Error('broken on purpose');" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.state).toBe("failed");
  });

  test("a large returned value is clipped with a preview that names the full result file", async () => {
    const id = await startJob({ code: "return 'x'.repeat(30000);" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.text).toContain(
      `[truncated: 30000 chars total. Full output saved to ${String(waited.structured?.resultFile)}.]`,
    );
  });

  test("a long one-line returned value shows the start of its content in the preview", async () => {
    const id = await startJob({ code: "return { big: 'y'.repeat(30000) };" });
    expect(await mcp.ok("run_script", { job: id, wait: true })).toMatch(
      /Returned: \{"big":"y{1000}/,
    );
  });

  test("max_chars without code or job is rejected", async () => {
    expect(await failure("run_script", { max_chars: 500 })).toMatch(/max_chars needs code or job/);
  });

  test("wait on a job clips its value to max_chars with a preview that names the result file", async () => {
    const id = await startJob({ code: "return 'v'.repeat(2000) + 'end';" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 500 });
    expect(waited.text).toContain(
      `[truncated: 2003 chars total. Full output saved to ${String(waited.structured?.resultFile)}.]`,
    );
  });

  test("the status of a job clips its value to max_chars", async () => {
    const id = await startJob({ code: "return 'v'.repeat(2000) + 'end';" });
    await mcp.call("run_script", { job: id, wait: true });
    expect(await mcp.ok("run_script", { job: id, max_chars: 500 })).toContain(
      "[truncated: 2003 chars total.",
    );
  });

  test("a job value over 10000 chars is clipped to the 10000 chars the job keeps for a larger max_chars", async () => {
    const id = await startJob({ code: "return 'v'.repeat(30000);" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 50_000 });
    expect(waited.text).toContain(
      `[truncated: 30000 chars total. Full output saved to ${String(waited.structured?.resultFile)}.]`,
    );
  });

  test("max_chars given at the start of a job clips the value a later wait returns", async () => {
    const id = await startJob({ code: rowsCode, max_chars: 500 });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.text).toContain(
      `[truncated: ${rowsChars} chars total. Full output saved to ${String(waited.structured?.resultFile)}.]`,
    );
  });

  test("max_chars given at the start of a job clips a later wait's structured value", async () => {
    const id = await startJob({ code: rowsCode, max_chars: 500 });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.clipped).toBe(true);
  });

  test("max_chars given at the start of a job clips the value a later status returns", async () => {
    const id = await startJob({ code: rowsCode, max_chars: 500 });
    await mcp.call("run_script", { job: id, wait: true });
    expect(await mcp.ok("run_script", { job: id })).toContain(
      `[truncated: ${rowsChars} chars total.`,
    );
  });

  test("max_chars on a wait overrides the one given at the start of the job", async () => {
    const id = await startJob({ code: rowsCode, max_chars: 500 });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 5000 });
    expect(waited.text).not.toContain("[truncated:");
  });

  test("a job value clipped to max_chars gives its full size in the structured result", async () => {
    const id = await startJob({ code: "return 'v'.repeat(2000) + 'end';" });
    const waited = await mcp.call("run_script", { job: id, wait: true, max_chars: 500 });
    expect(waited.structured?.totalChars).toBe(2003);
  });

  test("a failed job carries its error in a structured error field", async () => {
    const id = await startJob({ code: "throw new Error('broken on purpose');" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toMatchObject({ message: "broken on purpose" });
  });

  test("wait on a failed job gives the error's name, message and stack", async () => {
    const id = await startJob({ code: thrownTypeError });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toEqual(typeErrorFields);
  });

  test("the status of a failed job gives the error's name, message and stack", async () => {
    const id = await startJob({ code: thrownTypeError });
    await mcp.call("run_script", { job: id, wait: true });
    const status = await mcp.call("run_script", { job: id });
    expect(status.structured?.error).toEqual(typeErrorFields);
  });

  test("a failed job's result file holds the error's name, message and stack", async () => {
    const id = await startJob({ code: thrownTypeError });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ error: typeErrorFields });
  });

  test("a job that logged before failing keeps the error's name", async () => {
    const id = await startJob({ code: `log("first");\n${thrownTypeError}` });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.error).toMatchObject({ name: "TypeError" });
  });

  test("a finished job's result file holds its value as JSON", async () => {
    const id = await startJob({ code: "return 'plain text';" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ value: "plain text" });
  });

  test("a failed job's result file holds its error as JSON", async () => {
    const id = await startJob({ code: "throw new Error('broken on purpose');" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8")).error).toMatchObject({
      message: "broken on purpose",
    });
  });

  test("a job that returns undefined says so in its structured result", async () => {
    const id = await startJob({ code: "return undefined;" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    expect(waited.structured?.undefined).toBe(true);
  });

  test("a job that returns undefined says so in its result file", async () => {
    const id = await startJob({ code: "return undefined;" });
    const waited = await mcp.call("run_script", { job: id, wait: true });
    const file = String(waited.structured?.resultFile);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ undefined: true });
  });

  test("a script run in the foreground that returns undefined says so in its structured result", async () => {
    const result = await mcp.call("run_script", { code: "return undefined;" });
    expect(result.structured?.undefined).toBe(true);
  });

  test("evaluate of an expression that is undefined says so in its structured result", async () => {
    const tab = await openTab("/");
    const result = await mcp.call("evaluate", { tab: tab.id, expression: "undefined" });
    expect(result.structured?.undefined).toBe(true);
  });

  test("a script without a job still runs and returns its value", async () => {
    expect(await mcp.ok("run_script", { code: "return 1 + 1;" })).toMatch(/Returned: 2/);
  });
});

const inFrame = (expression: string) =>
  `const frame = document.createElement("iframe"); document.body.append(frame); return ${expression};`;

const returned = async (code: string) => (await mcp.call("run_script", { code })).structured?.value;

const jobValue = async (code: string) => {
  const job = await startJob({ code });
  return (await mcp.call("run_script", { job, wait: true })).structured?.value;
};

const replacedPage = async (setup: string) => {
  const replaced = await openTab("/");
  await mcp.ok("evaluate", { tab: replaced.id, expression: `${setup}; 0` });
  return (code: string) => mcp.call("evaluate", { tab: replaced.id, expression: code });
};

const pageReplaced = async (setup: string) => {
  const evaluateOn = await replacedPage(setup);
  return async (code: string) => (await evaluateOn(code)).structured?.value;
};

const REPLACED_BUILT_INS = [
  'window.saved = { map: new Map([["k", 1]]), list: [1] }',
  "const NativeMap = Map, NativeSet = Set",
  'const fail = () => { throw new Error("replaced"); }',
  "window.Map = function Map() { fail(); }",
  "window.Map.prototype = NativeMap.prototype",
  "window.Set = function Set() { fail(); }",
  "window.Set.prototype = NativeSet.prototype",
  "Reflect.apply = fail",
  "Object.keys = fail",
  "Array.isArray = fail",
].join("; ");

const OWN_KEYS_REPLACED =
  'Reflect.ownKeys = Object.getOwnPropertyNames = () => { throw new Error("replaced"); }';

describe("values across evaluate, run_script and jobs", () => {
  let tab: Tab;

  beforeAll(async () => {
    tab = await openTab("/");
  });

  const evaluated = async (code: string) =>
    (await mcp.call("evaluate", { tab: tab.id, expression: code, max_chars: 200_000 })).structured
      ?.value;

  for (const { name, code, value } of VALUE_CASES) {
    test(`evaluate: ${name}`, async () => {
      expect(await evaluated(code)).toEqual(value);
    });

    test(`run_script: ${name}`, async () => {
      expect(await returned(code)).toEqual(value);
    });

    test(`run_script job: ${name}`, async () => {
      expect(await jobValue(code)).toEqual(value);
    });
  }

  test("evaluate: a Map from an iframe becomes the list of its entries", async () => {
    expect(
      await evaluated(
        'const frame = document.createElement("iframe"); document.body.append(frame); return new frame.contentWindow.Map([["k", 1]]);',
      ),
    ).toEqual([["k", 1]]);
  });

  test("evaluate: an Error from an iframe keeps its name and message", async () => {
    expect(
      await evaluated(
        'const frame = document.createElement("iframe"); document.body.append(frame); const error = new frame.contentWindow.RangeError("far"); error.stack = ""; return error;',
      ),
    ).toEqual({ name: "RangeError", message: "far" });
  });

  test("evaluate: a page element is named as a node reference", async () => {
    expect(await evaluated("document.body")).toBe("ref: <Node>");
  });

  test("evaluate: an element of an iframe is named as a node reference", async () => {
    expect(await evaluated(inFrame("frame.contentDocument.body"))).toBe("ref: <Node>");
  });

  test("evaluate: the document of an iframe is named as a document reference", async () => {
    expect(await evaluated(inFrame("frame.contentDocument"))).toBe("ref: <Document>");
  });

  test("evaluate: the window of an iframe is named as a window reference", async () => {
    expect(await evaluated(inFrame("frame.contentWindow"))).toBe("ref: <Window>");
  });

  test("evaluate: a DOMException keeps its name and message like an Error", async () => {
    expect(await evaluated('new DOMException("aborted", "AbortError")')).toMatchObject({
      name: "AbortError",
      message: "aborted",
    });
  });

  test("evaluate: a DOMException from an iframe keeps its name and message", async () => {
    expect(
      await evaluated(inFrame('new frame.contentWindow.DOMException("far", "TimeoutError")')),
    ).toMatchObject({ name: "TimeoutError", message: "far" });
  });

  const abortReason =
    "const controller = new AbortController(); controller.abort(); return controller.signal.reason;";

  test("run_script: a DOMException keeps its name like an Error", async () => {
    expect(await returned(abortReason)).toMatchObject({ name: "AbortError" });
  });

  test("run_script job: a DOMException keeps its name like an Error", async () => {
    expect(await jobValue(abortReason)).toMatchObject({ name: "AbortError" });
  });

  const revoked =
    "const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return { broken: proxy };";
  const revokedValue = { broken: expect.stringMatching(/^\[Unconvertible: TypeError: .+\]$/) };

  test("evaluate: a revoked Proxy is marked as unconvertible", async () => {
    expect(await evaluated(revoked)).toEqual(revokedValue);
  });

  test("run_script: a revoked Proxy is marked as unconvertible", async () => {
    expect(await returned(revoked)).toEqual(revokedValue);
  });

  test("run_script job: a revoked Proxy is marked as unconvertible", async () => {
    expect(await jobValue(revoked)).toEqual(revokedValue);
  });

  test("evaluate: built-ins the page replaces during the conversion leave the rest converted", async () => {
    const fresh = await openTab("/");
    const result = await mcp.call("evaluate", {
      tab: fresh.id,
      expression:
        '({ first: { get value() { Map.prototype.entries = () => { throw new Error("replaced"); }; Set.prototype.values = Map.prototype.entries; return 1; } }, map: new Map([["k", 1]]), set: new Set([2]) })',
    });
    expect(result.structured?.value).toEqual({ first: { value: 1 }, map: [["k", 1]], set: [2] });
  });

  test("evaluate: page code that reads the stack during the conversion sees no named frames", async () => {
    const { probe: stack } = z
      .object({ probe: z.string() })
      .parse(await evaluated("({ get probe() { return new Error().stack; } })"));
    const frames = stack
      .split("\n")
      .slice(2)
      .map((line) => line.trim());
    expect(frames.filter((line) => !/^at (?:[\w$]+\.)?<anonymous>[ :]/.test(line))).toEqual([]);
  });

  test("evaluate: a number arrives from a page that replaced Map, Set, Reflect.apply, Object.keys and Array.isArray", async () => {
    const replaced = await pageReplaced(REPLACED_BUILT_INS);
    expect(await replaced("1")).toBe(1);
  });

  test("evaluate: a plain object arrives from a page that replaced Map, Set, Reflect.apply, Object.keys and Array.isArray", async () => {
    const replaced = await pageReplaced(REPLACED_BUILT_INS);
    expect(await replaced("({ a: 1 })")).toEqual({ a: 1 });
  });

  test("evaluate: a Map and a list convert on a page that replaced Map, Set, Reflect.apply, Object.keys and Array.isArray", async () => {
    const replaced = await pageReplaced(REPLACED_BUILT_INS);
    expect(await replaced("saved")).toEqual({ map: [["k", 1]], list: [1] });
  });

  test("evaluate: a number arrives from a page whose Map throws when called", async () => {
    const replaced = await pageReplaced(
      'window.Map = function () { throw new Error("polyfill"); }',
    );
    expect(await replaced("1")).toBe(1);
  });

  test("evaluate: a plain object arrives from a page that replaced a built-in the conversion needs", async () => {
    const replaced = await pageReplaced('Reflect.ownKeys = () => { throw new Error("replaced"); }');
    expect(await replaced("({ a: 1 })")).toEqual({ a: 1 });
  });

  test("evaluate: built-ins the page wraps see no calls from the conversion", async () => {
    const replaced = await pageReplaced(
      [
        'window.saved = new Map([["k", 1]])',
        "window.calls = {}",
        "const forward = Reflect.apply, build = Reflect.construct, Wrap = Proxy",
        "const count = (name) => { window.calls[name] = (window.calls[name] ?? 0) + 1; }",
        "const wrap = (owner, key) => { owner[key] = new Wrap(owner[key], { apply: (target, self, args) => { count(key); return forward(target, self, args); }, construct: (target, args, next) => { count(key); return build(target, args, next); } }); }",
        'wrap(window, "Map"); wrap(window, "Set"); wrap(Reflect, "apply"); wrap(Object, "keys"); wrap(Array, "isArray")',
      ].join("; "),
    );
    await replaced("1");
    await replaced("({ a: 1 })");
    await replaced("saved");
    expect(await replaced("JSON.stringify(window.calls)")).toBe("{}");
  });

  test("evaluate: a Map converts on a page that wrapped Function.prototype.call", async () => {
    const replaced = await pageReplaced(
      "Function.prototype.call = new Proxy(Function.prototype.call, {})",
    );
    expect(await replaced("new Map([[1, 2]])")).toEqual([[1, 2]]);
  });

  test("evaluate: an Error keeps its name and message on a page that replaced String.prototype.trim", async () => {
    const replaced = await pageReplaced('String.prototype.trim = function trim() { return ""; }');
    expect(await replaced('[new Error("e")]')).toMatchObject([{ name: "Error", message: "e" }]);
  });

  test("evaluate: accessors the page puts on built-ins are not called by the conversion", async () => {
    const replaced = await pageReplaced(
      [
        "window.calls = 0",
        'Object.defineProperty(Error, "isError", { get() { window.calls += 1; return undefined; }, configurable: true })',
        'Object.defineProperty(String.prototype, "trim", { get() { window.calls += 1; return () => ""; }, configurable: true })',
      ].join("; "),
    );
    await replaced("({ a: 1 })");
    expect(await replaced("window.calls")).toBe(0);
  });

  test("evaluate: a Map converts on a page that put Set's has on Map", async () => {
    const replaced = await pageReplaced("Map.prototype.has = Set.prototype.has");
    expect(await replaced("new Map([[1, 2]])")).toEqual([[1, 2]]);
  });

  test("evaluate: a WeakMap is an empty object on a page that put WeakMap's has on Map", async () => {
    const replaced = await pageReplaced("Map.prototype.has = WeakMap.prototype.has");
    expect(await replaced("new WeakMap()")).toEqual({});
  });

  test("evaluate names a built-in the page replaced with a web API method of the same name", async () => {
    const evaluateOn = await replacedPage("Set.prototype.forEach = Headers.prototype.forEach");
    expect((await evaluateOn("new Set([1])")).structured?.replacedBuiltins).toEqual([
      "Set.prototype.forEach",
    ]);
  });

  test("evaluate: a toJSON the page added to Object.prototype does not replace every object", async () => {
    const replaced = await pageReplaced('Object.prototype.toJSON = function () { return "J"; }');
    expect(await replaced("({ a: 1, list: [{ b: 2 }] })")).toEqual({ a: 1, list: [{ b: 2 }] });
  });

  test("evaluate: a toJSON on the page's own prototype without a prototype of its own is what toJSON returns", async () => {
    const replaced = await pageReplaced(
      'window.base = Object.create(null); window.base.toJSON = () => "custom"',
    );
    expect(await replaced("Object.assign(Object.create(window.base), { a: 1 })")).toBe("custom");
  });

  test("evaluate: a toJSON the page added to Object.prototype does not replace every object on a page that replaced Function.prototype.toString", async () => {
    const replaced = await pageReplaced(
      'Function.prototype.toString = function toString() { return "x"; }; Object.prototype.toJSON = function () { return "J"; }',
    );
    expect(await replaced("({ a: 1 })")).toEqual({ a: 1 });
  });

  test("evaluate names no replaced built-in on a page that only replaced Function.prototype.toString", async () => {
    const evaluateOn = await replacedPage(
      'Function.prototype.toString = function toString() { return "x"; }',
    );
    expect((await evaluateOn("({ a: 1 })")).structured?.replacedBuiltins).toBeUndefined();
  });

  test("evaluate says a built-in prototype's toJSON could not be checked on a page that wrapped Function.prototype.toString", async () => {
    const evaluateOn = await replacedPage(
      'const pristine = Function.prototype.toString; Function.prototype.toString = function toString() { return pristine.call(this); }; Array.prototype.toJSON = () => "J"',
    );
    expect(
      (await evaluateOn("Object.assign(Object.create(Array.prototype), { a: 1 })")).text,
    ).toContain(
      "Note: the page replaced Function.prototype.toString, so it could not be checked whether a toJSON the value inherits was added by the page to a built-in prototype; it was applied.",
    );
  });

  test("evaluate adds no toJSON note for a value without one on a page that wrapped Function.prototype.toString", async () => {
    const evaluateOn = await replacedPage(
      "const pristine = Function.prototype.toString; Function.prototype.toString = function toString() { return pristine.call(this); }",
    );
    expect((await evaluateOn("({ a: 1 })")).text).toEndWith('\n{"a":1}');
  });

  test("evaluate: a built-in toJSON of a web API object is what toJSON returns", async () => {
    const replaced = await pageReplaced("0");
    expect(await replaced('new URL("https://shop.example/cart")')).toBe(
      "https://shop.example/cart",
    );
  });

  test("evaluate: a Set is an empty object on a page that put Headers' forEach on Set", async () => {
    const replaced = await pageReplaced("Set.prototype.forEach = Headers.prototype.forEach");
    expect(await replaced("new Set([1])")).toEqual({});
  });

  test("evaluate: a Map converts on a page that wrapped Map in a Proxy", async () => {
    const replaced = await pageReplaced(
      "window.saved = new Map([[1, 2]]); window.Map = new Proxy(Map, {})",
    );
    expect(await replaced("saved")).toEqual([[1, 2]]);
  });

  test("evaluate: a Map converts with the forEach the page replaced after an earlier object result", async () => {
    const replaced = await pageReplaced("window.saved = new Map([[1, 2]])");
    await replaced("({ a: 1 })");
    await replaced("Map.prototype.forEach = function forEach() {}; 0");
    expect(await replaced("saved")).toEqual([[1, 2]]);
  });

  test("evaluate: an object converts after the tab moved to another page", async () => {
    const moved = await openTab("/");
    await mcp.ok("evaluate", { tab: moved.id, expression: "({ a: 1 })" });
    await moved.page.goto(`${fixture().url}/article`);
    const result = await mcp.call("evaluate", { tab: moved.id, expression: "({ b: 2 })" });
    expect(result.structured?.value).toEqual({ b: 2 });
  });

  test("evaluate: an object converts after the tab went back to a page it showed before", async () => {
    const moved = await openTab("/");
    await mcp.ok("evaluate", { tab: moved.id, expression: "({ a: 1 })" });
    await moved.page.goto(`${fixture().url}/article`);
    await mcp.ok("evaluate", { tab: moved.id, expression: "({ a: 1 })" });
    await moved.page.goBack({ waitUntil: "commit" });
    const result = await mcp.call("evaluate", { tab: moved.id, expression: "({ c: 3 })" });
    expect(result.structured?.value).toEqual({ c: 3 });
  });

  test("evaluate: a Map is an empty object after the page reloaded and replaced forEach", async () => {
    const moved = await openTab("/");
    await mcp.ok("evaluate", { tab: moved.id, expression: "({ a: 1 })" });
    await moved.page.reload();
    const result = await mcp.call("evaluate", {
      tab: moved.id,
      expression: "Map.prototype.forEach = function forEach() {}; return new Map([[1, 2]]);",
    });
    expect(result.structured?.value).toEqual({});
  });

  test("evaluate names the built-in a page replaced in a structured field", async () => {
    const replaced = await openTab("/");
    const result = await mcp.call("evaluate", {
      tab: replaced.id,
      expression: "Map.prototype.forEach = function forEach() {}; return new Map([[1, 2]]);",
    });
    expect(result.structured?.replacedBuiltins).toEqual(["Map.prototype.forEach"]);
  });

  test("evaluate says which built-in the page replaced when a value may arrive unconverted", async () => {
    const replaced = await openTab("/");
    const result = await mcp.call("evaluate", {
      tab: replaced.id,
      expression: "Map.prototype.forEach = function forEach() {}; return new Map([[1, 2]]);",
    });
    expect(result.text).toContain(
      "Note: the page replaced Map.prototype.forEach, so values that need it may arrive as plain JSON instead of in the forms the tool describes.",
    );
  });

  test("evaluate says the value is plain JSON when the page replaced a built-in the conversion needs", async () => {
    const evaluateOn = await replacedPage(OWN_KEYS_REPLACED);
    expect((await evaluateOn("({ a: 1 })")).text).toContain(
      "Note: the page replaced Reflect.ownKeys and Object.getOwnPropertyNames, which the conversion needs, so the value is plain JSON: a Map, Set, Error, NaN or the like is not in the forms the tool describes.",
    );
  });

  test("evaluate: a value nested too deep on a page that replaced a built-in the conversion needs fails with a plain sentence", async () => {
    const evaluateOn = await replacedPage(OWN_KEYS_REPLACED);
    const result = await evaluateOn(
      "let chain = {}; for (let i = 0; i < 100000; i += 1) chain = { next: chain }; return chain;",
    );
    expect(result.text).toMatch(
      /^The value is nested too deeply to return as plain JSON, and the page replaced built-ins the conversion needs to mark the deep part\.\nReturn a smaller part of it\. \[req \w+\]$/,
    );
  });

  test("evaluate: a clean page names no replaced built-ins", async () => {
    const result = await mcp.call("evaluate", { tab: tab.id, expression: "new Map([[1, 2]])" });
    expect(result.structured?.replacedBuiltins).toBeUndefined();
  });

  test("evaluate: a thrown undefined is reported as undefined", async () => {
    const result = await mcp.call("evaluate", { tab: tab.id, expression: "throw undefined" });
    expect(result.text).toMatch(/^undefined \[req \w+\]$/);
  });

  test("run_script: a returned element handle is named as a node reference", async () => {
    const result = await mcp.call("run_script", {
      tab: tab.id,
      code: 'return await page.$("body");',
    });
    expect(result.structured?.value).toBe("ref: <Node>");
  });

  test("run_script: a returned JavaScript handle is named as a handle reference", async () => {
    const result = await mcp.call("run_script", {
      tab: tab.id,
      code: "return await page.evaluateHandle(() => 1);",
    });
    expect(result.structured?.value).toBe("ref: <JSHandle>");
  });

  test("run_script: a returned page is named as a page reference", async () => {
    const result = await mcp.call("run_script", { tab: tab.id, code: "return page;" });
    expect(result.structured?.value).toBe("ref: <Page>");
  });

  test("run_script: a returned Symbol is marked as undefined", async () => {
    const result = await mcp.call("run_script", { code: 'return Symbol("s");' });
    expect(result.structured?.undefined).toBe(true);
  });

  test("run_script: a logged Map is the list of its entries in the log lines", async () => {
    const result = await mcp.call("run_script", { code: "log(new Map([[1, 2]]));" });
    expect(result.structured?.logs).toEqual(["[[1,2]]"]);
  });
});
