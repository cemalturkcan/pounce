import type { Locator, Page } from "playwright-core";
import type { Point, PointerState, Tab } from "../browser/tab.ts";
import { emulatedViewport } from "../browser/emulate.ts";
import { inSequence, repeatUntil, sleep, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { pageBound } from "./bound.ts";
import { isTimeout } from "./page.ts";
import { checkpoint } from "../shared/call-scope.ts";
import {
  CLOSED_HINT,
  closedAfterInput,
  closedTarget,
  CoveredByOwnLabel,
  errorFrom,
  interceptingElement,
  timedOutWithin,
  ToolError,
} from "../shared/errors.ts";

export type { Point } from "../browser/tab.ts";
export type Random = () => number;
type Box = { x: number; y: number; width: number; height: number };
type Viewport = { width: number; height: number };
type MouseButton = "left" | "right" | "middle";
type Modifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

const FRAME_MS = 1000 / 60;

const between = (random: Random, min: number, max: number) => min + random() * (max - min);
const noise = (random: Random, scale: number) => (random() + random() + random() - 1.5) * scale;
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const round1 = (value: number) => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const along = (a: number, b: number, c: number, d: number) =>
    u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  return { x: along(p0.x, p1.x, p2.x, p3.x), y: along(p0.y, p1.y, p2.y, p3.y) };
}

export function trajectory(from: Point, to: Point, random: Random = Math.random) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return [];
  const duration = Math.min(
    (70 + 90 * Math.log2(distance / 40 + 1)) * between(random, 0.85, 1.2),
    700,
  );
  const normal = { x: -dy / distance, y: dx / distance };
  const bow = (random() < 0.5 ? -1 : 1) * between(random, 0.04, 0.18) * distance;
  const first = between(random, 0.2, 0.35);
  const second = between(random, 0.65, 0.8);
  const c1 = { x: from.x + dx * first + normal.x * bow, y: from.y + dy * first + normal.y * bow };
  const c2 = {
    x: from.x + dx * second + normal.x * bow * 0.6,
    y: from.y + dy * second + normal.y * bow * 0.6,
  };
  const overshoot = distance > 250 && random() < 0.25;
  const beyond = overshoot ? between(random, 4, 12) : 0;
  const end = { x: to.x + (dx / distance) * beyond, y: to.y + (dy / distance) * beyond };
  const steps: { point: Point; delay: number }[] = [];
  let elapsed = 0;
  while (elapsed < duration) {
    const delay = between(random, 8, 17);
    elapsed = Math.min(elapsed + delay, duration);
    const progress = minimumJerk(elapsed / duration);
    const point = bezier(from, c1, c2, end, progress);
    const tremor = (1 - progress) * 0.9;
    steps.push({
      point: { x: point.x + noise(random, tremor), y: point.y + noise(random, tremor) },
      delay,
    });
  }
  if (overshoot) {
    const back = Math.max(Math.round(between(random, 4, 7)), 3);
    for (let index = 1; index <= back; index += 1) {
      const progress = minimumJerk(index / back);
      steps.push({
        point: { x: end.x + (to.x - end.x) * progress, y: end.y + (to.y - end.y) * progress },
        delay: between(random, 10, 18),
      });
    }
  }
  steps.pop();
  return steps.map(({ point, delay }) => ({
    point: { x: round1(point.x), y: round1(point.y) },
    delay,
  }));
}

const upper = (size: number | undefined) =>
  size === undefined ? Number.POSITIVE_INFINITY : Math.max(size - 1, 0);
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const centeringOffset = (start: number, size: number, visible: number) =>
  start >= 0 && start + size <= visible ? 0 : start + size / 2 - visible / 2;

export function clampPoint(point: Point, viewport: Viewport | undefined): Point {
  return {
    x: clamp(point.x, 0, upper(viewport?.width)),
    y: clamp(point.y, 0, upper(viewport?.height)),
  };
}

