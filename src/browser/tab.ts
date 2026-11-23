import type { CDPSession, Dialog, Page, Request, Response, Route } from "playwright-core";
import { z } from "zod";
import type { IssuedRef } from "./ref.ts";
import { localClock } from "../shared/output.ts";

export const CONSOLE_LIMIT = 300;
const EVENT_LIMIT = 50;

export const consoleEntrySchema = z.object({
  level: z.string(),
  text: z.string(),
  time: z.string(),
  source: z.string().optional(),
});

type CapturedConsoleEntry = z.infer<typeof consoleEntrySchema> & {
  url: string;
  documentId: number;
  key?: string;
};
export type ConsoleEntry = CapturedConsoleEntry & { seq: number };
export type ConsoleLog = Pick<Tab, "console" | "consoleSeq" | "consoleReads">;
export const UNCLAIMED_OWNER = "browser";
export const ORPHANED_OWNER = "orphaned";

export type PageDocument = { id: number; url: string; status?: number; loaderId?: string };
export type DocumentLog = Pick<Tab, "documents" | "currentDocument" | "committingDocument">;
const DOCUMENT_LIMIT = 1000;

export type NetworkEntry = {
  id: number;
  documentId: number;
  time: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  request: Request;
  response?: Response;
  body?: Buffer;
};

export type PendingRequest = { id: number; documentId: number; startedAt: number };

export type InterceptRule = {
  id: number;
  summary: string;
  hits: number;
  errors: number;
  lastError?: string;
  matcher: (url: URL) => boolean;
  handler: (route: Route) => Promise<void>;
};

export type PendingDialog = {
  type: string;
  message: string;
  defaultValue: string;
  dialog: Pick<Dialog, "accept" | "dismiss">;
};

export type Tab = {
  id: string;
  page: Page;
  session: Promise<CDPSession>;
  targetId?: string;
  owner: string;
  createdAt: number;
  lastUsedAt: number;
  orphanedAt?: number;
  console: ConsoleEntry[];
  consoleSeq: number;
  consoleReads: Map<string, number>;
  documents: PageDocument[];
  currentDocument: number;
  committingDocument?: number;
  network: NetworkEntry[];
  pending: Map<Request, PendingRequest>;
  events: TabEvent[];
  rules: InterceptRule[];
  ruleCounter: number;
  loads: number;
  routes: number;
  routePath?: string;
  committedAt?: number;
  documentAt?: number;
  snapshotLoads?: number;
  refs: Map<string, IssuedRef>;
  lastSnapshot?: { text: string; loads: number };
  document?: { url: string; status: number; redirected: boolean; response: Response };
  reportedSolve?: string;
  widgetWaitRoute?: number;
  popupChecks: Set<PopupCheck>;
  downloads: { at: number; name: string; saving: Promise<string> }[];
  openerId?: string;
  lastSeenUrl?: string;
  title?: string;
  closingByTool?: boolean;
  openingForUser?: boolean;
  actions: TabAction[];
  captureBodies?: boolean;
  unload?: { force: boolean; onBlocked?: () => void };
  browse?: { dismissDialogs: true; blockDownloads: true };
  unattended?: true;
  dialog?: PendingDialog;
  dialogsOpened: number;
  dialogsClosed: number;
  dialogsHeld: number;
  dialogWatchers: Set<(dialog: PendingDialog) => void>;
  humanInput?: PointerState;
  scripts?: Set<ScriptWatch>;
};

export type ScriptWatch = { owner: string; log: (line: string) => void };

export type Point = { x: number; y: number };

export type PointerState = {
  pointer?: Point;
  aim?: Point & { dx: number; dy: number };
  arrivedAt?: number;
  pressedAt?: number;
  lastKeyAt?: number;
};

export type PopupCheck = { done: Promise<void>; finish: (blocked: boolean) => void };

type TabEvent = { at: number; text: string | (() => string); stamped?: boolean };

export type TabAction = { tool: string; owner: string };

export function runningActions(id: string, actions: TabAction[]) {
  const tools = [...new Set(actions.map((action) => action.tool))];
  return tools.length
    ? `during ${tools.join(", ")} on ${id}`
    : `with no tool call running on ${id}`;
}

export function pushEvent(
  tab: Tab,
  text: string | (() => string),
  options: { at?: number; stamped?: boolean } = {},
) {
  pushBounded(
    tab.events,
    { at: options.at ?? Date.now(), text, stamped: options.stamped },
    EVENT_LIMIT,
  );
}

export function pushBounded<T>(list: T[], entry: T, limit: number) {
  list.push(entry);
  if (list.length > limit) list.splice(0, list.length - limit);
}

export function pushConsole(log: ConsoleLog, entry: CapturedConsoleEntry) {
  log.consoleSeq += 1;
  pushBounded(log.console, { ...entry, seq: log.consoleSeq }, CONSOLE_LIMIT);
}

export function upsertConsole(
  log: ConsoleLog,
  entry: CapturedConsoleEntry,
  { keepKnown = false }: { keepKnown?: boolean } = {},
) {
  const known =
    entry.key === undefined
      ? undefined
      : log.console.find((candidate) => candidate.key === entry.key);
  if (!known) return pushConsole(log, entry);
  if (keepKnown) return;
  known.text = entry.text;
  known.source = entry.source;
}

export function readConsole(log: ConsoleLog, owner: string, newOnly: boolean) {
  const after = newOnly ? (log.consoleReads.get(owner) ?? 0) : 0;
  log.consoleReads.set(owner, log.consoleSeq);
  return log.console.filter((entry) => entry.seq > after);
}

const FRAME_SCHEME = /^[a-z][\w+.-]*:/i;
const FRAME_POSITION = /:\d+:\d+$/;

