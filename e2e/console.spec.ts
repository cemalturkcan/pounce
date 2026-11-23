import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startFixture, type Fixture } from "./fixture.ts";
import { type ToolArgs, useMcpHarness } from "../tests/mcpHarness.ts";
import { useLogger } from "../src/log/logger.ts";
import { sleep } from "../src/shared/async.ts";

let fixture: Fixture;
const stealth = (process.env.WEB_AGENT_ENGINE ?? "patchright") === "patchright";
const mcp = useMcpHarness({ name: "console", env: { WEB_AGENT_CONSOLE_HOOK: "off" } });

async function text(name: string, args: ToolArgs) {
  return (await mcp.call(name, args)).text;
}

beforeAll(async () => {
  fixture = await startFixture();
});

afterAll(async () => {
  await fixture?.close();
});

describe("logs on a site outside the console hook", () => {
  let logs: string;

  beforeAll(async () => {
    const tab =
      /Opened (t\d+)/.exec(await text("navigate", { url: `${fixture.url}/console` }))?.[1] ?? "";
    await sleep(500);
    logs = await text("logs", { source: "page", tab });
  });

  test("still returns what the browser logs about the page", () => {
    expect(logs).toMatch(/Permissions-Policy header: Unrecognized feature: 'fixture-feature'/);
  });

  test("returns the page's own console calls only with the playwright engine", () => {
    expect(/page log line/.test(logs)).toBe(!stealth);
  });

  test("the description names both sources and where each is captured", async () => {
    const { tools } = await mcp.client.listTools();
    const description = tools.find((tool) => tool.name === "logs")?.description ?? "";
    expect(description).toMatch(
      /Messages Chrome itself logs about the page, such as a Permissions-Policy header error, are captured on every site/,
    );
  });

  test("the description states where the patchright engine captures page console calls", async () => {
    const { tools } = await mcp.client.listTools();
    const description = tools.find((tool) => tool.name === "logs")?.description ?? "";
    expect(description).toMatch(
      /With the default patchright engine, uncaught errors and unhandled rejections are captured on every site but the page's own console calls only on local development hosts \(localhost, 127\.0\.0\.1, \*\.localhost, \*\.test\); WEB_AGENT_CONSOLE_HOOK=all captures console calls on every site and off captures neither/,
    );
  });

  test("the description states that the playwright engine captures page console calls everywhere", async () => {
    const { tools } = await mcp.client.listTools();
    const description = tools.find((tool) => tool.name === "logs")?.description ?? "";
    expect(description).toMatch(
      /With WEB_AGENT_ENGINE=playwright they are captured on every site and WEB_AGENT_CONSOLE_HOOK has no effect/,
    );
  });
});

for (const hook of [undefined, "local", "all", "off"]) {
  describe(`logs with the console hook ${hook ?? "at its default"}`, () => {
    const hookMcp = useMcpHarness({ name: "console-hook", env: { WEB_AGENT_CONSOLE_HOOK: hook } });
    const capturesPageCalls = !stealth || hook !== "off";

    async function hookText(name: string, args: ToolArgs) {
      return (await hookMcp.call(name, args)).text;
    }

    afterAll(() => {
      useLogger(mcp.deps.log);
    });

    describe.skipIf(!capturesPageCalls)("records each console call and uncaught error once", () => {
      let logs: string;

      beforeAll(async () => {
        const tab =
          /Opened (t\d+)/.exec(
            await hookText("navigate", { url: `${fixture.url}/console` }),
          )?.[1] ?? "";
        await sleep(500);
        logs = await hookText("logs", { source: "page", tab });
      });

      test("the console call appears once", () => {
        expect(logs.match(/page log line/g)?.length).toBe(1);
      });

      test("the uncaught error appears once", () => {
        expect(logs.match(/uncaught page error/g)?.length).toBe(1);
      });
    });

    describe.skipIf(!capturesPageCalls)("with a malformed entry in the console buffer", () => {
      let logs: string;

      beforeAll(async () => {
        const tab =
          /Opened (t\d+)/.exec(
            await hookText("navigate", { url: `${fixture.url}/console-malformed` }),
          )?.[1] ?? "";
        await sleep(500);
        logs = await hookText("logs", { source: "page", tab });
      });

      test("the call before it is still returned", () => {
        expect(logs).toMatch(/line before/);
      });

      test("the call after it is still returned", () => {
        expect(logs).toMatch(/line after/);
      });
    });

    describe.skipIf(!capturesPageCalls)("on a site with its own webAgentConsole global", () => {
      let logs: string;
      let siteValue: string;

      beforeAll(async () => {
        const tab =
          /Opened (t\d+)/.exec(
            await hookText("navigate", { url: `${fixture.url}/site-globals` }),
          )?.[1] ?? "";
        await sleep(500);
        logs = await hookText("logs", { source: "page", tab });
        siteValue = await hookText("evaluate", {
          tab,
          expression: "window.webAgentConsole.join(',')",
        });
      });

      test("the console call is still recorded", () => {
        expect(logs).toMatch(/page log line/);
      });

      test("the site's own array is left untouched", () => {
        expect(siteValue).toMatch(/site entry/);
      });
    });
  });
}
