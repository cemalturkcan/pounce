import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { useToolsHarness } from "./tools-harness.ts";

const { ok, call, fixture, openedTab } = useToolsHarness("human-input");

const logSchema = z.object({
  moves: z.array(z.tuple([z.number(), z.number()])),
  downs: z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })),
  ups: z.array(z.number()),
  keydowns: z.array(z.number()),
  keyups: z.array(z.number()),
  wheels: z.number(),
  scrollY: z.number(),
});

function furthestFromLine(points: [number, number][]) {
  const [startX, startY] = points[0] ?? [0, 0];
  const [endX, endY] = points.at(-1) ?? [0, 0];
  const length = Math.hypot(endX - startX, endY - startY) || 1;
  return Math.max(
    ...points.map(
      ([x, y]) =>
        Math.abs((endY - startY) * x - (endX - startX) * y + endX * startY - endY * startX) /
        length,
    ),
  );
}

function distanceFrom(moves: [number, number][], [x, y]: [number, number]) {
  const [firstX, firstY] = moves[0] ?? [Number.POSITIVE_INFINITY, 0];
  return Math.hypot(firstX - x, firstY - y);
}

const gaps = (times: number[]) => times.slice(1).map((time, index) => time - (times[index] ?? 0));

describe("human-like input", () => {
  let tab = "";

  const inputLog = async () =>
    logSchema.parse(
      JSON.parse(
        (await ok("evaluate", { tab, expression: "inputLog()" })).split("\n").slice(1).join("\n"),
      ),
    );
  const text = async (selector: string) =>
    (await ok("read_page", { tab, target: selector })).trim();

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/human-input` }));
    await inputLog();
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("a plain click moves straight to the element's center", async () => {
    await ok("click", { tab, target: "#target" });
    expect((await inputLog()).moves.length).toBeLessThanOrEqual(1);
  });

  test("a plain click presses the exact center", async () => {
    await ok("click", { tab, target: "#target" });
    const [down] = (await inputLog()).downs;
    expect([down?.x, down?.y]).toStrictEqual([580, 360]);
  });

  test("a human click sends many mouse moves before pressing", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/human-input` });
    await ok("click", { tab, target: "#field", human: true });
    expect((await inputLog()).moves.length).toBeGreaterThan(10);
  });

  test("a human click never jumps the mouse onto the element's center first", async () => {
    await ok("click", { tab, target: "#field", human: true });
    await inputLog();
    await ok("click", { tab, target: "#target", human: true });
    expect(distanceFrom((await inputLog()).moves, [580, 360])).toBeGreaterThan(100);
  });

  test("a human click is refused while another element covers the target", async () => {
    await ok("evaluate", {
      tab,
      expression:
        "document.body.insertAdjacentHTML('beforeend', '<div id=\"cover\" style=\"position:fixed;inset:0\"></div>')",
    });
    const refused = await call("click", { tab, target: "#target", human: true, timeout_ms: 500 });
    await ok("evaluate", { tab, expression: "document.getElementById('cover').remove()" });
    expect(refused.text).toMatch(/covers the target/);
  });

  test("a human click travels along a curve", async () => {
    await ok("click", { tab, target: "#source", human: true });
    expect(furthestFromLine((await inputLog()).moves)).toBeGreaterThan(3);
  });

  test("a human click holds the button down like a person", async () => {
    await ok("click", { tab, target: "#target", human: true });
    const log = await inputLog();
    expect((log.ups[0] ?? 0) - (log.downs[0]?.t ?? 0)).toBeGreaterThanOrEqual(50);
  });

  test("a human click still clicks the element", async () => {
    await ok("navigate", { tab, url: `${fixture().url}/human-input` });
    await ok("click", { tab, target: "#target", human: true });
    expect(await text("#target")).toMatch(/clicked/);
  });

  test("a human move after a plain click starts where the click left the mouse", async () => {
    await ok("click", { tab, target: "#field", human: true });
    await ok("click", { tab, target: "#target" });
    await inputLog();
    await ok("click", { tab, target: "#field", human: true });
    expect(distanceFrom((await inputLog()).moves, [580, 360])).toBeLessThan(15);
  });

  test("a human move after a plain hover starts where the hover left the mouse", async () => {
    await ok("hover", { tab, target: "#source" });
    await inputLog();
    await ok("click", { tab, target: "#target", human: true });
    expect(distanceFrom((await inputLog()).moves, [90, 230])).toBeLessThan(15);
  });

  test("a human move after a plain drag starts at the drop point", async () => {
    await ok("drag", { tab, target: "#source", to: "#drop" });
    await inputLog();
    await ok("click", { tab, target: "#target", human: true });
    expect(distanceFrom((await inputLog()).moves, [450, 230])).toBeLessThan(15);
  });

  test("a plain fill sets the value without key events", async () => {
    await ok("fill", { tab, target: "#field", value: "quick" });
    expect((await inputLog()).keydowns).toStrictEqual([]);
  });

  test("a human fill types with spaced key presses", async () => {
    await ok("fill", { tab, target: "#field", value: "hello world", human: true });
    expect(Math.min(...gaps((await inputLog()).keydowns))).toBeGreaterThanOrEqual(25);
  });

  test("a human fill replaces the value", async () => {
    await ok("fill", { tab, target: "#field", value: "replaced", human: true });
    expect(
      await ok("evaluate", { tab, expression: "document.getElementById('field').value" }),
    ).toMatch(/replaced$/);
  });

  test("a human fill checks a checkbox", async () => {
    await ok("fill", { tab, target: "#agree", value: "true", human: true });
    expect(
      await ok("evaluate", { tab, expression: "document.getElementById('agree').checked" }),
    ).toMatch(/true$/);
  });

  test("a human fill picks a select option", async () => {
    await ok("fill", { tab, target: "#size", value: "Large", human: true });
    expect(
      await ok("evaluate", { tab, expression: "document.getElementById('size').value" }),
    ).toMatch(/Large$/);
  });

  test("a human double click fires a double click", async () => {
    await ok("click", { tab, target: "#double", click_count: 2, human: true });
    expect(await text("#double")).toMatch(/double clicked/);
  });

  test("a human fill with fields types each field", async () => {
    await inputLog();
    await ok("fill", { tab, fields: [{ target: "#field", value: "abc" }], human: true });
    expect((await inputLog()).keydowns.length).toBeGreaterThanOrEqual(3);
  });

  test("a human press holds the key", async () => {
    await ok("press", { tab, key: "a", target: "#field", human: true });
    const log = await inputLog();
    expect((log.keyups[0] ?? 0) - (log.keydowns[0] ?? 0)).toBeGreaterThanOrEqual(15);
  });

  test("a human hover glides onto the element", async () => {
    await ok("hover", { tab, target: "#source", human: true });
    expect((await inputLog()).moves.length).toBeGreaterThan(10);
  });

  test("a human drag drops onto the target", async () => {
    await ok("drag", { tab, target: "#source", to: "#drop", human: true });
    expect(await text("#drop")).toMatch(/dropped/);
  });

  test("a plain scroll sends one wheel event", async () => {
    await ok("scroll", { tab, direction: "down", amount: 600 });
    expect((await inputLog()).wheels).toBe(1);
  });

  test("a human scroll glides in many wheel events", async () => {
    await ok("scroll", { tab, direction: "down", amount: 600, human: true });
    expect((await inputLog()).wheels).toBeGreaterThan(4);
  });

  test("a human scroll covers the requested distance", async () => {
    await ok("scroll", { tab, to: "top", human: true });
    await inputLog();
    await ok("scroll", { tab, direction: "down", amount: 600, human: true });
    expect((await inputLog()).scrollY).toBe(600);
  });
});

describe("human scroll to the end", () => {
  let tab = "";

  beforeAll(async () => {
    tab = openedTab(await ok("navigate", { url: `${fixture().url}/human-input/inner-scroller` }));
  });

  afterAll(async () => {
    await ok("tabs", { close: [tab] });
  });

  test("a human scroll to the bottom after a click in an inner scroller reaches the page's bottom", async () => {
    await ok("click", { tab, target: "#item", human: true });
    await ok("scroll", { tab, to: "bottom", human: true });
    expect(
      await ok("evaluate", {
        tab,
        expression:
          "Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight",
      }),
    ).toMatch(/\ntrue$/);
  });
});
