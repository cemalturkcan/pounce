import type { Frame, FrameLocator, Locator, Page } from "playwright-core";
import { z } from "zod";
import { isCallable, isText } from "../script/wire.ts";
import { sleep, TIMED_OUT, withDeadline, withTimeout } from "../shared/async.ts";
import { errorFrom, messageOf, ToolError } from "../shared/errors.ts";
import { shownUrl } from "../shared/output.ts";
import {
  checkedLines,
  elementLabel,
  type IssuedRef,
  labelledByText,
  parseRef,
  type Place,
  type RefIdentity,
  refIdentities,
  sameElement,
} from "./ref.ts";
import type { Tab } from "./tab.ts";
import type { Engine } from "../config/config.ts";

const PLACE_MS = 10_000;
export const FRAME_PLACE_MS = 150;
const OWN_SNAPSHOT_MS = 1000;
const HIDDEN_POLL_MS = 100;
const OWN_CHECK_MS = 100;

export const REF_ENGINE = "web-agent-ref";

type AriaMarked = Element & { _ariaRef?: { ref?: string } };
type RefRegistry = { bound: Map<string, WeakRef<Element>>; first?: number };
type RefWorld = { webAgentRefs?: RefRegistry };
export function refQuery(root: Element | Document, body: string): Element[] {
  const world: typeof globalThis & RefWorld = globalThis;
  const registry: RefRegistry = (world.webAgentRefs ??= { bound: new Map() });
  const [command = "", token = "", ref = ""] = body.split(":");
  const bind = (element: AriaMarked) => {
    const shown = element["_ariaRef"]?.ref;
    if (shown !== undefined && !registry.bound.has(shown))
      registry.bound.set(shown, new WeakRef(element));
  };
  const bindAll = (scope: Document | ShadowRoot) => {
    for (const element of scope.querySelectorAll<AriaMarked>("*")) {
      bind(element);
      if (element.shadowRoot) bindAll(element.shadowRoot);
    }
  };
  if (command === "bind" || command === "own") {
    registry.first ??= Number(token);
    if (command === "own") {
      if (root instanceof Element) bind(root);
      return [];
    }
    for (const [key, element] of registry.bound) if (!element.deref()) registry.bound.delete(key);
    bindAll(document);
    return [];
  }
  if (command === "here") return [document.documentElement];
  if (registry.first === undefined || Number(token) < registry.first) return [];
  if (command === "document") return [document.documentElement];
  const element = registry.bound.get(ref)?.deref();
  if (!element?.isConnected) return [];
  const holds = (node: Node | null): boolean =>
    node === root ||
    (node !== null && holds(node instanceof ShadowRoot ? node.host : node.parentNode));
  if (!holds(element)) return [];
  const alone = function* () {
    const shadow = element.shadowRoot;
    const unmask = () => shadow && Reflect.deleteProperty(shadow, "querySelectorAll");
    let walked = false;
    if (shadow)
      Object.defineProperty(shadow, "querySelectorAll", {
        configurable: true,
        value: () => {
          unmask();
          return [];
        },
      });
    try {
      yield element;
      walked = true;
    } finally {
      if (!walked) unmask();
    }
  };
  if (command !== "self") return [element];
  const scope = element.ownerDocument.createElement("div");
  Object.defineProperty(scope, "querySelectorAll", { value: alone });
  return [scope];
}

export const refEngineSource = () => `({ queryAll: ${refQuery.toString()} })`;

function placeHere(): Place {
  return { document: performance.timeOrigin, href: location.href };
}

const isTimeout = (cause: unknown) => cause instanceof Error && cause.name === "TimeoutError";

const answeredPlace = (lookup: Promise<Place>, budget: number) =>
  withDeadline(lookup, budget).catch((cause: unknown) =>
    isTimeout(cause) ? TIMED_OUT : undefined,
  );

