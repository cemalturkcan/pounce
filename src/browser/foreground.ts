import type { CDPSession, Page } from "playwright-core";
import { logEvent } from "../log/logger.ts";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";
import { messageOf } from "../shared/errors.ts";
import { UNCLAIMED_OWNER } from "./tab.ts";

const WORLD = "web-agent-foreground";
const VISIBILITY_CHECK_MS = 1000;

async function shownInItsWindow(page: Pick<Page, "evaluate">) {
  const state = await withDeadline(
    page.evaluate(() => document.visibilityState),
    VISIBILITY_CHECK_MS,
  ).catch((): typeof TIMED_OUT => TIMED_OUT);
  return state !== "hidden";
}

export async function belongsElsewhere(tab: {
  owner: string;
  page: Pick<Page, "evaluate"> & { opener(): Promise<object | null> };
}) {
  if (await tab.page.opener().catch(() => null)) return true;
  return tab.owner === UNCLAIMED_OWNER && (await shownInItsWindow(tab.page));
}

type FrameListener = (event: { sessionId: number }) => void;

type ScreencastParams = {
  format?: "jpeg";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
  sessionId?: number;
};

type RenderSession = {
  on(event: "Page.screencastFrame", listener: FrameListener): void;
  off(event: "Page.screencastFrame", listener: FrameListener): void;
  send(
    method: "Page.startScreencast" | "Page.stopScreencast" | "Page.screencastFrameAck",
    params?: ScreencastParams,
  ): Promise<Record<string, never>>;
};

type RenderedTab = {
  id: string;
  session: Promise<RenderSession>;
  page: Pick<Page, "isClosed">;
};

type Rendering = {
  holds: number;
  onFrame?: FrameListener;
  drawn: boolean;
  settled: Promise<void>;
};

export class RenderKeeper {
  private readonly renderings = new WeakMap<RenderedTab, Rendering>();

  hold(tab: RenderedTab) {
    const rendering = this.renderings.get(tab) ?? {
      holds: 0,
      drawn: false,
      settled: Promise.resolve(),
    };
    this.renderings.set(tab, rendering);
    rendering.holds += 1;
    this.settle(tab, rendering);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      rendering.holds -= 1;
      this.settle(tab, rendering);
    };
  }

  started(tab: RenderedTab) {
    return this.renderings.get(tab)?.settled ?? Promise.resolve();
  }

  drew(tab: RenderedTab) {
    const rendering = this.renderings.get(tab);
    if (rendering?.onFrame) rendering.drawn = true;
  }

  drawing(tab: RenderedTab) {
    const rendering = this.renderings.get(tab);
    return rendering?.onFrame !== undefined && rendering.drawn;
  }

  private settle(tab: RenderedTab, rendering: Rendering) {
    rendering.settled = rendering.settled
      .then(() => applyRendering(tab, rendering))
      .catch((cause: unknown) =>
        logEvent("keep_rendering_failed", { tab: tab.id, error: messageOf(cause) }, "debug"),
      );
  }
}

async function applyRendering(tab: RenderedTab, rendering: Rendering) {
  const wanted = rendering.holds > 0 && !tab.page.isClosed();
  if (wanted === (rendering.onFrame !== undefined)) return;
  const session = await tab.session;
  const running = rendering.onFrame;
  rendering.drawn = false;
  if (running) {
    rendering.onFrame = undefined;
    session.off("Page.screencastFrame", running);
    if (!tab.page.isClosed()) await session.send("Page.stopScreencast");
    return;
  }
  const onFrame: FrameListener = (event) => {
    rendering.drawn = true;
    void session
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => undefined);
  };
  session.on("Page.screencastFrame", onFrame);
  rendering.onFrame = onFrame;
  try {
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: 1,
      maxWidth: 8,
      maxHeight: 8,
      everyNthFrame: 1000,
    });
  } catch (cause) {
    rendering.onFrame = undefined;
    session.off("Page.screencastFrame", onFrame);
    throw cause;
  }
}

export async function nextFrame(session: CDPSession) {
  const { frameTree } = await session.send("Page.getFrameTree");
  const { executionContextId } = await session.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: WORLD,
  });
  await session.send("Runtime.evaluate", {
    expression: "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))",
    contextId: executionContextId,
    awaitPromise: true,
  });
}
