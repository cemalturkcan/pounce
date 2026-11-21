import type { Page, Request, Response, Route } from "playwright-core";
import { z } from "zod";

export const CONSOLE_LIMIT = 300;
const EVENT_LIMIT = 50;

export const consoleEntrySchema = z.object({
  level: z.string(),
  text: z.string(),
  time: z.string(),
});

export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;
export const UNCLAIMED_OWNER = "browser";
export const ORPHANED_OWNER = "orphaned";

export type NetworkEntry = {
  id: number;
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

export type InterceptRule = {
  id: number;
  summary: string;
  hits: number;
  errors: number;
  lastError?: string;
  matcher: (url: URL) => boolean;
  handler: (route: Route) => Promise<void>;
};

export type Tab = {
  id: string;
  page: Page;
  owner: string;
  createdAt: number;
  lastUsedAt: number;
  orphanedAt?: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  events: TabEvent[];
  rules: InterceptRule[];
  ruleCounter: number;
  loads: number;
  snapshotLoads?: number;
  document?: { url: string; status: number; redirected: boolean; response: Response };
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

const clockTime = (at: number) => new Date(at).toISOString().slice(11, 19);

function isDeferred(text: TabEvent["text"]): text is () => string {
  return typeof text === "function";
}

export function drainEvents(tab: Tab, since?: number) {
  return tab.events.splice(0, tab.events.length).map((event) => {
    const text = isDeferred(event.text) ? event.text() : event.text;
    if (since !== undefined && event.at < since)
      return `Earlier event (${clockTime(event.at)}, before this call): ${text}`;
    return event.stamped ? `Event (${clockTime(event.at)}): ${text}` : `Event: ${text}`;
  });
}