async function placeWithin(lookup: Promise<Place>, budget: number) {
  const place = await answeredPlace(lookup, budget);
  return place === TIMED_OUT ? undefined : place;
}

const placeOf = (locator: Locator) =>
  placeWithin(locator.evaluate(placeHere, undefined, { timeout: PLACE_MS }), PLACE_MS);

let shows = 0;

export function nextShowing() {
  shows += 1;
  return String(shows);
}

const bindIn = (scope: Page | Frame | Locator, command: string) =>
  scope
    .locator(`${REF_ENGINE}=${command}`)
    .count()
    .then(
      () => true,
      () => false,
    );

export type Shown = { place: Place; bound: Promise<boolean> };

const bindInWorld = (frame: Page | Frame, command: string) =>
  frame.evaluate(`(${refQuery.toString()})(document, ${JSON.stringify(command)}).length`).then(
    () => true,
    () => false,
  );

export async function boundPlace(frame: Page | Frame, showing: string, engine: Engine) {
  const place = await placeWithin(frame.evaluate(placeHere), PLACE_MS);
  if (!place) return undefined;
  const command = `bind:${showing}`;
  const bound = engine === "patchright" ? bindInWorld(frame, command) : bindIn(frame, command);
  return { place, bound };
}

type AiOptions = { depth?: number; boxes?: boolean; timeout?: number };

export const aiSnapshot = (scope: Page | Locator, options: AiOptions) =>
  scope.ariaSnapshot({ ...options, mode: "ai" });

function refusedRef(ref: string, why: string) {
  return new ToolError(
    `Ref ${ref} cannot be used: ${why}.`,
    "Take a new snapshot and use a ref from it.",
  );
}

const newPage = (tab: Tab) => `tab ${tab.id} loaded a new page since the snapshot it came from`;

export const refFromEarlierPage = (tab: Tab, ref: string) => refusedRef(ref, newPage(tab));

const goneRef = (ref: string, issued: IssuedRef) =>
  refusedRef(ref, `its ${elementLabel(issued)} is gone from the page`);

function changedRef(ref: string, issued: IssuedRef, now: RefIdentity) {
  if (issued.role !== now.role)
    return refusedRef(ref, `its ${elementLabel(issued)} changed its role to ${now.role}`);
  return refusedRef(
    ref,
    `its ${issued.role}'s name changed from ${JSON.stringify(issued.name)} to ${JSON.stringify(now.name)}`,
  );
}

const boundTo = (scope: Page | Frame | FrameLocator, token: string, ref: string) =>
  scope.locator(`${REF_ENGINE}=ref:${token}:${ref}`);

function frameScope(tab: Tab, issued: IssuedRef, frames: readonly string[]) {
  return frames.reduce<Page | Frame | FrameLocator>(
    (outer, frameRef) => boundTo(outer, issued.token, frameRef).contentFrame(),
    issued.frame ?? tab.page,
  );
}

export const boundRef = (tab: Tab, ref: string, issued: IssuedRef) =>
  boundTo(frameScope(tab, issued, issued.path), issued.token, ref);

export type FilterRoot = { root?: Frame };

export const filterRef = (tab: Tab, ref: string, issued: IssuedRef, root?: Frame) =>
  boundTo(root ?? tab.page, issued.token, ref);

const inFrame = (issued: IssuedRef) => issued.frameRef !== undefined || issued.frame !== undefined;

const where = (issued: IssuedRef) => (inFrame(issued) ? "its iframe" : "the page");

function silentFrame(ref: string, issued: IssuedRef) {
  return refusedRef(ref, `${where(issued)} did not answer for ${PLACE_MS / 1000} s`);
}

async function answered<T>(ref: string, issued: IssuedRef, lookup: Promise<T>) {
  return withTimeout(lookup, PLACE_MS, () => silentFrame(ref, issued));
}

const attachedCount = (locator: Locator, issued: IssuedRef) =>
  issued.frame?.isDetached() ? Promise.resolve(0) : locator.count();

