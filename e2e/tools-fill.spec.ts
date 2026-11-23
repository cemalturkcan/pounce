import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sleep } from "../src/shared/async.ts";
import type { ToolArgs } from "../tests/mcpHarness.ts";
import { type FillFixture, startFillFixture } from "./fixture-fill.ts";
import { TEST_SECRET, useToolsHarness } from "./tools-harness.ts";

const { mcp, ok, failure } = useToolsHarness("tools-fill");
let site: FillFixture;

beforeAll(() => {
  site = startFillFixture();
});

afterAll(async () => {
  await site.close();
});

async function onPage<T>(route: string, work: (tab: string) => Promise<T>) {
  const tab = (await mcp.deps.manager.openTab("stdio")).id;
  try {
    await ok("navigate", { tab, url: `${site.url}${route}` });
    return await work(tab);
  } finally {
    await mcp.deps.manager.closeTab(tab);
  }
}

async function valueOf(tab: string, expression: string) {
  return (await ok("evaluate", { tab, expression })).split("\n").at(-1) ?? "";
}

const statusOf = (tab: string) => valueOf(tab, "document.getElementById('status').textContent");

async function fixtureFile(name: string) {
  const file = path.join(mcp.workDir, name);
  await writeFile(file, `content of ${name}`);
  return file;
}

describe("fill with target", () => {
  test("value types into a text input", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#name", value: "Ada" });
      expect(await valueOf(tab, "document.getElementById('name').value")).toBe("Ada");
    });
  });

  test("value picks a select option by label", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#plan", value: "Pro" });
      expect(await valueOf(tab, "document.getElementById('plan').value")).toBe("pro");
    });
  });

  test("value true checks a checkbox", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#terms", value: "true" });
      expect(await valueOf(tab, "document.getElementById('terms').checked")).toBe("true");
    });
  });

  test("secret types the stored value without returning it", async () => {
    await onPage("/form", async (tab) => {
      const text = await ok("fill", { tab, target: "#password", secret: "fixture/site" });
      expect(text).toMatch(/with secret fixture\/site \(password\)/);
      expect(text).not.toContain(TEST_SECRET);
    });
  });

  test("submit true presses Enter in the field", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#search", value: "lamps", submit: true });
      expect(await statusOf(tab)).toBe("searched lamps");
    });
  });

  test("submit true names the Enter press in the result", async () => {
    await onPage("/form", async (tab) => {
      expect(await ok("fill", { tab, target: "#search", value: "lamps", submit: true })).toMatch(
        /Pressed Enter in textbox "Search"/,
      );
    });
  });

  test("submit with a target clicks that element", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#name", value: "Ada", submit: "#send" });
      expect(await statusOf(tab)).toBe("submitted Ada");
    });
  });

  test("a dialog opened by the Enter press names that press", async () => {
    await onPage("/form", async (tab) => {
      const text = await ok("fill", { tab, target: "#enter-alert", value: "x", submit: true });
      await ok("dialog", { tab, action: "accept" });
      expect(text).toMatch(/It opened after pressing Enter in textbox "Enter alert"/);
    });
  });

  test("a file input given a value points to files", async () => {
    await onPage("/form", async (tab) => {
      expect(await failure("fill", { tab, target: "#avatar", value: "x" })).toMatch(
        /file input[\s\S]*files/,
      );
    });
  });

  test("the old text parameter is rejected", async () => {
    await onPage("/form", async (tab) => {
      await failure("fill", { tab, target: "#name", text: "Ada" });
    });
  });
});

describe("fill with files", () => {
  test("files attach to a file input", async () => {
    const first = await fixtureFile("first.txt");
    const second = await fixtureFile("second.txt");
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#avatar", files: [first, second] });
      expect(await statusOf(tab)).toBe("files first.txt,second.txt");
    });
  });

  test("files go through the file chooser a button opens", async () => {
    const file = await fixtureFile("chosen.txt");
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, target: "#pick", files: [file] });
      expect(await statusOf(tab)).toBe("picked chosen.txt");
    });
  });

  test("files report how many were attached", async () => {
    const file = await fixtureFile("counted.txt");
    await onPage("/form", async (tab) => {
      expect(await ok("fill", { tab, target: "#avatar", files: [file] })).toMatch(
        /Attached 1 file\(s\) to/,
      );
    });
  });

  test("a missing file is refused before touching the page", async () => {
    await onPage("/form", async (tab) => {
      expect(
        await failure("fill", { tab, target: "#avatar", files: ["/nonexistent/file.txt"] }),
      ).toMatch(/No file at \/nonexistent\/file\.txt/);
    });
  });

  test("a dialog opened by attaching names the attach", async () => {
    const file = await fixtureFile("alerting.txt");
    await onPage("/form", async (tab) => {
      const text = await ok("fill", { tab, target: "#file-alert", files: [file] });
      await ok("dialog", { tab, action: "accept" });
      expect(text).toMatch(/It opened after attaching 1 file\(s\) to/);
    });
  });
});

