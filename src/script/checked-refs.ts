import type { Frame, Locator } from "playwright-core";
import { z } from "zod";
import { ACTION_TIMEOUT_MS, type BrowserManager } from "../browser/manager.ts";
import { type IssuedRef, parseRef } from "../browser/ref.ts";
import { confirmedByName, type FilterRoot, type RefQuestion } from "../browser/ref-check.ts";
import { inSequence, sleep } from "../shared/async.ts";
import type { Tab } from "../browser/tab.ts";
import { callMember, memberOf } from "./host.ts";
import { mainWorldMember } from "./main-world.ts";
import { type Callable, isCallable } from "./wire.ts";
import { messageOf, timedOutWithin, ToolError } from "../shared/errors.ts";

const DERIVING = new Set([
  "and",
  "contentFrame",
  "describe",
  "filter",
  "first",
  "frameLocator",
  "getByAltText",
  "getByLabel",
  "getByPlaceholder",
  "getByRole",
  "getByTestId",
  "getByText",
  "getByTitle",
  "last",
  "locator",
  "nth",
  "or",
  "owner",
  "visible",
  "within",
]);

const UNCHECKED = new Set(["description", "page", "toString"]);

const READS = new Set([
  "all",
  "allInnerTexts",
  "allTextContents",
  "ariaSnapshot",
  "ariaSnapshotJSON",
  "boundingBox",
  "evaluate",
  "evaluateAll",
  "getAttribute",
  "innerHTML",
  "innerText",
  "inputValue",
  "isChecked",
  "isDisabled",
  "isEditable",
  "isEnabled",
  "textContent",
]);

const PRESENCE = new Set(["count", "isHidden", "isVisible"]);

const LISTED = new Map<string, (args: unknown[]) => unknown[]>([
  ["evaluateAll", (args) => args],
  [
    "allTextContents",
    () => [(elements: Element[]) => elements.map((one) => one.textContent ?? "")],
  ],
  ["allInnerTexts", () => [(elements: HTMLElement[]) => elements.map((one) => one.innerText)]],
]);

async function evaluatedAll(locator: Locator, args: unknown[]) {
  const handles = await locator.elementHandles();
  const [first] = handles;
  if (!first) return callMember(locator, "evaluateAll", args);
  try {
    const list = await first.evaluateHandle((_, all) => all, handles);
    try {
      return await callMember(list, "evaluate", args);
    } finally {
      await list.dispose();
    }
  } finally {
    await Promise.all(handles.map((handle) => handle.dispose()));
  }
}

const chained = z.custom<Locator>((value) => value instanceof Object);
const locatorList = z.array(chained);

const UNCHECKABLE = new Set(["elementHandle", "elementHandles", "evaluateHandle", "normalize"]);

const SHOWN_POLL_MS = 100;

const waitOptions = z.looseObject({});
const endless = z.object({ timeout: z.literal(0) });

const timed = z.object({ timeout: z.number().positive() });
const waiting = z.object({ state: z.enum(["attached", "detached", "visible", "hidden"]) });
const ABSENT = new Set(["hidden", "detached"]);

const joined = z.object({ has: z.unknown().optional(), hasNot: z.unknown().optional() });
const joinedOptions = z.looseObject({
  has: z.unknown().optional(),
  hasNot: z.unknown().optional(),
});
const OPTIONS_AT = new Map([
  ["filter", 0],
  ["locator", 1],
]);

const TAKES_LOCATOR = new Set(["and", "dragTo", "filter", "locator", "or"]);

const JOINS = new Set(["and", "locator", "or"]);

const located = z
  .object({
    _frame: z.custom<Frame>((value) => value instanceof Object),
    _selector: z.string(),
  })
  .transform((locator) => ({ frame: locator["_frame"], selector: locator["_selector"] }));

const ENTER_FRAME = "internal:control=enter-frame";

const framesEntered = (selector: string) => selector.split(ENTER_FRAME).length - 1;

type ScriptRef = {
  tab: Tab;
  ref: string;
  issued: IssuedRef;
  inside?: boolean;
  alternative?: RefQuestion;
};

type Variant = "shown" | "present" | FilterRoot;

type Step = { owner: object; method: string; args: unknown[] };

const isAlternative = (check: ScriptRef) => check.alternative !== undefined;