type Absence = { gone: boolean; refusal: ToolError };

const gone = (ref: string, issued: IssuedRef): Absence => ({
  gone: true,
  refusal: goneRef(ref, issued),
});

const elsewhere = (refusal: ToolError): Absence => ({ gone: false, refusal });

async function absentRef(tab: Tab, ref: string, issued: IssuedRef): Promise<Absence> {
  if (issued.frame?.isDetached()) return gone(ref, issued);
  const frames = issued.path;
  const scope = frameScope(tab, issued, frames);
  const known = await answered(
    ref,
    issued,
    scope.locator(`${REF_ENGINE}=document:${issued.token}`).count(),
  );
  if (known > 0) return gone(ref, issued);
  if (frames.length === 0)
    return elsewhere(
      refusedRef(
        ref,
        issued.frame ? "its iframe loaded a new page since the snapshot" : newPage(tab),
      ),
    );
  const outer = frameScope(tab, issued, frames.slice(0, -1));
  const frame = await answered(
    ref,
    issued,
    boundTo(outer, issued.token, frames.at(-1) ?? "").count(),
  );
  return frame > 0
    ? elsewhere(refusedRef(ref, "its iframe loaded a new page since the snapshot"))
    : gone(ref, issued);
}

const unidentified = (ref: string, issued: IssuedRef) =>
  refusedRef(ref, `${where(issued)} could not be identified when the snapshot was taken`);

function movedPlace(tab: Tab, ref: string, framed: boolean, issued: Place, place: Place) {
  if (place.document !== issued.document)
    return refusedRef(
      ref,
      framed ? "its iframe loaded a new page since the snapshot" : newPage(tab),
    );
  if (place.href !== issued.href)
    return refusedRef(
      ref,
      `${framed ? "its iframe's" : "the tab's"} address changed from ${shownUrl(issued.href)} to ${shownUrl(place.href)}`,
    );
  return undefined;
}

function checkedPlace(tab: Tab, ref: string, issued: IssuedRef, place: Place | undefined) {
  if (issued.document === undefined || issued.href === undefined) return unidentified(ref, issued);
  if (place === undefined) return undefined;
  return movedPlace(
    tab,
    ref,
    inFrame(issued),
    { document: issued.document, href: issued.href },
    place,
  );
}

async function ownLine(locator: Locator) {
  try {
    const own = await aiSnapshot(locator, { depth: 1, timeout: OWN_SNAPSHOT_MS });
    return own.split("\n")[0] ?? "";
  } catch (cause) {
    return isTimeout(cause) ? undefined : errorFrom(cause);
  }
}

async function currentLine(ref: string, locator: Locator, issuedLine: string) {
  const own = await ownLine(locator);
  return own === undefined || own instanceof Error || own === ""
    ? issuedLine
    : labeledLine(own, ref);
}

