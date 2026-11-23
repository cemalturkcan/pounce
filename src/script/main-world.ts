import type { Frame, JSHandle, Locator, Page } from "playwright-core";
import { callMember, kindOf, memberOf } from "./host.ts";
import { type Callable, isCallable } from "./wire.ts";

const EVALUATES = new Map([
  ["evaluate", 3],
  ["evaluateHandle", 3],
]);

const FLAG_POSITIONS = new Map<string, Map<string, number>>([
  ["Page", EVALUATES],
  ["Frame", new Map([...EVALUATES, ["$$eval", 3]])],
  ["Locator", new Map([...EVALUATES, ["evaluateAll", 2]])],
  ["JSHandle", EVALUATES],
  ["ElementHandle", EVALUATES],
]);

const withMainWorld = (args: unknown[], flagAt: number) =>
  args.length > flagAt
    ? args
    : [...args, ...Array.from({ length: flagAt - args.length }, () => undefined), false];

export function mainWorldMember<Owner extends object>(
  owner: Owner,
  method: string,
): Callable<unknown> | undefined {
  const kind = kindOf(owner);
  if (kind === "Page" && method === "$$eval") {
    const frame = callMember(owner, "mainFrame", []);
    const onFrame = frame instanceof Object ? mainWorldMember(frame, method) : undefined;
    return onFrame && ((...args) => onFrame.apply(frame, args));
  }
  const flagAt = FLAG_POSITIONS.get(kind)?.get(method);
  const member = memberOf(owner, method);
  if (flagAt === undefined || !isCallable(member)) return undefined;
  return function inMainWorld(this: Page | Frame | Locator | JSHandle, ...args: unknown[]) {
    return member.apply(this, withMainWorld(args, flagAt));
  };
}