export function glide(dx: number, dy: number, random: Random = Math.random): Point[] {
  const distance = Math.hypot(dx, dy);
  if (distance < 40) return [{ x: dx, y: dy }];
  const frames = Math.max(
    Math.round((Math.min(140 + distance * 0.45, 650) * between(random, 0.85, 1.15)) / FRAME_MS),
    4,
  );
  return Array.from({ length: frames }, (_value, index) => {
    const share = easeOut((index + 1) / frames) - easeOut(index / frames);
    return { x: dx * share, y: dy * share };
  });
}

export function aimAt(state: PointerState, box: Box, random: Random = Math.random): Point {
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const kept = state.aim;
  const aim =
    kept && Math.hypot(kept.x - center.x, kept.y - center.y) < 1
      ? kept
      : { ...center, dx: noise(random, 2.2), dy: noise(random, 1.6) };
  state.aim = aim;
  const insetX = Math.min(1, box.width / 2);
  const insetY = Math.min(1, box.height / 2);
  return {
    x: round1(clamp(center.x + aim.dx, box.x + insetX, box.x + box.width - insetX)),
    y: round1(clamp(center.y + aim.dy, box.y + insetY, box.y + box.height - insetY)),
  };
}

export function startPoint(
  pointer: Point | undefined,
  to: Point,
  viewport: Viewport | undefined,
  random: Random = Math.random,
) {
  return clampPoint(
    pointer ?? { x: to.x + between(random, -260, 260), y: to.y + between(random, -180, 180) },
    viewport,
  );
}

export const settleDelay = (sinceArrived: number, random: Random = Math.random) =>
  between(random, 45, 130) - Math.min(sinceArrived, 1000);

export const holdDelay = (sincePressed: number, random: Random = Math.random) =>
  between(random, 60, 140) - sincePressed;

export const keyGap = (sinceLastKey: number, random: Random = Math.random) =>
  sinceLastKey < 1000 ? between(random, 30, 110) - sinceLastKey : 0;

export const keyHold = (random: Random = Math.random) => between(random, 20, 70);

const stateOf = (tab: Tab) => (tab.humanInput ??= {});
const since = (at: number | undefined) =>
  at === undefined ? Number.POSITIVE_INFINITY : Date.now() - at;
const pause = async (ms: number) => {
  if (ms > 0) await sleep(ms);
};

export function viewportOf(page: Page): Promise<Viewport> {
  const size = emulatedViewport(page) ?? page.viewportSize();
  if (size) return Promise.resolve(size);
  return pageBound(
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
    "Reading the window size",
  );
}

async function moveTo(tab: Tab, to: Point) {
  const state = stateOf(tab);
  const { mouse } = tab.page;
  const viewport = await viewportOf(tab.page);
  const start = startPoint(state.pointer, to, viewport);
  if (!state.pointer) await mouse.move(start.x, start.y);
  await inSequence(trajectory(start, to), async ({ point, delay }) => {
    checkpoint();
    await sleep(delay);
    const next = clampPoint(point, viewport);
    await mouse.move(next.x, next.y);
  });
  await mouse.move(to.x, to.y);
  state.pointer = to;
  state.arrivedAt = Date.now();
}

const READY_TIMEOUT_MS = 8000;

type AimOutcome = { point: Point } | { problem: string };

export async function aimWithin(
  limit: number,
  attempt: (remaining: () => number) => Promise<AimOutcome>,
) {
  const deadline = Date.now() + limit;
  const remaining = () => Math.max(deadline - Date.now(), 1);
  let problem = "";
  let outOfTime = false;
  const aim = await repeatUntil(
    async () => {
      const outcome = await attempt(remaining).catch((cause: unknown) => {
        if (!isTimeout(cause)) throw cause;
        if (!problem) throw timedOutWithin(cause, limit);
        outOfTime = true;
        return undefined;
      });
      if (outcome && "point" in outcome) return outcome.point;
      if (outcome) problem = outcome.problem;
      return undefined;
    },
    { delayMs: () => 100, giveUp: () => outOfTime || Date.now() >= deadline },
  );
  if (!aim) throw new Error(`Timeout ${limit}ms exceeded waiting for the element.\n  - ${problem}`);
  return aim;
}

