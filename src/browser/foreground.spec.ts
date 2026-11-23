import { expect, test } from "bun:test";
import { belongsElsewhere, RenderKeeper } from "./foreground.ts";
import { ORPHANED_OWNER, UNCLAIMED_OWNER } from "./tab.ts";

type FrameEvent = { sessionId: number };

const browserAnswered = () => Bun.sleep(0);

function fakeRenderTab(closed = false) {
  const listeners = new Set<(event: FrameEvent) => void>();
  const sent: string[] = [];
  const session = {
    on: (_event: "Page.screencastFrame", listener: (event: FrameEvent) => void) => {
      listeners.add(listener);
    },
    off: (_event: "Page.screencastFrame", listener: (event: FrameEvent) => void) => {
      listeners.delete(listener);
    },
    send: async (method: string, params?: { sessionId?: number }) => {
      sent.push(params?.sessionId === undefined ? method : `${method} ${params.sessionId}`);
      return {};
    },
  };
  const frame = (sessionId: number) => {
    for (const listener of listeners) listener({ sessionId });
  };
  const tab = { id: "t1", session: Promise.resolve(session), page: { isClosed: () => closed } };
  return { tab, sent, frame };
}

test("holding a tab's rendering starts one screencast", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await browserAnswered();
  expect(sent).toEqual(["Page.startScreencast"]);
});

test("a second hold on a rendering tab starts no second screencast", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  keeper.hold(tab);
  await browserAnswered();
  expect(sent).toEqual(["Page.startScreencast"]);
});

test("each frame is acknowledged once while two holds keep the tab rendering", async () => {
  const { tab, sent, frame } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  keeper.hold(tab);
  await browserAnswered();
  frame(7);
  await Bun.sleep(0);
  expect(sent.filter((line) => line.startsWith("Page.screencastFrameAck"))).toEqual([
    "Page.screencastFrameAck 7",
  ]);
});

test("a hold has started once its screencast start was sent", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await keeper.started(tab);
  expect(sent).toEqual(["Page.startScreencast"]);
});

test("a hold after a stop has started once the new screencast start was sent", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const release = keeper.hold(tab);
  await browserAnswered();
  release();
  await browserAnswered();
  keeper.hold(tab);
  await keeper.started(tab);
  expect(sent).toEqual(["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast"]);
});

test("a tab nobody holds has nothing to start", async () => {
  const { tab, sent } = fakeRenderTab();
  await new RenderKeeper().started(tab);
  expect(sent).toEqual([]);
});

test("the screencast stops when the last hold is released", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const first = keeper.hold(tab);
  const second = keeper.hold(tab);
  await browserAnswered();
  first();
  second();
  await browserAnswered();
  expect(sent).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
});

test("the screencast keeps running while one hold is left", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const first = keeper.hold(tab);
  keeper.hold(tab);
  first();
  first();
  await browserAnswered();
  expect(sent).toEqual(["Page.startScreencast"]);
});

test("frames after the screencast stopped are not acknowledged", async () => {
  const { tab, sent, frame } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const release = keeper.hold(tab);
  await browserAnswered();
  release();
  await browserAnswered();
  frame(3);
  await Bun.sleep(0);
  expect(sent).toEqual(["Page.startScreencast", "Page.stopScreencast"]);
});

test("a hold after the screencast stopped starts it again", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const release = keeper.hold(tab);
  await browserAnswered();
  release();
  await browserAnswered();
  keeper.hold(tab);
  await browserAnswered();
  expect(sent).toEqual(["Page.startScreencast", "Page.stopScreencast", "Page.startScreencast"]);
});

test("a hold released before its screencast started sends nothing", async () => {
  const { tab, sent } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab)();
  await browserAnswered();
  expect(sent).toEqual([]);
});

test("a closed tab is not sent a screencast", async () => {
  const { tab, sent } = fakeRenderTab(true);
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await browserAnswered();
  expect(sent).toEqual([]);
});

test("a held tab that drew since its screencast started is drawing", async () => {
  const { tab } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await keeper.started(tab);
  keeper.drew(tab);
  expect(keeper.drawing(tab)).toBe(true);
});

test("a held tab that has not drawn since its screencast started is not drawing", async () => {
  const { tab } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await keeper.started(tab);
  expect(keeper.drawing(tab)).toBe(false);
});

test("a screencast frame shows that the held tab is drawing", async () => {
  const { tab, frame } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.hold(tab);
  await keeper.started(tab);
  frame(4);
  expect(keeper.drawing(tab)).toBe(true);
});

test("a tab that drew before its screencast stopped is not drawing after a new hold", async () => {
  const { tab } = fakeRenderTab();
  const keeper = new RenderKeeper();
  const release = keeper.hold(tab);
  await keeper.started(tab);
  keeper.drew(tab);
  release();
  await browserAnswered();
  keeper.hold(tab);
  await keeper.started(tab);
  expect(keeper.drawing(tab)).toBe(false);
});

test("a tab nobody holds is not drawing even after it drew", () => {
  const { tab } = fakeRenderTab();
  const keeper = new RenderKeeper();
  keeper.drew(tab);
  expect(keeper.drawing(tab)).toBe(false);
});

type Opener = { url: string };

const blankTab = (
  owner: string,
  visibility: Promise<DocumentVisibilityState>,
  opener: Opener | null = null,
) => ({
  owner,
  page: { opener: async () => opener, evaluate: () => visibility },
});

test("a hidden unclaimed blank tab is free to reuse", async () => {
  expect(await belongsElsewhere(blankTab(UNCLAIMED_OWNER, Promise.resolve("hidden")))).toBe(false);
});

test("a visible unclaimed blank tab stays the user's", async () => {
  expect(await belongsElsewhere(blankTab(UNCLAIMED_OWNER, Promise.resolve("visible")))).toBe(true);
});

test("an unclaimed blank tab that does not answer the visibility check stays the user's", async () => {
  expect(await belongsElsewhere(blankTab(UNCLAIMED_OWNER, new Promise(() => undefined)))).toBe(
    true,
  );
});

test("an orphaned blank tab is free to reuse even when it is visible", async () => {
  expect(await belongsElsewhere(blankTab(ORPHANED_OWNER, Promise.resolve("visible")))).toBe(false);
});

test("a blank popup belongs to the tab that opened it", async () => {
  expect(
    await belongsElsewhere(
      blankTab(UNCLAIMED_OWNER, Promise.resolve("hidden"), { url: "https://shop.example/" }),
    ),
  ).toBe(true);
});
