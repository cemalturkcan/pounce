import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Dialog, Page } from "playwright-core";
import type { Config } from "../config/config.ts";
import { isStreamingMime, isTextualMime } from "../shared/mime.ts";
import { timestampSlug } from "../shared/output.ts";
import type { ProfileSettings } from "./profile-settings.ts";
import { logEvent } from "../log/logger.ts";
import {
  CONSOLE_LIMIT,
  type NetworkEntry,
  type PopupCheck,
  pushBounded,
  pushEvent,
  type Tab,
  UNCLAIMED_OWNER,
} from "./tab.ts";

const NETWORK_LIMIT = 1000;
const BODY_ENTRY_LIMIT = 1024 * 1024;
const BODY_TAB_BUDGET = 48 * 1024 * 1024;
const BODY_GLOBAL_BUDGET = 256 * 1024 * 1024;
const POPUP_GRACE_MS = 600;
export const LEAVE_CANCELLED =
  "the page asked to confirm leaving (unsaved changes); navigation was cancelled. Call navigate again with force: true to leave anyway.";

export type TabHost = {
  config: Config;
  profile: ProfileSettings;
  allTabs(): Tab[];
  pageChanged(): void;
  closed(tab: Tab): void;
  popupOpenedSince(at: number, opener: Page): boolean;
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

export function watchTab(tab: Tab, host: TabHost) {
  const { page } = tab;
  let networkId = 0;

  page.on("close", () => host.closed(tab));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) host.pageChanged();
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
    pushBounded(
      tab.console,
      {
        level: message.type(),
        text: message.text().slice(0, 2000),
        time: new Date().toISOString(),
      },
      CONSOLE_LIMIT,
    );
  });
  page.on("pageerror", (error) => {
    pushBounded(
      tab.console,
      {
        level: "error",
        text: (error.stack ?? error.message).slice(0, 2000),
        time: new Date().toISOString(),
      },
      CONSOLE_LIMIT,
    );
  });
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") {
      answerBeforeUnload(tab, dialog);
      return;
    }
    if (tab.browse && (dialog.type() === "confirm" || dialog.type() === "prompt")) {
      pushEvent(
        tab,
        `${dialog.type()} dialog "${dialog.message().slice(0, 300)}" was dismissed, because browsing only looks`,
      );
      void dialog.dismiss().catch(() => undefined);
      return;
    }
    pushEvent(
      tab,
      `${dialog.type()} dialog "${dialog.message().slice(0, 300)}" was accepted automatically`,
    );
    void dialog
      .accept(dialog.type() === "prompt" ? dialog.defaultValue() : undefined)
      .catch(() => undefined);
  });
  page.on("download", (download) => {
    if (tab.browse) {
      pushEvent(
        tab,
        `a download of ${download.suggestedFilename()} was blocked, because browsing only looks`,
      );
      void download.cancel().catch(() => undefined);
      return;
    }
    const fileName = `${timestampSlug()}-${download
      .suggestedFilename()
      .replace(/[^\w.-]+/g, "_")
      .slice(-120)}`;
    const target = path.join(host.config.outputDir, "downloads", fileName);
    const saving = mkdir(path.dirname(target), { recursive: true })
      .then(() => download.saveAs(target))
      .then(() => target);
    pushBounded(tab.downloads, { at: Date.now(), name: download.suggestedFilename(), saving }, 10);
    void saving
      .then(() => pushEvent(tab, `download saved to ${target}`))
      .catch((error: Error) =>
        pushEvent(
          tab,
          `download of ${download.suggestedFilename()} failed: ${error.message.split("\n")[0]}`,
        ),
      );
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && response.frame() === page.mainFrame()) {
      tab.document = {
        url: response.url(),
        status: response.status(),
        redirected: request.redirectedFrom() !== null,
        response,
      };
    }
    networkId += 1;
    const entry: NetworkEntry = {
      id: networkId,
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
  watchPopups(host, tab);
  if (host.config.engine === "patchright") {
    page.on("request", (request) => {
      if (request.isNavigationRequest())
        void host.profile.allowLocalNetwork(page.context(), request.url()).catch(() => undefined);
    });
  }
  page.on("requestfailed", (request) => {
    networkId += 1;
    pushBounded(
      tab.network,
      {
        id: networkId,
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
function watchPopups(host: TabHost, tab: Tab) {
  const { page } = tab;
  void page
    .context()
    .newCDPSession(page)
    .then(async (session) => {
      session.on("Page.windowOpen", (event) => {
        if (!event.userGesture) expectPopup(host, tab, event.url);
      });
      await session.send("Page.enable");
    })
    .catch(() => undefined);
}
function expectPopup(host: TabHost, tab: Tab, url: string) {
  const openedAt = Date.now();
  const appeared = () => host.popupOpenedSince(openedAt - POPUP_GRACE_MS, tab.page);
  let settle: (() => void) | undefined;
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
  const timer = setTimeout(() => check.finish(!appeared()), POPUP_GRACE_MS);
  tab.popupChecks.add(check);
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