describe("fill with fields", () => {
  test("fields fill in order and report invalid fields", async () => {
    await onPage("/form", async (tab) => {
      const text = await ok("fill", {
        tab,
        fields: [
          { target: "#name", value: "Ada" },
          { target: "#age", value: "10" },
          { target: "#plan", value: "Pro" },
        ],
      });
      expect(text).toMatch(/Invalid: #age/);
    });
  });

  test("fields take a secret per entry", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", {
        tab,
        fields: [{ target: "#password", secret: "fixture/site", secret_field: "username" }],
      });
      expect(await valueOf(tab, "document.getElementById('password').value")).toBe("fixture-user");
    });
  });

  test("submit with a target clicks it after the fields", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", { tab, fields: [{ target: "#name", value: "Grace" }], submit: "#send" });
      expect(await statusOf(tab)).toBe("submitted Grace");
    });
  });

  test("submit true presses Enter in the last field", async () => {
    await onPage("/form", async (tab) => {
      await ok("fill", {
        tab,
        fields: [
          { target: "#name", value: "Ada" },
          { target: "#search", value: "desks" },
        ],
        submit: true,
      });
      expect(await statusOf(tab)).toBe("searched desks");
    });
  });

  test("fields stop at the first field that fails and list what was done", async () => {
    await onPage("/form", async (tab) => {
      expect(
        await failure("fill", {
          tab,
          fields: [
            { target: "#name", value: "Ada" },
            { target: "#absent", value: "x" },
            { target: "#age", value: "30" },
          ],
        }),
      ).toMatch(/Filled 1 of 3 fields, then #absent failed/);
    });
  });

  test("a field entry with the old text key is rejected", async () => {
    await onPage("/form", async (tab) => {
      await failure("fill", { tab, fields: [{ target: "#name", text: "Ada" }] });
    });
  });
});

describe("fill input rules", () => {
  const rules: [string, ToolArgs, RegExp][] = [
    ["neither target nor fields", {}, /Give either target or fields/],
    [
      "both target and fields",
      { target: "#name", value: "x", fields: [{ target: "#age", value: "1" }] },
      /Give either target or fields/,
    ],
    ["target without a value", { target: "#name" }, /exactly one of value, secret or files/],
    [
      "value together with files",
      { target: "#avatar", value: "x", files: ["/tmp/a"] },
      /exactly one of value, secret or files/,
    ],
    [
      "files with slowly",
      { target: "#avatar", files: ["/tmp/a"], slowly: true },
      /slowly.*not.*files/i,
    ],
    ["files with human", { target: "#avatar", files: ["/tmp/a"], human: true }, /human.*files/i],
    ["files with submit true", { target: "#avatar", files: ["/tmp/a"], submit: true }, /submit/],
    ["secret_field without secret", { target: "#name", value: "x", secret_field: "otp" }, /secret/],
    [
      "slowly with fields",
      { fields: [{ target: "#name", value: "x" }], slowly: true },
      /slowly.*target/,
    ],
    [
      "timeout_ms with fields",
      { fields: [{ target: "#name", value: "x" }], timeout_ms: 5000 },
      /timeout_ms.*target/,
    ],
    [
      "value beside fields",
      { fields: [{ target: "#name", value: "x" }], value: "y" },
      /inside each field/,
    ],
  ];
  for (const [name, args, message] of rules) {
    test(`${name} is refused`, async () => {
      await onPage("/form", async (tab) => {
        expect(await failure("fill", { tab, ...args })).toMatch(message);
      });
    });
  }
});

const columnText = (tab: string, id: string) =>
  valueOf(tab, `document.getElementById('${id}').innerText.replace(/\\s+/g, '')`);