const timeoutOf = (args: unknown[]) =>
  timed.safeParse(args.at(-1)).data?.timeout ?? ACTION_TIMEOUT_MS;

const stateOf = (method: string, args: unknown[]) =>
  method === "waitFor" ? waiting.safeParse(args[0]).data?.state : undefined;

const askedOf = (check: ScriptRef, question: RefQuestion): RefQuestion =>
  question === "read" && check.alternative === "presence"
    ? "named"
    : (check.alternative ?? question);

const memberQuestion = (check: ScriptRef): RefQuestion =>
  check.alternative ?? (confirmedByName(check.issued) ? "presence" : "named");

const asMembers = (checks: ScriptRef[]) =>
  checks.map((check) => ({ ...check, alternative: memberQuestion(check) }));

const kept = (checks: ScriptRef[]) => checks;

const asExcluded = (checks: ScriptRef[]) =>
  checks.map((check): ScriptRef => ({ ...check, alternative: "named" }));

function uncheckableRefused(method: string) {
  return new ToolError(
    `${method} is not available on a ref's locator, since what it returns would skip the ref's checks. Use the ref itself: its actions and reads check its element first.`,
  );
}

const placeKnown = (issued: IssuedRef) =>
  issued.document !== undefined && issued.href !== undefined;

export const sameDocument = (one: IssuedRef, other: IssuedRef) =>
  placeKnown(one) && one.document === other.document && one.href === other.href;

function framesRefused(one: ScriptRef, other: ScriptRef, method: string) {
  const unknown = [one, other].find((check) => !placeKnown(check.issued));
  const refused = `Refs ${one.ref} and ${other.ref} cannot be joined with ${method}()`;
  if (!unknown && one.issued.document === other.issued.document)
    return new ToolError(
      `${refused}: their frame changed its address between the snapshots or actions that gave them.`,
      "Take a new snapshot and use refs from it.",
    );
  const reason = unknown
    ? `the frame of ${unknown.ref} could not be identified when the snapshot was taken`
    : "they are in different frames";
  return new ToolError(
    `${refused}: ${reason}. Use refs from one frame on both sides of ${method}().`,
  );
}

const PLAYWRIGHT_FRAMES = "Locators must belong to the same frame.";

const OWN_FRAME_HINT =
  "Join it with refs of the same frame, or with a locator that starts in the ref's own frame.";

function locatorFrameRefused(check: ScriptRef, method: string) {
  const place = check.issued.frame
    ? "an action showed the ref inside an iframe, and the locator starts from another frame"
    : "the ref is in the page, and the locator starts from an iframe";
  return new ToolError(
    `Ref ${check.ref} cannot be joined with that locator in ${method}(): ${place}.`,
    OWN_FRAME_HINT,
  );
}

function snapshotFrameRefused(check: ScriptRef, method: string) {
  return new ToolError(
    `Ref ${check.ref} cannot be joined with that locator in ${method}(): a snapshot showed the ref inside an iframe, and ${method}() joins such a ref only with refs of that iframe.`,
    "Use refs of that iframe on both sides: a snapshot shows the refs inside it.",
  );
}

function intoFrameRefused(method: string) {
  return new ToolError(
    `${method}() cannot join a locator that goes into an iframe through contentFrame() or frameLocator(): Playwright matches both sides in one frame.`,
    "Use refs of that iframe on both sides: a snapshot shows the refs inside it.",
  );
}

async function shownBy(locator: Locator, deadline: number): Promise<number> {
  const shown = (await locator.filter({ visible: true }).count()) > 0;
  if (shown || Date.now() >= deadline) return Math.max(deadline - Date.now(), 1);
  await sleep(SHOWN_POLL_MS);
  return shownBy(locator, deadline);
}

export type GivenRefs = Map<string, Map<string, IssuedRef>>;

function laterRefRefused(tab: Tab, ref: string) {
  return new ToolError(
    `Ref ${ref} cannot be used: it is from a snapshot of tab ${tab.id} taken after the script was submitted.`,
    "Take a snapshot inside the script and use a ref from it.",
  );
}