function readyAim(tab: Tab, locator: Locator, timeout: number | undefined, needsEnabled: boolean) {
  return aimWithin(timeout ?? READY_TIMEOUT_MS, async (remaining): Promise<AimOutcome> => {
    await locator.scrollIntoViewIfNeeded({ timeout: remaining() });
    if (needsEnabled && !(await locator.isEnabled({ timeout: remaining() })))
      return { problem: "element is not enabled" };
    const box = await locator.boundingBox({ timeout: remaining() });
    if (!box) return { problem: "element is not visible" };
    const point = aimAt(stateOf(tab), box);
    const covering = await locator.evaluate(
      (element, offset) => {
        const rect = element.getBoundingClientRect();
        const root = element.getRootNode();
        const scope = root instanceof ShadowRoot ? root : element.ownerDocument;
        const hit = scope.elementFromPoint(rect.left + offset.x, rect.top + offset.y);
        if (!hit || hit === element || element.contains(hit)) return "";
        if (hit.closest("label")?.control === element) return "";
        const attributes = ["id", "class", "for", "role", "aria-label"]
          .map((name) => [name, hit.getAttribute(name)] as const)
          .filter(([, value]) => value)
          .map(([name, value]) => ` ${name}="${value}"`)
          .join("");
        return `<${hit.tagName.toLowerCase()}${attributes}>`;
      },
      { x: point.x - box.x, y: point.y - box.y },
      { timeout: remaining() },
    );
    if (covering) return { problem: `${covering} intercepts pointer events` };
    return { point };
  });
}

async function pressDown(tab: Tab, button: MouseButton, clickCount: number, sending: () => void) {
  const state = stateOf(tab);
  await pause(settleDelay(since(state.arrivedAt)));
  sending();
  await tab.page.mouse.down({ button, clickCount });
  state.pressedAt = Date.now();
}

async function release(tab: Tab, button: MouseButton, clickCount: number) {
  const state = stateOf(tab);
  await pause(holdDelay(since(state.pressedAt)));
  await tab.page.mouse.up({ button, clickCount });
  state.arrivedAt = Date.now();
}

async function withModifiers(page: Page, modifiers: Modifier[], action: () => Promise<void>) {
  await inSequence(modifiers, (modifier) => page.keyboard.down(modifier));
  try {
    await action();
  } finally {
    await inSequence(modifiers.toReversed(), (modifier) => page.keyboard.up(modifier));
  }
}

const CENTER_PROBE_MS = 1000;

async function rememberCenter(tab: Tab, locator: Locator) {
  const box = await withDeadline(
    locator
      .count()
      .then((count) => (count === 1 ? locator.boundingBox({ timeout: CENTER_PROBE_MS }) : null)),
    CENTER_PROBE_MS,
  ).catch(() => null);
  stateOf(tab).pointer =
    box && box !== TIMED_OUT ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : undefined;
}

function ownLabelAtCenter(element: Element, covering: string) {
  const labels = "labels" in element && element.labels instanceof NodeList ? element.labels : [];
  const box = element.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  const shown = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(covering)?.[1] ?? "";
  const preview = {
    agrees(expected: string, actual: string) {
      return (
        actual === expected || (expected.endsWith("…") && actual.startsWith(expected.slice(0, -1)))
      );
    },
  };
  const isCovering =
    hit !== null &&
    !element.contains(hit) &&
    /^<([\w-]+)/.exec(covering)?.[1]?.toLowerCase() === hit.localName &&
    preview.agrees(shown("id"), hit.getAttribute("id") ?? "") &&
    preview.agrees(shown("class"), hit.getAttribute("class") ?? "");
  const own = [...labels].find((label) => isCovering && label.contains(hit));
  if (!(own instanceof Element)) return undefined;
  const attributes = [...own.attributes]
    .filter((attribute) => attribute.name !== "style")
    .map((attribute) => ` ${attribute.name}="${attribute.value}"`)
    .join("");
  return `<label${attributes}>…</label>`;
}