describe("click target timeout", () => {
  test("a click whose target never appears fails at its timeout", async () => {
    await onPage("/form", async (tab) => {
      const startedAt = performance.now();
      await failure("click", { tab, target: "#never-there", timeout_ms: 500 });
      expect(performance.now() - startedAt).toBeLessThan(1200);
    });
  });

  test("a click target timeout names a chained selector ending in nth as it was given", async () => {
    await onPage("/form", async (tab) => {
      expect(
        await failure("click", { tab, target: 'p >> text="Nope" >> nth=1', timeout_ms: 500 }),
      ).toStartWith('Nothing matched p >> text="Nope" >> nth=1 within 0.5 s.');
    });
  });

  test("a click on a selector that matches several elements says how many it matched", async () => {
    await onPage("/form", async (tab) => {
      expect(await failure("click", { tab, target: "button", timeout_ms: 500 })).toStartWith(
        "The target button matched 2 elements, but the call acts on exactly one.\n",
      );
    });
  });

  test("a click target that appears late but never becomes clickable fails at its timeout", async () => {
    await onPage("/form", async (tab) => {
      await ok("evaluate", {
        tab,
        expression:
          "setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button id=\"late-hidden\" hidden>Late</button>'), 1000)",
      });
      const startedAt = performance.now();
      await failure("click", { tab, target: "#late-hidden", timeout_ms: 1500 });
      expect(performance.now() - startedAt).toBeLessThan(2100);
    });
  });

  test("a click target that never becomes clickable reports the timeout it was given", async () => {
    await onPage("/form", async (tab) => {
      await ok("evaluate", {
        tab,
        expression:
          "setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button id=\"late-hidden\" hidden>Late</button>'), 300)",
      });
      expect(await failure("click", { tab, target: "#late-hidden", timeout_ms: 1500 })).toMatch(
        /Timeout 1500ms exceeded/,
      );
    });
  });

  test("a fill whose submit target never appears fails at its timeout", async () => {
    await onPage("/form", async (tab) => {
      const startedAt = performance.now();
      await failure("fill", {
        tab,
        target: "#name",
        value: "Ada",
        submit: "#never-there",
        timeout_ms: 500,
      });
      expect(performance.now() - startedAt).toBeLessThan(2500);
    });
  });

  test("a human fill target that never becomes visible reports the timeout it was given", async () => {
    await onPage("/form", async (tab) => {
      await ok("evaluate", {
        tab,
        expression:
          "setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<input id=\"late-hidden\" hidden>'), 300)",
      });
      expect(
        await failure("fill", {
          tab,
          target: "#late-hidden",
          value: "Ada",
          timeout_ms: 1000,
          human: true,
        }),
      ).toMatch(/Timeout 1000ms exceeded/);
    });
  });

  test("a human click target that never becomes clickable reports the timeout it was given", async () => {
    await onPage("/form", async (tab) => {
      await ok("evaluate", {
        tab,
        expression:
          "setTimeout(() => document.body.insertAdjacentHTML('beforeend', '<button id=\"late-hidden\" hidden>Late</button>'), 300)",
      });
      expect(
        await failure("click", { tab, target: "#late-hidden", timeout_ms: 1000, human: true }),
      ).toMatch(/Timeout 1000ms exceeded/);
    });
  });
});

const withRows = (tab: string, rows: number) =>
  ok("evaluate", {
    tab,
    expression: `document.body.insertAdjacentHTML('afterbegin', '<button id="go" onclick="document.getElementById(\\'status\\').textContent = \\'went\\'">Go</button>'); document.body.insertAdjacentHTML('beforeend', '<table>' + Array.from({ length: ${rows} }, (_, row) => '<tr><td>Row ' + row + '</td><td><a href="#r' + row + '">Open ' + row + '</a></td><td><input aria-label="Note ' + row + '"></td></tr>').join('') + '</table>')`,
  });