export class CheckedRefs {
  private readonly checks = new WeakMap<object, ScriptRef[]>();
  private readonly bare = new WeakMap<object, ScriptRef>();
  private readonly steps = new WeakMap<object, Step>();
  private readonly memberChains = new WeakSet<object>();
  private readonly manager: BrowserManager;
  private readonly given: GivenRefs;

  constructor(manager: BrowserManager, given: GivenRefs) {
    this.manager = manager;
    this.given = given;
  }

  take(tab: Tab, issued: ReadonlyMap<string, IssuedRef>) {
    const refs = this.given.get(tab.id) ?? new Map<string, IssuedRef>();
    for (const [ref, record] of issued) refs.set(ref, record);
    this.given.set(tab.id, refs);
  }

  private issuedIn(tab: Tab, ref: string) {
    const given = this.given.get(tab.id) ?? new Map<string, IssuedRef>();
    if (!given.has(ref) && tab.refs.has(ref)) throw laterRefRefused(tab, ref);
    return this.manager.issued(tab, ref, given);
  }

  resolve(tab: Tab, target: string) {
    const ref = parseRef(target);
    if (!ref) return this.manager.resolve(tab, target);
    return this.manager.confirmIssued(tab, ref, this.issuedIn(tab, ref), ACTION_TIMEOUT_MS, target);
  }

  locate(tab: Tab, target: string) {
    const ref = parseRef(target);
    if (!ref) return this.manager.locate(tab, target);
    const issued = this.issuedIn(tab, ref);
    const locator = this.manager.locateIssued(tab, ref, issued, target);
    const check = { tab, ref, issued };
    this.checks.set(locator, [check]);
    this.bare.set(locator, check);
    return locator;
  }

  private refsIn(args: unknown[]) {
    return args
      .flatMap((arg) => {
        const parsed = joined.safeParse(arg);
        return parsed.success ? [arg, parsed.data.has, parsed.data.hasNot] : [arg];
      })
      .flatMap((value) => this.checksOf(value));
  }

  private isBare<Value>(value: Value) {
    return value instanceof Object && this.bare.has(value);
  }

  private checksOf<Value>(value: Value) {
    return value instanceof Object ? (this.checks.get(value) ?? []) : [];
  }

  private rootOf<Value>(value: Value): ScriptRef | undefined {
    if (!(value instanceof Object)) return undefined;
    const step = this.steps.get(value);
    return this.bare.get(value) ?? (step && this.rootOf(step.owner));
  }

  private filterRootOf<Owner extends object>(owner: Owner, wanted?: Variant): FilterRoot {
    if (wanted instanceof Object) return wanted;
    const frame = this.rootOf(owner)?.issued.frame ?? located.safeParse(owner).data?.frame;
    return frame ? { root: frame } : {};
  }

  private framedIn<Value>(value: Value) {
    return this.checksOf(value).find((check) => check.issued.frame);
  }

  private placedOf<Value>(value: Value) {
    return this.rootOf(value) ?? this.checksOf(value)[0];
  }

  private variant<Value>(value: Value, wanted: Variant, root?: Frame): Value | Locator {
    if (!(value instanceof Object)) return value;
    const bare = this.bare.get(value);
    if (bare)
      return (
        this.manager.locateProbed(
          bare.tab,
          bare.ref,
          bare.issued,
          wanted === "shown",
          wanted instanceof Object ? wanted : root && { root },
        ) ?? value
      );
    const step = this.steps.get(value);
    if (!step) return value;
    const call = this.called(step.owner, step.method, step.args, wanted, root);
    const member = memberOf(call.receiver, step.method);
    if (!isCallable(member)) return value;
    return chained.safeParse(member.apply(call.receiver, call.args)).data ?? value;
  }

  private entersFrames<Value>(value: Value, selector: string) {
    return framesEntered(selector) > (this.rootOf(value)?.issued.path.length ?? 0);
  }

  private inOneFrame<Owner extends object, Other>(owner: Owner, other: Other, method: string) {
    const ownerAt = located.safeParse(owner).data;
    const otherAt = located.safeParse(other).data;
    const one = this.placedOf(owner);
    const another = this.placedOf(other);
    const check = one ?? another;
    if (!ownerAt || !otherAt || !check) return;
    if (one && another) {
      if (!sameDocument(one.issued, another.issued)) throw framesRefused(one, another, method);
    } else {
      if (!check.issued.frame && check.issued.path.length > 0)
        throw snapshotFrameRefused(check, method);
      if (ownerAt.frame !== otherAt.frame) throw locatorFrameRefused(check, method);
    }
    if (this.entersFrames(owner, ownerAt.selector) || this.entersFrames(other, otherAt.selector))
      throw intoFrameRefused(method);
  }

