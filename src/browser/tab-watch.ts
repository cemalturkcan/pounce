import { rm } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Dialog, Download, Page, Request, Response } from "playwright-core";
import type { Config } from "../config/config.ts";
import { isStreamingMime, isTextualMime } from "../shared/mime.ts";
import type { ProfileSettings } from "./profile-settings.ts";
import { logEvent } from "../log/logger.ts";
import { downloadFolder, reserveDownload } from "./downloads.ts";
import { consoleHookMode, openErrorChannel } from "./page-hooks.ts";
import { answerForScript, answerLookOnly, dialogClosed, holdDialog } from "./dialogs.ts";
import {
  documentCommitted,
  messageDocument,
  navigationAbandoned,
  navigationRequested,
  navigationResponded,
  type NetworkEntry,
  type PopupCheck,
  pushBounded,
  pushConsole,
  reconcileDocument,
  showsResponse,
  pushEvent,
  stackSource,
  type Tab,
  UNCLAIMED_OWNER,
} from "./tab.ts";

const NETWORK_LIMIT = 1000;
const BODY_ENTRY_LIMIT = 1024 * 1024;
const BODY_TAB_BUDGET = 48 * 1024 * 1024;
const BODY_GLOBAL_BUDGET = 256 * 1024 * 1024;
const POPUP_GRACE_MS = 600;
const POPUP_POLL_MS = 50;
export const LEAVE_CANCELLED =
  "the page asked to confirm leaving (unsaved changes); navigation was cancelled. Call navigate again with force: true to leave anyway.";

export type TabHost = {
  config: Config;
  profile: ProfileSettings;
  allTabs(): Tab[];
  pageChanged(): void;
  closed(tab: Tab): void;
  popupSince(at: number, opener: Tab): "listed" | "opening" | undefined;
};

function evictBodies(entries: NetworkEntry[], keep: NetworkEntry, budget: number) {
  let total = 0;
  for (const candidate of entries) total += candidate.body?.length ?? 0;
  for (const candidate of entries) {
    if (total <= budget) break;
    if (!candidate.body || candidate === keep) continue;
    total -= candidate.body.length;
    candidate.body = undefined;
  }
}

export function shouldRetainBody(
  tab: Pick<Tab, "owner" | "captureBodies">,
  headers: Record<string, string>,
) {
  if (tab.owner === UNCLAIMED_OWNER && !tab.captureBodies) return false;
  const contentType = headers["content-type"];
  if (!isTextualMime(contentType) || isStreamingMime(contentType)) return false;
  const length = Number(headers["content-length"]);
  return !(Number.isFinite(length) && length > BODY_ENTRY_LIMIT);
}

export function isUserDownload(tab: Pick<Tab, "owner" | "actions" | "scripts" | "unattended">) {
  return (
    tab.owner === UNCLAIMED_OWNER &&
    tab.actions.length === 0 &&
    !tab.scripts?.size &&
    !tab.unattended
  );
}

async function saveDownload(host: TabHost, tab: Tab, download: Download) {
  const folder = await downloadFolder(host.config);
  const target = await reserveDownload(
    isUserDownload(tab) ? folder : path.join(folder, "agent"),
    download.suggestedFilename(),
  );
  try {
    await download.saveAs(target);
  } catch (error) {
    await rm(target, { force: true });
    throw error;
  }
  return target;
}

const isRedirect = (response: Response) =>
  response.status() >= 300 && response.status() < 400 && response.headers().location !== undefined;