describe("click timeout on a large page", () => {
  test("a click with include_diff and the default timeout on a 9000-row page clicks a present button", async () => {
    await onPage("/form", async (tab) => {
      await withRows(tab, 9000);
      await ok("click", { tab, target: "#go", include_diff: true });
      expect(await statusOf(tab)).toBe("went");
    });
  });

  test("a click with include_diff and timeout_ms 1000 on a 6000-row page clicks a present button", async () => {
    await onPage("/form", async (tab) => {
      await withRows(tab, 6000);
      await ok("click", { tab, target: "#go", include_diff: true, timeout_ms: 1000 });
      expect(await statusOf(tab)).toBe("went");
    });
  });

  test("a fill's submit click with include_diff and timeout_ms 1000 on a 6000-row page clicks a present button", async () => {
    await onPage("/form", async (tab) => {
      await withRows(tab, 6000);
      await ok("fill", {
        tab,
        target: "#name",
        value: "Ada",
        submit: "#go",
        include_diff: true,
        timeout_ms: 1000,
      });
      expect(await statusOf(tab)).toBe("went");
    });
  });
});

describe("drag", () => {
  test("a drag onto an element that never appears fails with a plain sentence", async () => {
    await onPage("/drag", async (tab) => {
      expect(await failure("drag", { tab, target: "#column-a", to: "#never-there" })).toMatch(
        /^Nothing matched #never-there within 8 s\.\nTake a snapshot/,
      );
    });
  });

  test("target and to swap HTML5 drag-and-drop columns", async () => {
    await onPage("/drag", async (tab) => {
      await ok("drag", { tab, target: "#column-a", to: "#column-b" });
      expect(await columnText(tab, "columns")).toBe("BA");
    });
  });

  test("a second drag names a ref's element by the text it shows at that time", async () => {
    await onPage("/drag", async (tab) => {
      const snapshot = await ok("snapshot", { tab });
      const source = /generic \[ref=(e\d+)\]: Handle/.exec(snapshot)?.[1] ?? "";
      const drop = /generic \[ref=(e\d+)\]: Mouse drop/.exec(snapshot)?.[1] ?? "";
      await ok("drag", { tab, target: source, to: drop });
      expect(await ok("drag", { tab, target: source, to: drop })).toContain(
        `onto generic "dropped" (${drop})`,
      );
    });
  });

  test("a mouse drop zone reacts to the mouse drag", async () => {
    await onPage("/drag", async (tab) => {
      await ok("drag", { tab, target: "#mouse-source", to: "#mouse-drop" });
      expect(await columnText(tab, "mouse-drop")).toBe("dropped");
    });
  });

  test("a mouse drag the page reacts to needs no HTML5 retry", async () => {
    await onPage("/drag", async (tab) => {
      expect(await ok("drag", { tab, target: "#mouse-source", to: "#mouse-drop" })).not.toMatch(
        /HTML5/,
      );
    });
  });

  test("a page that reacts late to the mouse drag gets a single drop", async () => {
    await onPage("/drag", async (tab) => {
      await ok("drag", { tab, target: "#late-source", to: "#late-drop" });
      await sleep(600);
      expect(await columnText(tab, "late-drop")).toBe("1");
    });
  });

  test("when the mouse drag starts no HTML5 drag, HTML5 drag events are sent", async () => {
    await onPage("/drag", async (tab) => {
      await ok("drag", { tab, target: "#column-c", to: "#column-d" });
      expect(await columnText(tab, "guarded")).toBe("DC");
    });
  });

  test("the result says the drop needed HTML5 drag events", async () => {
    await onPage("/drag", async (tab) => {
      expect(await ok("drag", { tab, target: "#column-c", to: "#column-d" })).toMatch(
        /^Dragged .* with HTML5 drag events/,
      );
    });
  });

  test("a human drag retries with HTML5 drag events too", async () => {
    await onPage("/drag", async (tab) => {
      await ok("drag", { tab, target: "#column-c", to: "#column-d", human: true });
      expect(await columnText(tab, "guarded")).toBe("DC");
    });
  });

  test("a drag the page ignores leads with the page did not react", async () => {
    await onPage("/drag", async (tab) => {
      expect(await ok("drag", { tab, target: "#still-a", to: "#still-b" })).toMatch(
        /^The page did not react to dragging /,
      );
    });
  });

  test("a drag the page ignores does not repeat the no-change line", async () => {
    await onPage("/drag", async (tab) => {
      expect(await ok("drag", { tab, target: "#still-a", to: "#still-b" })).not.toMatch(
        /No DOM change/,
      );
    });
  });

  test("the old from parameter is rejected", async () => {
    await onPage("/drag", async (tab) => {
      await failure("drag", { tab, from: "#column-a", to: "#column-b" });
    });
  });
});

const scrollY = (tab: string) => valueOf(tab, "String(Math.round(window.scrollY))");