export async function explainIntercept(locator: Locator, cause: unknown) {
  const error = errorFrom(cause);
  const covering = interceptingElement(error.message);
  if (!covering) return error;
  const label = await locator
    .evaluate(ownLabelAtCenter, covering, { timeout: CENTER_PROBE_MS })
    .catch(() => undefined);
  return label ? new CoveredByOwnLabel(error, label) : error;
}

export async function mayClosePage(
  page: Pick<Page, "isClosed">,
  input: (sending: () => void) => Promise<void>,
) {
  const openBefore = !page.isClosed();
  let sent = false;
  try {
    await input(() => {
      sent ||= !page.isClosed();
    });
  } catch (cause) {
    if (!openBefore || !page.isClosed() || !closedTarget(cause)) throw cause;
    if (sent || closedAfterInput(cause)) return;
    throw new ToolError("The tab closed before the input was sent.", CLOSED_HINT);
  }
}

export async function plainClick(
  tab: Tab,
  locator: Locator,
  options: Parameters<Locator["click"]>[0] = {},
) {
  await mayClosePage(tab.page, () =>
    locator.click({ ...options, noWaitAfter: true }).catch(async (cause: unknown) => {
      throw await explainIntercept(locator, cause);
    }),
  );
  await rememberCenter(tab, locator);
}

type ClickOptions = { button?: MouseButton; clickCount?: number; modifiers?: Modifier[] };

export async function plainClickAt(tab: Tab, point: Point, options: ClickOptions = {}) {
  await mayClosePage(tab.page, (sending) =>
    withModifiers(tab.page, options.modifiers ?? [], () => {
      sending();
      return tab.page.mouse.click(point.x, point.y, {
        button: options.button ?? "left",
        clickCount: options.clickCount ?? 1,
      });
    }),
  );
  stateOf(tab).pointer = point;
}

export async function plainHover(tab: Tab, locator: Locator) {
  await mayClosePage(tab.page, () => locator.hover());
  await rememberCenter(tab, locator);
}

export async function plainHoverAt(tab: Tab, point: Point) {
  await mayClosePage(tab.page, (sending) => {
    sending();
    return tab.page.mouse.move(point.x, point.y);
  });
  stateOf(tab).pointer = point;
}

export async function plainDrag(tab: Tab, source: Locator, destination: Locator) {
  await mayClosePage(tab.page, () => source.dragTo(destination));
  await rememberCenter(tab, destination);
}

export async function humanClick(
  tab: Tab,
  locator: Locator,
  options: ClickOptions & { timeout?: number } = {},
) {
  await humanClickAt(tab, await readyAim(tab, locator, options.timeout, true), options);
}

export async function humanClickAt(tab: Tab, point: Point, options: ClickOptions = {}) {
  const button = options.button ?? "left";
  await mayClosePage(tab.page, async (sending) => {
    await moveTo(tab, point);
    await withModifiers(tab.page, options.modifiers ?? [], async () => {
      await inSequence(
        Array.from({ length: options.clickCount ?? 1 }, (_value, index) => index + 1),
        async (clickCount) => {
          checkpoint();
          await pressDown(tab, button, clickCount, sending);
          await release(tab, button, clickCount);
        },
      );
    });
  });
}

export async function humanHover(tab: Tab, locator: Locator, timeout?: number) {
  await humanHoverAt(tab, await readyAim(tab, locator, timeout, false));
}

export async function humanHoverAt(tab: Tab, point: Point) {
  await mayClosePage(tab.page, (sending) => {
    sending();
    return moveTo(tab, point);
  });
}

export async function humanDrag(tab: Tab, source: Locator, destination: Locator) {
  await humanHover(tab, source);
  checkpoint();
  await mayClosePage(tab.page, async (sending) => {
    await pressDown(tab, "left", 1, sending);
    try {
      await moveTo(tab, await readyAim(tab, destination, undefined, false));
      await pause(settleDelay(0));
    } finally {
      await release(tab, "left", 1);
    }
  });
}

export async function humanPress(tab: Tab, key: string) {
  const state = stateOf(tab);
  checkpoint();
  await pause(keyGap(since(state.lastKeyAt)));
  await mayClosePage(tab.page, (sending) => {
    sending();
    return tab.page.keyboard.press(key, { delay: keyHold() });
  });
  state.lastKeyAt = Date.now();
}

