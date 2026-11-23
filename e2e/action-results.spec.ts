import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, ok, call, fixture, openedTab, refOf } = useToolsHarness("action-results");

const actionsUrl = () => `${fixture().url}/actions`;

function closedPortUrl() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${probe.port}/`;
  void probe.stop(true);
  return url;
}

describe("action results", () => {
  let tab = "";
  const text = async (selector: string) =>
    (await ok("read_page", { tab, target: selector })).split("\n")[1];

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: actionsUrl() }));
  });

  beforeEach(async () => {
    await ok("navigate", { tab, url: actionsUrl() });
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  describe("name what they acted on", () => {
    test("a click on a ref names the element's role, name and ref", async () => {
      const save = refOf(await ok("snapshot", { tab }), 'button "Save"');
      expect(await ok("click", { tab, target: save })).toStartWith(
        `Clicked button "Save" (${save}).`,
      );
    });

    test("a click on a selector names the element and the ref it has", async () => {
      expect(await ok("click", { tab, target: "#save" })).toMatch(
        /^Clicked button "Save" \((?:f\d+)?e\d+, from #save\)\./,
      );
    });

    test("a hover names the element", async () => {
      expect(await ok("hover", { tab, target: "#save" })).toMatch(
        /^Hovering button "Save" \((?:f\d+)?e\d+, from #save\)\./,
      );
    });

    test("a fill names the field", async () => {
      expect(await ok("fill", { tab, target: "#email", value: "a@b" })).toMatch(
        /^Filled textbox "Email" \((?:f\d+)?e\d+, from #email\) with 3 chars\./,
      );
    });

    test("a fill of a field without a name names it by role, not by the value it had", async () => {
      await ok("fill", { tab, target: "#note", value: "hello human" });
      expect(await ok("fill", { tab, target: "#note", value: "plain fill" })).toMatch(
        /^Filled textbox \((?:f\d+)?e\d+, from #note\) with 10 chars\./,
      );
    });

    test("a key press on a target names the element", async () => {
      expect(await ok("press", { tab, key: "a", target: "#email" })).toMatch(
        /^Pressed a on textbox "Email" \((?:f\d+)?e\d+, from #email\)\./,
      );
    });
  });

  describe("report where a navigation landed", () => {
    test("a navigation to a data URL gives no HTTP status", async () => {
      const landed = await ok("navigate", { tab, url: "data:text/html,<title>Inline</title>" });
      expect(landed.split("\n")[0]).toBe('data:text/html… (36 chars) "Inline"');
    });

    test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
      "going back to a page kept in the back/forward cache says it came from there",
      async () => {
        await ok("navigate", { tab, url: `${fixture().url}/actions/landing` });
        expect(await ok("navigate", { tab, url: "back" })).toMatch(
          /^http:\/\/[^ ]+\/actions "Action Results" \(from the back\/forward cache\)/,
        );
      },
    );

    test.skipIf(process.env.WEB_AGENT_ENGINE === "playwright")(
      "going back to a page kept in the back/forward cache returns without waiting for a load",
      async () => {
        await ok("navigate", { tab, url: `${fixture().url}/actions/landing` });
        const startedAt = Date.now();
        await ok("navigate", { tab, url: "back" });
        expect(Date.now() - startedAt).toBeLessThan(1500);
      },
    );

    test("going forward with no later page says so and stays", async () => {
      await ok("navigate", { tab, url: `${fixture().url}/actions/landing` });
      expect(await ok("navigate", { tab, url: "forward" })).toMatch(
        /^Nothing to go forward to: http:\/\/[^ ]+\/actions\/landing "Action Landing" is the latest page in this tab's history\.$/,
      );
    });

    test("going back over a pushState entry says it stayed in the same document", async () => {
      await ok("evaluate", { tab, expression: 'history.pushState({}, "", "/actions/pushed")' });
      expect(await ok("navigate", { tab, url: "back" })).toMatch(
        /^http:\/\/[^ ]+\/actions "Action Results" \(same document, no new request\)/,
      );
    });

    test("going back over a hash change says it stayed in the same document", async () => {
      await ok("evaluate", { tab, expression: 'location.hash = "part"' });
      expect(await ok("navigate", { tab, url: "back" })).toMatch(
        /^http:\/\/[^ ]+\/actions "Action Results" \(same document, no new request\)/,
      );
    });

    test("a click that follows a redirect reports the status and the redirect", async () => {
      expect(await ok("click", { tab, target: "#redirect" })).toMatch(
        /Navigated to http:\/\/[^ ]+\/actions\/landing "Action Landing" \(HTTP 200, redirected from http:\/\/[^ ]+\/actions\/redirect\)/,
      );
    });

    test("a click that lands on a missing page reports HTTP 404", async () => {
      expect(await ok("click", { tab, target: "#missing" })).toMatch(
        /Navigated to http:\/\/[^ ]+\/actions\/missing "Missing" \(HTTP 404\)/,
      );
    });

    test("a click whose page cannot load names Chrome's error page and the network error", async () => {
      const url = closedPortUrl();
      await ok("evaluate", {
        tab,
        expression: `document.getElementById("refused").href = ${JSON.stringify(url)}`,
      });
      expect(await ok("click", { tab, target: "#refused" })).toContain(
        `Chrome could not load ${url} (net::ERR_CONNECTION_REFUSED) and shows its error page instead.`,
      );
    });

    test("a click that lands on an empty error response names its status", async () => {
      expect(await ok("click", { tab, target: "#empty" })).toMatch(
        /\/empty-500 \(HTTP 500 with an empty body, so the tab shows Chrome's error page\)/,
      );
    });

    test("navigate reports the redirect it followed", async () => {
      expect(await ok("navigate", { tab, url: `${fixture().url}/actions/redirect` })).toMatch(
        /\(HTTP 200, redirected from http:\/\/[^ ]+\/actions\/redirect\)/,
      );
    });
  });

  describe("a navigation that does not finish in time", () => {
    test("a click whose page is slow succeeds and says the page is still loading", async () => {
      const result = await call("click", { tab, target: "#slow", timeout_ms: 1000 });
      expect(result).toMatchObject({ isError: false });
      expect(result.text).toMatch(/Still loading http:\/\/[^ ]+\/actions\/slow/);
    });

    test("a click whose page is slow tells the agent not to repeat it", async () => {
      const result = await ok("click", { tab, target: "#slow", timeout_ms: 1000 });
      expect(result).toMatch(/do not repeat it/);
    });

    test("navigate to a slow page reports it as still loading instead of failing", async () => {
      const result = await call("navigate", {
        tab,
        url: `${fixture().url}/actions/slow`,
        timeout_ms: 1000,
      });
      expect(result).toMatchObject({ isError: false });
      expect(result.text).toMatch(/^Still loading http:\/\/[^ ]+\/actions\/slow after 1 s/);
    });

    test("navigate to a slow page says the tab still shows the previous page", async () => {
      const result = await ok("navigate", {
        tab,
        url: `${fixture().url}/actions/slow`,
        timeout_ms: 1000,
      });
      expect(result).toMatch(
        /The server has not answered yet; the tab still shows http:\/\/[^ ]+\/actions\./,
      );
    });

    test("navigate to a page that committed but did not finish loading says what the tab shows", async () => {
      const result = await ok("navigate", {
        tab,
        url: `${fixture().url}/actions/heavy`,
        wait_until: "load",
        timeout_ms: 1000,
      });
      expect(result).toMatch(
        /The tab shows http:\/\/[^ ]+\/actions\/heavy "Heavy Page" \(HTTP 200\), still loading\./,
      );
    });

    test("navigate to an unreachable page still fails", async () => {
      const result = await call("navigate", { tab, url: closedPortUrl() });
      expect(result.isError).toBe(true);
    });
  });

  describe("settle a fresh page before the included snapshot", () => {
    test("navigate waits for data the page fetches right after loading", async () => {
      expect(
        await ok("navigate", {
          tab,
          url: `${fixture().url}/actions/late`,
          include_snapshot: true,
        }),
      ).toMatch(/Results loaded/);
    });

    test("navigate waits while the page shows a loading skeleton", async () => {
      expect(
        await ok("navigate", {
          tab,
          url: `${fixture().url}/actions/skeleton`,
          include_snapshot: true,
        }),
      ).toMatch(/Skeleton replaced/);
    });

    test("a click that navigates waits for the new page's data", async () => {
      expect(await ok("click", { tab, target: "#late", include_snapshot: true })).toMatch(
        /Results loaded/,
      );
    });

    test("read_page right after a navigation waits for the page's data", async () => {
      await ok("navigate", { tab, url: `${fixture().url}/actions/late` });
      expect(await ok("read_page", { tab })).toMatch(/Results loaded/);
    });

    test("a snapshot right after a navigation waits for the page's data", async () => {
      await ok("navigate", { tab, url: `${fixture().url}/actions/late` });
      expect(await ok("snapshot", { tab })).toMatch(/Results loaded/);
    });
  });

  describe("coordinates", () => {
    test("a click at x and y lands on those viewport coordinates", async () => {
      await ok("click", { tab, x: 50, y: 60 });
      expect(await text("#pad-out")).toBe("50,60");
    });

    test("a click at x and y names the element at that point", async () => {
      expect(await ok("click", { tab, x: 50, y: 60 })).toMatch(
        /^Clicked at \(50, 60\) on <canvas id="pad">\./,
      );
    });

    test("a human click at x and y lands on those coordinates", async () => {
      await ok("click", { tab, x: 120, y: 80, human: true });
      expect(await text("#pad-out")).toBe("120,80");
    });

    test("a hover at x and y moves the mouse there", async () => {
      await ok("hover", { tab, x: 450, y: 50 });
      expect(await text("#hover-out")).toBe("hovered");
    });

    test("a human hover at x and y names the element at that point", async () => {
      expect(await ok("hover", { tab, x: 450, y: 50, human: true })).toMatch(
        /^Hovering at \(450, 50\) over <div id="hover-zone">\./,
      );
    });

    test("a point outside the viewport is refused", async () => {
      const result = await call("click", { tab, x: 50, y: 90_000 });
      expect(result.text).toMatch(/outside the viewport/);
    });

    test("a click with both a target and coordinates is refused", async () => {
      const result = await call("click", { tab, target: "#save", x: 50, y: 60 });
      expect(result.text).toMatch(/either target or x and y/);
    });

    test("a click with neither a target nor coordinates is refused", async () => {
      const result = await call("click", { tab });
      expect(result.text).toMatch(/either target or x and y/);
    });
  });
});

describe("an action on a tab that draws no frame", () => {
  let result = "";

  beforeAll(async () => {
    const tab = openedTab(await ok("navigate", { url: actionsUrl() }));
    const session = await mcp.deps.manager.getTab(tab).session;
    const send = session.send.bind(session);
    session.send = (method, params) =>
      method === "Runtime.evaluate" && JSON.stringify(params).includes("requestAnimationFrame")
        ? new Promise<never>(() => undefined)
        : send(method, params);
    result = await ok("click", { tab, target: "#save" });
  });

  test("the result starts with a note that the tab had not drawn a frame", () => {
    expect(result).toMatch(/^Note: t\d+ had not drawn a frame within 1 s/);
  });

  test("the action still runs", () => {
    expect(result).toMatch(/Clicked button "Save"/);
  });
});

describe("a click on a hash link inside an iframe", () => {
  let result = "";

  beforeAll(async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/frame-hash` }));
    const link = refOf(await ok("snapshot", { tab }), 'link "ihash"');
    result = await ok("click", { tab, target: link });
    await ok("tabs", { close: [tab] });
  });

  test("reports the iframe's address change", () => {
    expect(result).toContain(
      `An iframe's address changed from ${fixture().url}/frame-hash/inner to ${fixture().url}/frame-hash/inner#x.`,
    );
  });
});