describe("scroll", () => {
  test("to bottom jumps to the end of the page", async () => {
    await onPage("/scroll", async (tab) => {
      await ok("scroll", { tab, to: "bottom" });
      expect(
        await valueOf(
          tab,
          "String(Math.round(window.scrollY + innerHeight) >= document.documentElement.scrollHeight - 1)",
        ),
      ).toBe("true");
    });
  });

  test("to top jumps back to the start", async () => {
    await onPage("/scroll", async (tab) => {
      await ok("scroll", { tab, to: "bottom" });
      await ok("scroll", { tab, to: "top" });
      expect(await scrollY(tab)).toBe("0");
    });
  });

  test("direction and amount scroll by pixels", async () => {
    await onPage("/scroll", async (tab) => {
      await ok("hover", { tab, x: 600, y: 300 });
      await ok("scroll", { tab, direction: "down", amount: 500 });
      expect(await scrollY(tab)).toBe("500");
    });
  });

  test("after a hover over a panel, direction scrolls that panel", async () => {
    await onPage("/scroll", async (tab) => {
      await ok("hover", { tab, target: "#panel" });
      await ok("scroll", { tab, direction: "down", amount: 300 });
      expect(await valueOf(tab, "String(document.getElementById('panel').scrollTop)")).toBe("300");
    });
  });

  test("target scrolls an element into view", async () => {
    await onPage("/scroll", async (tab) => {
      await ok("scroll", { tab, target: "#far" });
      expect(Number(await scrollY(tab))).toBeGreaterThan(2000);
    });
  });

  const rules: [string, ToolArgs, RegExp][] = [
    ["to with direction", { to: "bottom", direction: "down" }, /direction.*to/],
    ["to with amount", { to: "top", amount: 100 }, /amount.*to/],
    ["target with to", { target: "#far", to: "top" }, /target.*to/],
    ["target with direction", { target: "#far", direction: "down" }, /target.*direction/],
  ];
  for (const [name, args, message] of rules) {
    test(`${name} is refused`, async () => {
      await onPage("/scroll", async (tab) => {
        expect(await failure("scroll", { tab, ...args })).toMatch(message);
      });
    });
  }

  test("direction no longer takes bottom", async () => {
    await onPage("/scroll", async (tab) => {
      await failure("scroll", { tab, direction: "bottom" });
    });
  });
});

describe("waits", () => {
  test("wait_for text finds a visible match when a hidden copy comes first", async () => {
    await onPage("/wait", async (tab) => {
      await ok("click", { tab, target: "#later" });
      expect(await ok("wait_for", { tab, text: "Results ready", timeout_ms: 3000 })).toMatch(
        /is visible/,
      );
    });
  });

  test("handoff until_text finds a visible match when a hidden copy comes first", async () => {
    await onPage("/wait", async (tab) => {
      await ok("click", { tab, target: "#later" });
      expect(
        await ok("handoff", {
          tab,
          message: "Load the results",
          until_text: "Results ready",
          timeout_ms: 5000,
        }),
      ).toMatch(/completed the step/);
    });
  });

  test("handoff until_gone waits for the visible copy to go", async () => {
    await onPage("/wait", async (tab) => {
      await ok("evaluate", {
        tab,
        expression: "setTimeout(() => document.getElementById('prompt').remove(), 800), 1",
      });
      await ok("handoff", {
        tab,
        message: "Solve the check",
        until_gone: "Verify you are human",
        timeout_ms: 5000,
      });
      expect(await valueOf(tab, "String(document.getElementById('prompt') === null)")).toBe("true");
    });
  });

  test("handoff until_url accepts a glob as wait_for does", async () => {
    await onPage("/wait", async (tab) => {
      await ok("evaluate", {
        tab,
        expression: "setTimeout(() => history.pushState(null, '', '/wait?done=1'), 300), 1",
      });
      expect(
        await ok("handoff", {
          tab,
          message: "Finish",
          until_url: "**/wait?done=*",
          timeout_ms: 5000,
        }),
      ).toMatch(/completed the step/);
    });
  });

  test("handoff with two conditions is refused", async () => {
    await onPage("/wait", async (tab) => {
      expect(
        await failure("handoff", {
          tab,
          message: "Finish",
          until_text: "a",
          until_url: "b",
        }),
      ).toMatch(/at most one of until_text, until_gone, until_url/);
    });
  });
});