export function watchTab(tab: Tab, host: TabHost) {
  const { page } = tab;
  let networkId = 0;
  const documentOf = new WeakMap<Request, number>();
  tab.documents.push({ id: tab.currentDocument, url: page.url() });

  page.on("close", () => host.closed(tab));
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const routePath = URL.parse(page.url())?.pathname;
    if (routePath !== tab.routePath) {
      tab.routePath = routePath;
      tab.routes += 1;
    }
    tab.committedAt = Date.now();
    host.pageChanged();
  });
  page.on("domcontentloaded", () => {
    tab.loads += 1;
  });
  page.on("load", () => {
    void page
      .title()
      .then((title) => {
        tab.title = title;
        host.pageChanged();
      })
      .catch(() => undefined);
  });
  page.on("crash", () => {
    logEvent("tab_crash", { tab: tab.id, owner: tab.owner, url: page.url() }, "warn");
    pushEvent(tab, "the page crashed; reload it with navigate or close the tab");
  });
  page.on("console", (message) => {
    const level = message.type();
    const { url, lineNumber, columnNumber } = message.location();
    pushConsole(tab, {
      url: page.url(),
      documentId: messageDocument(tab, !url),
      level,
      text: message.text().slice(0, 2000),
      time: new Date().toISOString(),
      source:
        url && /error|warn/.test(level)
          ? `${url}:${lineNumber + 1}:${columnNumber + 1}`
          : undefined,
    });
  });
  page.on("pageerror", (error) => {
    pushConsole(tab, {
      url: page.url(),
      documentId: tab.currentDocument,
      level: "error",
      text: (error.stack ?? error.message).slice(0, 2000),
      time: new Date().toISOString(),
      source: error.stack ? stackSource(error.stack) : undefined,
    });
  });
  page.on("download", (download) => {
    tab.committingDocument = undefined;
    if (tab.browse) {
      pushEvent(
        tab,
        `a download of ${download.suggestedFilename()} was blocked, because browsing only looks`,
      );
      void download.cancel().catch(() => undefined);
      return;
    }
    const saving = saveDownload(host, tab, download);
    pushBounded(tab.downloads, { at: Date.now(), name: download.suggestedFilename(), saving }, 10);
    void saving
      .then((target) => pushEvent(tab, downloadSavedEvent(target)))
      .catch((error: Error) =>
        pushEvent(
          tab,
          `download of ${download.suggestedFilename()} failed: ${error.message.split("\n")[0]}`,
        ),
      );
  });
  const identityOf = (request: Request) => {
    const pending = tab.pending.get(request);
    tab.pending.delete(request);
    if (pending) return pending;
    networkId += 1;
    return { id: networkId, documentId: documentOf.get(request) ?? messageDocument(tab, true) };
  };
  page.on("request", (request) => {
    const documentId =
      request.isNavigationRequest() && request.frame() === page.mainFrame()
        ? navigationRequested(tab, request.url(), request.redirectedFrom() !== null)
        : messageDocument(tab, true);
    documentOf.set(request, documentId);
    networkId += 1;
    tab.pending.set(request, { id: networkId, documentId, startedAt: Date.now() });
    const oldest = tab.pending.keys().next().value;
    if (tab.pending.size > NETWORK_LIMIT && oldest) tab.pending.delete(oldest);
  });
  page.on("requestfinished", (request) => tab.pending.delete(request));
  page.on("response", (response) => {
    const request = response.request();
    const { id, documentId: requestDocument } = identityOf(request);
    let owningDocument = requestDocument;
    if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
      owningDocument = navigationResponded(tab, requestDocument, response.status());
      if (owningDocument !== requestDocument)
        for (const earlier of tab.network)
          if (earlier.documentId === requestDocument) earlier.documentId = owningDocument;
      if (showsResponse(response.status()) && !isRedirect(response))
        tab.document = {
          url: response.url(),
          status: response.status(),
          redirected: request.redirectedFrom() !== null,
          response,
        };
    }
    const entry: NetworkEntry = {
      id,
      documentId: owningDocument,
      time: new Date().toISOString(),
      method: request.method(),
      url: response.url(),
      resourceType: request.resourceType(),
      status: response.status(),
      request,
      response,
    };
    pushBounded(tab.network, entry, NETWORK_LIMIT);
    if (shouldRetainBody(tab, response.headers())) {
      void response
        .body()
        .then((body) => retainBody(host, tab, entry, body))
        .catch(() => undefined);
    }
  });
  watchSession(host, tab);
  if (host.config.engine === "patchright") {
    page.on("request", (request) => {
      if (request.isNavigationRequest())
        void host.profile.allowLocalNetwork(page.context(), request.url()).catch(() => undefined);
    });
  }
  page.on("requestfailed", (request) => {
    const answered = tab.network.some(
      (entry) => entry.request === request && !showsResponse(entry.status),
    );
    if (answered) return;
    const { id, documentId: owningDocument } = identityOf(request);
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      navigationAbandoned(tab, owningDocument);
    pushBounded(
      tab.network,
      {
        id,
        documentId: owningDocument,
        time: new Date().toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
        failure: request.failure()?.errorText ?? "failed",
        request,
      },
      NETWORK_LIMIT,
    );
  });
}
export const downloadSavedEvent = (target: string) => `download saved to ${target}`;

type DialogListeners = { listeners(event: "dialog"): unknown[] };

