import { describe, expect, test } from "bun:test";
import {
  parseKeys,
  type Choice,
  pickerKey,
  pickerOrder,
  pickerStart,
  secretKey,
  secretStart,
  visibleChoices,
} from "./prompt.ts";

const CHOICES: Choice<"claude" | "codex" | "cursor">[] = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
];

function press(input: string, initial: ("claude" | "codex" | "cursor")[] = []) {
  return parseKeys(input).reduce(pickerKey, pickerStart(CHOICES, initial));
}

describe("the agent picker", () => {
  test("starts with the detected agents ticked", () => {
    expect(pickerOrder(press("", ["codex"]))).toStrictEqual(["codex"]);
  });

  test("Space toggles the focused agent", () => {
    expect(pickerOrder(press(" ", ["codex"]))).toStrictEqual(["claude", "codex"]);
  });

  test("Space on a ticked agent unticks it", () => {
    expect(pickerOrder(press("\u001b[B ", ["codex"]))).toStrictEqual([]);
  });

  test("typing filters the list", () => {
    expect(visibleChoices(press("cur")).map((choice) => choice.value)).toStrictEqual(["cursor"]);
  });

  test("Space after typing ticks the matching agent", () => {
    expect(pickerOrder(press("cur "))).toStrictEqual(["cursor"]);
  });

  test("Backspace widens the filter again", () => {
    expect(visibleChoices(press("curx\u007f\u007f\u007f\u007f")).length).toBe(3);
  });

  test("Enter confirms", () => {
    expect(press("\r").done).toBe(true);
  });

  test("Ctrl+C cancels", () => {
    expect(press("\u0003").cancelled).toBe(true);
  });

  test("the cursor stops at the last agent", () => {
    expect(press("\u001b[B\u001b[B\u001b[B\u001b[B").cursor).toBe(2);
  });
});

test("arrow keys split from typed text", () => {
  expect(parseKeys("a\u001b[Ab")).toStrictEqual([
    { name: "char", char: "a" },
    { name: "up" },
    { name: "char", char: "b" },
  ]);
});

describe("the hidden key prompt", () => {
  test("Enter on a key of only spaces does not finish", () => {
    expect(parseKeys("   \r").reduce(secretKey, secretStart()).done).toBe(false);
  });

  test("Enter on a typed key finishes", () => {
    expect(parseKeys("sk-x\r").reduce(secretKey, secretStart()).done).toBe(true);
  });
});