  private joinedIn<Owner extends object, Other, Joined>(
    owner: Owner,
    other: Other,
    method: string,
    joining: () => Joined,
  ) {
    try {
      return joining();
    } catch (cause) {
      const framed = this.framedIn(owner) ?? this.framedIn(other);
      if (framed && messageOf(cause) === PLAYWRIGHT_FRAMES)
        throw locatorFrameRefused(framed, method);
      throw cause;
    }
  }

  private inFilter<Value>(value: Value, filter: FilterRoot) {
    const bare = value instanceof Object ? this.bare.get(value) : undefined;
    return bare ? this.manager.locateInFilter(bare.tab, bare.ref, bare.issued, filter.root) : value;
  }

  private joinsRefs(method: string, args: unknown[]) {
    return (
      method === "or" ||
      method === "and" ||
      (method === "locator" && this.checksOf(args[0]).length > 0)
    );
  }

  private called<Owner extends object>(
    owner: Owner,
    method: string,
    args: unknown[],
    wanted?: Variant,
    root?: Frame,
  ) {
    const frame =
      wanted instanceof Object || !this.joinsRefs(method, args)
        ? root
        : (root ?? (this.framedIn(owner) ?? this.framedIn(args[0]))?.issued.frame);
    const own = <Value>(value: Value) =>
      wanted || frame ? this.variant(value, wanted ?? "present", frame) : value;
    if (method === "or" || method === "and") {
      const member = <Value>(value: Value) =>
        method === "or" || wanted || frame
          ? this.variant(value, wanted ?? (method === "or" ? "shown" : "present"), frame)
          : value;
      return { receiver: member(owner), args: [member(args[0]), ...args.slice(1)] };
    }
    const at = OPTIONS_AT.get(method);
    return {
      receiver: own(owner),
      args: args.map((arg, index) => {
        if (index !== at) return own(arg);
        const parsed = joinedOptions.safeParse(arg);
        if (!parsed.success) return arg;
        const options = { ...parsed.data };
        const filter = this.filterRootOf(owner, wanted);
        if (options.has !== undefined) options.has = this.variant(options.has, filter);
        if (options.hasNot !== undefined) options.hasNot = this.inFilter(options.hasNot, filter);
        return options;
      }),
    };
  }

  private optionChecks<Options>(options: Options) {
    const parsed = joinedOptions.safeParse(options);
    if (!parsed.success) return [];
    const { has, hasNot } = parsed.data;
    return [
      ...(this.isBare(has) ? asMembers : kept)(this.checksOf(has)),
      ...(this.isBare(hasNot) ? asExcluded : kept)(this.checksOf(hasNot)),
    ];
  }

  private joins<Owner extends object>(owner: Owner, method: string, args: unknown[]) {
    if (method === "or" || this.memberChains.has(owner)) return true;
    const at = OPTIONS_AT.get(method);
    const options = at === undefined ? undefined : joinedOptions.safeParse(args[at]).data;
    return (
      options?.has !== undefined ||
      args.some((arg) => arg instanceof Object && this.memberChains.has(arg))
    );
  }

  private strict(checks: ScriptRef[], timeout: number, deadline: number) {
    return inSequence(checks, async (check) => {
      await this.manager.confirmIssued(
        check.tab,
        check.ref,
        check.issued,
        timeout,
        check.ref,
        deadline,
      );
      await this.insideFrame(check);
    });
  }

  private identity(checks: ScriptRef[], question: RefQuestion) {
    return inSequence(checks, async (check) => {
      await this.manager.checkIssued(check.tab, check.ref, check.issued, askedOf(check, question));
      await this.insideFrame(check);
    });
  }

  private async insideFrame(check: ScriptRef) {
    if (check.inside) await this.manager.checkInsideIssued(check.tab, check.ref, check.issued);
  }