function dialogListeners(emitter: BrowserContext | Page) {
  // SAFETY: Playwright's client BrowserContext and Page extend its EventEmitter, which has Node's listeners method; only the type declarations leave it out.
  return (emitter as (BrowserContext | Page) & DialogListeners).listeners("dialog");
}

export function watchDialogs(context: BrowserContext, adopt: (page: Page) => Tab) {
  const onDialog = (dialog: Dialog) => {
    const page = dialog.page();
    if (!page) return;
    const scriptListens =
      dialogListeners(context).some((listener) => listener !== onDialog) ||
      dialogListeners(page).length > 0;
    answerTabDialog(adopt(page), dialog, scriptListens);
  };
  context.prependListener("dialog", onDialog);
}

function answerTabDialog(tab: Tab, dialog: Dialog, scriptListens: boolean) {
  tab.dialogsOpened += 1;
  if (dialog.type() === "beforeunload") answerBeforeUnload(tab, dialog);
  else if (tab.browse) answerLookOnly(tab, dialog, "browsing only looks");
  else if (tab.unattended) answerLookOnly(tab, dialog, "no one drives this tab");
  else {
    const scripts = scriptListens ? [] : scriptsAnswering(tab);
    if (scripts.length) answerForScript(tab, dialog, scripts);
    else holdDialog(tab, dialog);
  }
}

function scriptsAnswering(tab: Tab) {
  if (tab.owner === UNCLAIMED_OWNER) return [];
  if (!tab.actions.every((action) => action.tool === "run_script")) return [];
  return [...(tab.scripts ?? [])].filter((script) => script.owner === tab.owner);
}

function answerBeforeUnload(tab: Tab, dialog: Dialog) {
  if (tab.unload?.force) {
    void dialog.accept().catch(() => undefined);
    return;
  }
  const onBlocked = tab.unload?.onBlocked;
  if (onBlocked) onBlocked();
  else pushEvent(tab, LEAVE_CANCELLED);
  void dialog.dismiss().catch(() => undefined);
}
function watchSession(host: TabHost, tab: Tab) {
  void tab.session
    .then(async (session) => {
      session.on("Page.windowOpen", (event) =>
        expectPopup(host, tab, event.url, event.userGesture),
      );
      session.on("Page.javascriptDialogClosed", () => dialogClosed(tab));
      session.on("Page.frameNavigated", ({ frame, type }) => {
        if (frame.parentId) return;
        tab.documentAt = Date.now();
        tab.routes += 1;
        if (type === "BackForwardCacheRestore") tab.loads += 1;
        documentCommitted(tab, frame.url, {
          loaderId: frame.loaderId,
          restored: type === "BackForwardCacheRestore",
        });
      });
      await session.send("Page.enable");
      reconcileDocument(tab, tab.page.url());
      await openErrorChannel(consoleHookMode(host.config), tab, session);
    })
    .catch(() => undefined);
}
function expectPopup(host: TabHost, tab: Tab, url: string, userGesture: boolean) {
  const openedAt = Date.now();
  let settle: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check: PopupCheck = {
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    finish: (blocked) => {
      clearTimeout(timer);
      if (!tab.popupChecks.delete(check)) return;
      if (blocked)
        pushEvent(
          tab,
          `a popup was blocked (${url.slice(0, 200)}); if the page needs it, click the control that opens it`,
        );
      settle?.();
    },
  };
  const look = () => {
    const state = host.popupSince(openedAt - POPUP_GRACE_MS, tab);
    if (state === "listed") {
      check.finish(false);
      return;
    }
    if (Date.now() - openedAt < POPUP_GRACE_MS) {
      timer = setTimeout(look, POPUP_POLL_MS);
      return;
    }
    if (state === "opening")
      pushEvent(
        tab,
        `opened new tab for ${url.slice(0, 200)} from ${tab.id}; it is still loading, and tabs shows its id once it has loaded`,
      );
    check.finish(state === undefined && !userGesture);
  };
  tab.popupChecks.add(check);
  look();
}
function retainBody(host: TabHost, tab: Tab, entry: NetworkEntry, body: Buffer) {
  if (body.length > BODY_ENTRY_LIMIT || !tab.network.includes(entry)) return;
  entry.body = body;
  evictBodies(tab.network, entry, BODY_TAB_BUDGET);
  const all = host
    .allTabs()
    .flatMap((candidate) => candidate.network)
    .filter((candidate) => candidate.body)
    .toSorted((left, right) => left.time.localeCompare(right.time));
  evictBodies(all, entry, BODY_GLOBAL_BUDGET);
}