const labeledLine = (line: string, ref: string) =>
  /\[ref=[^\]\s]+\]/.test(line)
    ? line.replace(/\[ref=[^\]\s]+\]/, `[ref=${ref}]`)
    : line.replace(/^(\s*- '?[a-z]+(?: "(?:[^"\\]|\\.)*")?)/, `$1 [ref=${ref}]`);

function stillIssued(tab: Tab, ref: string, issued: IssuedRef) {
  if (issued.loads !== tab.loads) throw refFromEarlierPage(tab, ref);
  const url = tab.page.url();
  if (url !== issued.url)
    throw refusedRef(
      ref,
      `the tab's address changed from ${shownUrl(issued.url)} to ${shownUrl(url)}`,
    );
}

async function attachedInPlace(
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  locator: Locator,
  goneAnswers: boolean,
) {
  stillIssued(tab, ref, issued);
  if (!(await answered(ref, issued, issued.bound))) throw unidentified(ref, issued);
  const found = await answered(ref, issued, attachedCount(locator, issued));
  if (found === 0) {
    const absence = await absentRef(tab, ref, issued);
    if (goneAnswers && absence.gone) return false;
    throw absence.refusal;
  }
  const refused = checkedPlace(tab, ref, issued, await placeOf(locator));
  if (refused) throw refused;
  return true;
}

type AriaRole = Parameters<Page["getByRole"]>[0];

const ariaRole = z.custom<AriaRole>(isText);

const NOT_GENERIC = z
  .array(ariaRole)
  .parse([
    "alert",
    "alertdialog",
    "application",
    "article",
    "banner",
    "blockquote",
    "button",
    "caption",
    "cell",
    "checkbox",
    "code",
    "columnheader",
    "combobox",
    "complementary",
    "contentinfo",
    "definition",
    "deletion",
    "dialog",
    "directory",
    "document",
    "emphasis",
    "feed",
    "figure",
    "form",
    "grid",
    "gridcell",
    "group",
    "heading",
    "img",
    "insertion",
    "link",
    "list",
    "listbox",
    "listitem",
    "log",
    "main",
    "mark",
    "marquee",
    "math",
    "meter",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "navigation",
    "none",
    "note",
    "option",
    "paragraph",
    "presentation",
    "progressbar",
    "radio",
    "radiogroup",
    "region",
    "row",
    "rowgroup",
    "rowheader",
    "scrollbar",
    "search",
    "searchbox",
    "separator",
    "slider",
    "spinbutton",
    "status",
    "strong",
    "subscript",
    "superscript",
    "switch",
    "tab",
    "table",
    "tablist",
    "tabpanel",
    "term",
    "textbox",
    "time",
    "timer",
    "toolbar",
    "tooltip",
    "tree",
    "treegrid",
    "treeitem",
  ]);

const anyRoleOf = (self: Locator) =>
  NOT_GENERIC.map((role) => self.getByRole(role, { includeHidden: true })).reduce((all, one) =>
    all.or(one),
  );

function sameProbe(
  scope: Page | Frame | FrameLocator,
  ref: string,
  issued: IssuedRef,
  shown: boolean,
  hiddenByRole: boolean,
) {
  const own = boundTo(scope, issued.token, ref);
  const seen = (probe: Locator) => (shown ? probe.filter({ visible: true }) : probe);
  if (issued.role === "iframe") return seen(own);
  const self = scope.locator(`${REF_ENGINE}=self:${issued.token}:${ref}`);
  if (issued.role === "generic") return seen(own.filter({ hasNot: anyRoleOf(self) }));
  const role = ariaRole.safeParse(issued.role);
  if (!role.success) return undefined;
  const named = issued.name ? { name: issued.name, exact: true } : {};
  const visible = own.filter({ has: self.getByRole(role.data, named) });
  if (shown) return visible;
  const hidden = own.filter({
    has: self.getByRole(
      role.data,
      hiddenByRole ? { includeHidden: true } : { ...named, includeHidden: true },
    ),
  });
  return visible.or(
    (hiddenByRole ? hidden : hidden.filter({ visible: false })).filter({
      hasNot: self.getByRole(role.data),
    }),
  );
}

export const probedRef = (
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  shown: boolean,
  filter?: FilterRoot,
) =>
  sameProbe(
    filter ? (filter.root ?? tab.page) : frameScope(tab, issued, issued.path),
    ref,
    issued,
    shown,
    true,
  );

export const confirmedByName = (issued: IssuedRef) => issued.role !== "generic" || !issued.name;

type Matched = Place & { hidden: boolean; ownName?: string };

function matchedPlace(element: Element): Matched | undefined {
  if (element === element.ownerDocument.documentElement) return undefined;
  const place = {
    document: performance.timeOrigin,
    href: location.href,
    hidden: !element.checkVisibility({ visibilityProperty: true }),
  };
  if (element.hasAttribute("role") || element.hasAttribute("aria-labelledby")) return place;
  const label = element.getAttribute("aria-label") ?? "";
  const named = label.trim() ? label : (element.getAttribute("title") ?? "");
  return {
    ...place,
    ownName: named
      .replace(/[\u200b\u00ad]/g, "")
      .trim()
      .replace(/\s+/g, " "),
  };
}

type NameExpectation = {
  expectedText: { string: string; normalizeWhiteSpace: boolean }[];
  isNot: boolean;
  timeout: number;
};

type ExpectingLocator = Locator & {
  _expect: (expression: string, options: NameExpectation) => Promise<{ matches: boolean }>;
};

const expecting = z.custom<ExpectingLocator>(
  (value) => value instanceof Object && "_expect" in value && isCallable(value["_expect"]),
);

async function hasOwnName(
  probe: Locator,
  issued: IssuedRef,
  matched: Matched,
  hiddenByRole: boolean,
) {
  if (issued.role !== "generic" || !issued.name) return true;
  if (matched.ownName === issued.name || (hiddenByRole && matched.hidden)) return true;
  const expecter = expecting.safeParse(probe).data;
  if (!expecter) return false;
  const outcome = await expecter["_expect"]("to.have.accessible.name", {
    expectedText: [{ string: issued.name, normalizeWhiteSpace: true }],
    isNot: false,
    timeout: OWN_CHECK_MS,
  }).catch(() => undefined);
  return outcome?.matches === true;
}

async function sameInPlace(
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  shown: boolean,
  hiddenByRole = false,
) {
  const scope = frameScope(tab, issued, issued.path);
  const probe = sameProbe(scope, ref, issued, shown, hiddenByRole);
  if (!probe) return false;
  const matched = await probe
    .or(scope.locator(`${REF_ENGINE}=document:${issued.token}`))
    .last()
    .evaluate(matchedPlace, undefined, { timeout: OWN_CHECK_MS })
    .catch(() => undefined);
  if (matched === undefined || checkedPlace(tab, ref, issued, matched) !== undefined) return false;
  return hasOwnName(probe, issued, matched, hiddenByRole);
}

async function sameShownLine(ref: string, issued: IssuedRef, locator: Locator) {
  const line = await ownLine(locator);
  if (line === undefined || line instanceof Error || line === "") return line;
  const labeled = labeledLine(line, ref);
  const now = refIdentities(labeled).get(ref) ?? { role: "", name: "", line: labeled };
  if (!sameElement(issued, now)) throw changedRef(ref, issued, now);
  return labeled;
}

async function shownLine(tab: Tab, ref: string, issued: IssuedRef, locator: Locator) {
  stillIssued(tab, ref, issued);
  if (await sameInPlace(tab, ref, issued, true)) return issued.line;
  await attachedInPlace(tab, ref, issued, locator, false);
  const line = await sameShownLine(ref, issued, locator);
  return line instanceof Error ? "" : (line ?? "");
}

export type RefQuestion = "read" | "named" | "presence" | "attached";

const byName = (question: RefQuestion) => question === "read" || question === "named";

function hiddenRefused(ref: string, issued: IssuedRef, question: RefQuestion) {
  return byName(question)
    ? unconfirmedRef(ref, issued, "is hidden, so its name cannot be checked")
    : unconfirmedRef(ref, issued, `is hidden and is no longer a ${issued.role}`);
}

export async function checkRefIdentity(
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  question: RefQuestion,
) {
  const goneAnswers = question === "presence" || question === "named";
  stillIssued(tab, ref, issued);
  if (await sameInPlace(tab, ref, issued, false, !byName(question))) return;
  const locator = boundRef(tab, ref, issued);
  if (!(await attachedInPlace(tab, ref, issued, locator, goneAnswers))) return;
  const line = await sameShownLine(ref, issued, locator);
  if (line === "") throw hiddenRefused(ref, issued, question);
  if (line === undefined)
    throw unconfirmedRef(ref, issued, `did not answer within ${OWN_SNAPSHOT_MS / 1000} s`);
  if (line instanceof Error) {
    if (!(await attachedInPlace(tab, ref, issued, locator, goneAnswers))) return;
    throw unconfirmedRef(ref, issued, `could not be read (${messageOf(line).split("\n")[0]})`);
  }
}

function unconfirmedRef(ref: string, issued: IssuedRef, why: string) {
  return new ToolError(
    `Ref ${ref} cannot be used: its ${elementLabel(issued)} ${why}.`,
    "Read it through a selector, or take a new snapshot once it shows and use a ref from it.",
  );
}

function hiddenRef(ref: string, issued: IssuedRef, timeout: number) {
  return new ToolError(
    `Ref ${ref}'s ${elementLabel(issued)} stayed hidden or ignored the pointer for ${timeout / 1000} s.`,
    "Take a snapshot to see the page now, then retry with a longer timeout or another ref.",
  );
}

async function untilShown(
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  locator: Locator,
  deadline: number,
  timeout: number,
): Promise<string> {
  const line = await shownLine(tab, ref, issued, locator);
  if (line) return line;
  if (Date.now() >= deadline) throw hiddenRef(ref, issued, timeout);
  await sleep(HIDDEN_POLL_MS);
  return untilShown(tab, ref, issued, locator, deadline, timeout);
}

export async function confirmRef(
  tab: Tab,
  ref: string,
  issued: IssuedRef,
  timeout: number,
  deadline = Date.now() + timeout,
) {
  const locator = boundRef(tab, ref, issued);
  const line = await untilShown(tab, ref, issued, locator, deadline, timeout);
  checkedLines.set(
    locator,
    line === issued.line && labelledByText(line) ? await currentLine(ref, locator, line) : line,
  );
  return locator;
}

const insidePlace = (iframe: Locator, budget: number) =>
  placeWithin(
    iframe
      .contentFrame()
      .locator(`${REF_ENGINE}=here`)
      .evaluate(placeHere, undefined, { timeout: budget }),
    budget,
  );

export async function checkInsideFrame(tab: Tab, ref: string, issued: IssuedRef) {
  if (!issued.content)
    throw refusedRef(ref, "its iframe's page could not be identified when the snapshot was taken");
  const place = await insidePlace(boundRef(tab, ref, issued), PLACE_MS);
  const refused = place && movedPlace(tab, ref, true, issued.content, place);
  if (refused) throw refused;
}

export async function refBound(ref: string, issued: IssuedRef) {
  if (!(await answered(ref, issued, issued.bound))) throw unidentified(ref, issued);
}

async function ownerFrame(locator: Locator) {
  const handle = await locator.elementHandle({ timeout: OWN_SNAPSHOT_MS });
  try {
    return (await handle.ownerFrame()) ?? undefined;
  } finally {
    await handle.dispose();
  }
}

export async function rememberShownRef(tab: Tab, locator: Locator, line: string) {
  const ref = parseRef(/\[ref=([^\]\s]+)\]/.exec(line)?.[1] ?? "");
  if (!ref || tab.refs.has(ref)) return;
  const loads = tab.loads;
  const url = tab.page.url();
  const token = nextShowing();
  const bound = bindIn(locator, `own:${token}`);
  const identity = refIdentities(line).get(ref);
  const [place, frame, content] = await Promise.all([
    placeOf(locator),
    ref.startsWith("f") ? ownerFrame(locator).catch(() => undefined) : undefined,
    identity?.role === "iframe" ? insidePlace(locator, FRAME_PLACE_MS) : undefined,
  ]);
  if (!place || !identity || tab.loads !== loads) return;
  if (ref.startsWith("f") && !frame) return;
  const issued: IssuedRef = {
    ...identity,
    loads,
    url,
    document: place.document,
    href: place.href,
    token,
    path: [],
    bound,
  };
  if (frame) issued.frame = frame;
  if (content) issued.content = content;
  tab.refs.set(ref, issued);
}