  private async onPage(checks: ScriptRef[]) {
    const ready = await inSequence(checks, (check) =>
      this.manager.absenceReady(check.tab, check.ref, check.issued),
    );
    return ready.every(Boolean);
  }

  private async asked(method: string, args: unknown[], own: ScriptRef[]) {
    const question: RefQuestion = PRESENCE.has(method)
      ? "presence"
      : READS.has(method)
        ? "read"
        : "attached";
    await this.identity(own, question);
    const timeout = timeoutOf(args);
    await this.strict(this.refsIn(args), timeout, Date.now() + timeout);
  }

  private async acting(args: unknown[], own: ScriptRef[]) {
    const timeout = timeoutOf(args);
    const shown = [...own.filter((check) => !isAlternative(check)), ...this.refsIn(args)];
    await this.strict(shown, timeout, Date.now() + timeout);
    await this.identity(own.filter(isAlternative), "presence");
  }

  private derivedChecks(own: ScriptRef[], method: string, args: unknown[]) {
    if (method === "or") return asMembers([...own, ...this.checksOf(args[0])]);
    const at = OPTIONS_AT.get(method);
    if (at !== undefined && at < args.length)
      return [...own, ...this.refsIn(args.toSpliced(at, 1)), ...this.optionChecks(args[at])];
    return [...this.entered(own, method), ...this.refsIn(args)];
  }

  private presentOf<Owner extends object>(owner: Owner) {
    return this.memberChains.has(owner) ? this.variant(owner, "present") : owner;
  }

  private entered(own: ScriptRef[], method: string) {
    if (method !== "contentFrame") return own;
    return own.map((check) =>
      check.issued.role === "iframe" ? { ...check, inside: true } : check,
    );
  }

  private carry(locators: readonly Locator[], own: ScriptRef[]) {
    for (const locator of locators) this.checks.set(locator, own);
  }

  replacement<Owner extends object>(owner: Owner, method: string): Callable<unknown> | undefined {
    const own = this.checks.get(owner) ?? [];
    if (own.length === 0 && !TAKES_LOCATOR.has(method)) return undefined;
    const member =
      (this.manager.config.engine === "patchright" &&
        !LISTED.has(method) &&
        mainWorldMember(owner, method)) ||
      memberOf(owner, method);
    if (!isCallable(member) || UNCHECKED.has(method)) return undefined;
    if (DERIVING.has(method))
      return (...args) => {
        if (JOINS.has(method)) this.inOneFrame(owner, args[0], method);
        const call = this.called(owner, method, args);
        const derive = () => member.apply(call.receiver, call.args);
        const derived = JOINS.has(method)
          ? this.joinedIn(owner, args[0], method, derive)
          : derive();
        const checks = this.derivedChecks(own, method, args);
        if (derived instanceof Object && checks.length) {
          this.checks.set(derived, checks);
          this.steps.set(derived, { owner, method, args });
          if (this.joins(owner, method, args)) this.memberChains.add(derived);
        }
        return derived;
      };
    return async (...args) => {
      if (own.length > 0 && UNCHECKABLE.has(method)) throw uncheckableRefused(method);
      const state = stateOf(method, args);
      if (state && ABSENT.has(state)) {
        if (!(await this.onPage(own))) return undefined;
        return member.apply(this.presentOf(owner), args);
      }
      if (PRESENCE.has(method) || READS.has(method) || state === "attached") {
        await this.asked(method, args, own);
        const asking = this.presentOf(owner);
        const listed = this.manager.config.engine === "playwright" && LISTED.get(method);
        const result = await (listed
          ? evaluatedAll(chained.parse(asking), listed(args))
          : member.apply(asking, args));
        if (method === "all") this.carry(locatorList.safeParse(result).data ?? [], own);
        return result;
      }
      await this.acting(args, own);
      const shown =
        method === "waitFor" && this.memberChains.has(owner) && !endless.safeParse(args[0]).success;
      if (!shown) return member.apply(owner, args);
      const timeout = timeoutOf(args);
      const remaining = await shownBy(chained.parse(owner), Date.now() + timeout);
      return Promise.resolve(
        member.apply(owner, [{ ...waitOptions.parse(args[0] ?? {}), timeout: remaining }]),
      ).catch((cause: unknown) => {
        throw timedOutWithin(cause, timeout);
      });
    };
  }
}