export async function humanType(tab: Tab, text: string) {
  const state = stateOf(tab);
  await mayClosePage(tab.page, async (sending) => {
    await inSequence([...text], async (character) => {
      checkpoint();
      await pause(keyGap(since(state.lastKeyAt)));
      sending();
      await tab.page.keyboard.type(character, { delay: keyHold() });
      state.lastKeyAt = Date.now();
    });
  });
}

export async function humanReplaceText(tab: Tab, locator: Locator, text: string, timeout?: number) {
  await humanClick(tab, locator, { timeout });
  await humanPress(tab, "ControlOrMeta+a");
  await humanPress(tab, "Backspace");
  await humanType(tab, text);
}

export async function humanWheel(tab: Tab, dx: number, dy: number) {
  const state = stateOf(tab);
  await mayClosePage(tab.page, async (sending) => {
    if (!state.pointer) {
      const viewport = await viewportOf(tab.page);
      await moveTo(tab, {
        x: round1(viewport.width * between(Math.random, 0.3, 0.7)),
        y: round1(viewport.height * between(Math.random, 0.3, 0.7)),
      });
    }
    await inSequence(glide(dx, dy), async (frame, index) => {
      checkpoint();
      if (index) await sleep(FRAME_MS);
      sending();
      await tab.page.mouse.wheel(frame.x, frame.y);
    });
  });
}

export async function plainWheel(tab: Tab, dx: number, dy: number) {
  await mayClosePage(tab.page, (sending) => {
    sending();
    return tab.page.mouse.wheel(dx, dy);
  });
}

export async function humanScrollIntoView(tab: Tab, locator: Locator) {
  const box = await locator.boundingBox();
  if (box) {
    const viewport = await viewportOf(tab.page);
    const dx = centeringOffset(box.x, box.width, viewport.width);
    const dy = centeringOffset(box.y, box.height, viewport.height);
    if (dx || dy) await humanWheel(tab, dx, dy);
  }
  await locator.scrollIntoViewIfNeeded();
}

function documentScrollPoint(page: Page) {
  return pageBound(
    page.evaluate(() => {
      const layout = {
        scrollsInside(element: Element) {
          for (
            let node: Element | null = element;
            node && node !== document.documentElement && node !== document.body;
            node = node.parentElement
          ) {
            const style = getComputedStyle(node);
            const overflows = /auto|scroll|overlay/.test(`${style.overflowX} ${style.overflowY}`);
            if (
              overflows &&
              (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
            )
              return true;
          }
          return false;
        },
      };
      for (const down of [0.5, 0.25, 0.75, 0.9, 0.1])
        for (const across of [0.5, 0.25, 0.75]) {
          const point = { x: window.innerWidth * across, y: window.innerHeight * down };
          const hit = document.elementFromPoint(point.x, point.y);
          if (hit && hit.tagName !== "IFRAME" && !layout.scrollsInside(hit)) return point;
        }
      return undefined;
    }),
    "scroll",
  );
}

function distanceToEnd(page: Page, toBottom: boolean) {
  return pageBound(
    page.evaluate(
      (bottom) =>
        bottom
          ? document.documentElement.scrollHeight - window.scrollY - window.innerHeight
          : -window.scrollY,
      toBottom,
    ),
    "scroll",
  );
}

export async function humanScrollToEnd(tab: Tab, toBottom: boolean) {
  const distance = await distanceToEnd(tab.page, toBottom);
  if (!distance) return 0;
  const point = await documentScrollPoint(tab.page);
  if (point) {
    await moveTo(tab, point);
    await humanWheel(tab, 0, distance);
  }
  if (Math.abs(await distanceToEnd(tab.page, toBottom)) > 1)
    await pageBound(
      tab.page.evaluate(
        (bottom) => window.scrollTo(0, bottom ? document.documentElement.scrollHeight : 0),
        toBottom,
      ),
      "scroll",
    );
  return Math.round(Math.abs(await distanceToEnd(tab.page, toBottom)));
}