function frameLocation(line: string) {
  const body = /^\s+at (.+)$/.exec(line)?.[1];
  if (body === undefined) return undefined;
  const opening = body.indexOf(" (");
  const location =
    FRAME_SCHEME.test(body) || opening === -1 ? body : body.slice(opening + 2).replace(/\)$/, "");
  return FRAME_SCHEME.test(location) && FRAME_POSITION.test(location) ? location : undefined;
}

export function stackSource(stack: string) {
  for (const line of stack.split("\n")) {
    const location = frameLocation(line);
    if (location) return location;
  }
  return undefined;
}

function isDeferred(text: TabEvent["text"]): text is () => string {
  return typeof text === "function";
}

export function forgetEvent(tab: Pick<Tab, "events">, text: string) {
  const index = tab.events.findIndex((event) => event.text === text);
  if (index >= 0) tab.events.splice(index, 1);
}

export function drainEvents(tab: Tab, since?: number, reported: string[] = []) {
  const drained = tab.events.splice(0, tab.events.length).map((event) => ({
    event,
    text: isDeferred(event.text) ? event.text() : event.text,
  }));
  return drained
    .filter(({ text }) => !reported.includes(text))
    .map(({ event, text }) => {
      if (since !== undefined && event.at < since)
        return `Earlier event (${localClock(event.at)}, before this call): ${text}`;
      return event.stamped ? `Event (${localClock(event.at)}): ${text}` : `Event: ${text}`;
    });
}

const CHROME_ERROR_PAGE = "chrome-error:";

function openDocument(log: DocumentLog, url: string) {
  const id = (log.documents.at(-1)?.id ?? -1) + 1;
  pushBounded(log.documents, { id, url }, DOCUMENT_LIMIT);
  return id;
}

export function navigationRequested(log: DocumentLog, url: string, redirected: boolean) {
  const latest = log.documents.at(-1);
  if (!redirected || !latest) return openDocument(log, url);
  latest.url = url;
  return latest.id;
}

export function navigationAbandoned(log: DocumentLog, id: number) {
  if (log.committingDocument === id) log.committingDocument = undefined;
}

const UNSHOWN_STATUSES = new Map([
  [204, "No Content"],
  [205, "Reset Content"],
]);

export const showsResponse = (status?: number) =>
  status === undefined || !UNSHOWN_STATUSES.has(status);

export function namedStatus(status: number) {
  const name = UNSHOWN_STATUSES.get(status);
  return name ? `${status} ${name}` : String(status);
}

export function navigationResponded(log: DocumentLog, id: number, status?: number) {
  if (!showsResponse(status)) {
    navigationAbandoned(log, id);
    const index = log.documents.findIndex((candidate) => candidate.id === id);
    if (index !== -1 && id !== log.currentDocument) log.documents.splice(index, 1);
    return log.currentDocument;
  }
  log.committingDocument = id;
  const document = log.documents.find((candidate) => candidate.id === id);
  if (document) document.status = status;
  return id;
}

const withoutFragment = (url: string) => url.split("#")[0];

function committedDocument(log: DocumentLog, url: string) {
  const committing = log.documents.find((document) => document.id === log.committingDocument);
  if (!url.startsWith(CHROME_ERROR_PAGE))
    return committing && withoutFragment(committing.url) === withoutFragment(url)
      ? committing.id
      : undefined;
  const latest = log.documents.at(-1);
  return committing?.id ?? (latest && latest.id > log.currentDocument ? latest.id : undefined);
}

export function documentCommitted(
  log: DocumentLog,
  url: string,
  { loaderId, restored = false }: { loaderId?: string; restored?: boolean } = {},
) {
  const committed = restored
    ? log.documents.find((document) => loaderId && document.loaderId === loaderId)?.id
    : committedDocument(log, url);
  log.committingDocument = undefined;
  log.currentDocument = committed ?? openDocument(log, url);
  const current = log.documents.find((document) => document.id === log.currentDocument);
  if (current && loaderId) current.loaderId = loaderId;
}

export function documentOrder(log: DocumentLog, ids: number[]) {
  return ids.toSorted((first, second) => {
    if (first === log.currentDocument) return 1;
    if (second === log.currentDocument) return -1;
    return first - second;
  });
}

export function reconcileDocument(log: DocumentLog, url: string) {
  const committing = log.documents.find((document) => document.id === log.committingDocument);
  const current = log.documents.find((document) => document.id === log.currentDocument);
  const settled = committing
    ? withoutFragment(committing.url) !== withoutFragment(url)
    : current !== undefined && sameUrl(current.url, url);
  if (!settled) documentCommitted(log, url);
}

export function messageDocument(log: DocumentLog, chromeOwn: boolean) {
  return chromeOwn && log.committingDocument !== undefined
    ? log.committingDocument
    : log.currentDocument;
}

export function deliveryDocument(log: DocumentLog, url: string, source?: number) {
  if (source !== undefined && log.documents.some((document) => document.id === source))
    return source;
  const current = log.documents.find((document) => document.id === log.currentDocument);
  if (current && sameUrl(current.url, url)) return current.id;
  return (
    log.documents.findLast((document) => sameUrl(document.url, url))?.id ?? log.currentDocument
  );
}

function comparableUrl(url: string) {
  const parsed = URL.parse(url);
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:") return url;
  parsed.searchParams.sort();
  return parsed.href;
}

const sameUrl = (one: string | undefined, other: string | undefined) =>
  one !== undefined && other !== undefined && comparableUrl(one) === comparableUrl(other);

export function movedTo(seen: string | undefined, url: string, documentUrl: string | undefined) {
  if (seen === undefined || sameUrl(url, seen)) return undefined;
  if (url.startsWith(CHROME_ERROR_PAGE) && sameUrl(documentUrl, seen)) return undefined;
  return url;
}
