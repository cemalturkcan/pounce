import { expect, test } from "bun:test";
import { ToolError } from "../shared/errors.ts";
import {
  type Encoder,
  ffmpegArgs,
  FrameTimeline,
  jpegSize,
  Recording,
  RECORDING_FPS,
  type Screencast,
  type ScreencastFrame,
} from "./recording.ts";

function jpegOf(width: number, height: number, marker = 0) {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    marker,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    ...Array.from({ length: 9 }, () => 0),
    0xff,
    0xd9,
  ]);
}

const frameA = jpegOf(800, 600, 1);
const frameB = jpegOf(800, 600, 2);
const frameC = jpegOf(800, 600, 3);
const slotMs = 1000 / RECORDING_FPS;

test("jpegSize reads the width and height of a baseline JPEG", () => {
  expect(jpegSize(jpegOf(1280, 721))).toEqual({ width: 1280, height: 721 });
});

test("jpegSize returns undefined for bytes that are not a JPEG", () => {
  expect(jpegSize(Buffer.from("not a jpeg"))).toBeUndefined();
});

test("the first frame waits for the next one to know how long it shows", () => {
  const timeline = new FrameTimeline(0);
  expect(timeline.place(frameA, 0)).toEqual([]);
});

test("a frame is repeated until the slot where the next frame arrives", () => {
  const timeline = new FrameTimeline(0);
  timeline.place(frameA, 0);
  expect(timeline.place(frameB, 10 * slotMs)).toEqual([{ frame: frameA, copies: 10 }]);
});

test("a frame that would show more than a slot before it arrived replaces the frame waiting there", () => {
  const timeline = new FrameTimeline(0);
  timeline.place(frameA, 0);
  timeline.place(frameB, slotMs / 4);
  timeline.place(frameC, slotMs / 2);
  expect(timeline.finish(2 * slotMs)).toEqual([{ frame: frameC, copies: 1 }]);
});

test("frames arriving once a slot with a little jitter each show for one slot", () => {
  const timeline = new FrameTimeline(0);
  const jitterMs = [2, -2, 1.5, -1.5];
  const runs = Array.from({ length: 40 }, (_, index) =>
    timeline.place(jpegOf(800, 600, index), index * slotMs + (jitterMs[index % 4] ?? 0)),
  ).flat();
  expect(runs.map((run) => run.copies)).toEqual(Array.from({ length: 39 }, () => 1));
});

test("a page drawing 60 frames per second keeps all of them in a second of video", () => {
  const timeline = new FrameTimeline(0);
  const runs = [
    ...Array.from({ length: 60 }, (_, index) =>
      timeline.place(jpegOf(800, 600, index), (index * 1000) / 60),
    ).flat(),
    ...timeline.finish(1000),
  ];
  expect(runs).toHaveLength(60);
});

test("finish fills the last frame up to the stop time, so a 10 s recording plays 10 s", () => {
  const timeline = new FrameTimeline(1000);
  const runs = [
    ...timeline.place(frameA, 1000),
    ...timeline.place(frameB, 1300),
    ...timeline.place(frameC, 7000),
    ...timeline.finish(11_000),
  ];
  expect(runs.reduce((sum, run) => sum + run.copies, 0)).toBe(10 * RECORDING_FPS);
});

test("finish writes at least one frame for a recording stopped right away", () => {
  const timeline = new FrameTimeline(0);
  timeline.place(frameA, 0);
  expect(timeline.finish(0)).toEqual([{ frame: frameA, copies: 1 }]);
});

test("finish writes nothing when no frame arrived", () => {
  expect(new FrameTimeline(0).finish(5000)).toEqual([]);
});

test("ffmpegArgs reads JPEG frames from stdin and writes the mp4 last", () => {
  const args = ffmpegArgs("/out/video.mp4", { width: 800, height: 600 });
  expect([args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), args.at(-1)]).toEqual([
    ["-i", "-"],
    "/out/video.mp4",
  ]);
});

test("ffmpegArgs keeps every frame at the first frame's size, rounded down to even pixels", () => {
  const args = ffmpegArgs("/out/video.mp4", { width: 801, height: 603 });
  expect(args[args.indexOf("-vf") + 1]).toMatch(/^scale=800:602:.*pad=800:602:/);
});

test("ffmpegArgs plays the frames at the recording frame rate", () => {
  const args = ffmpegArgs("/out/video.mp4", { width: 800, height: 600 });
  expect(args[args.indexOf("-framerate") + 1]).toBe(String(RECORDING_FPS));
});

type FakeScreencast = Screencast & {
  emit(frame: Buffer, timestampMs: number): void;
  acked: number[];
  stopped: boolean;
};

function fakeScreencast(capture: () => Promise<Buffer> = async () => frameC): FakeScreencast {
  let listener: ((event: ScreencastFrame) => void) | undefined;
  let next = 0;
  const fake: FakeScreencast = {
    acked: [],
    stopped: false,
    capture: async () => {
      if (fake.stopped) throw new Error("the screencast session is detached");
      return (await capture()).toString("base64");
    },
    start: async (onFrame) => {
      listener = onFrame;
    },
    ack: async (sessionId) => {
      fake.acked.push(sessionId);
    },
    stop: async () => {
      fake.stopped = true;
    },
    emit: (frame, timestampMs) => {
      next += 1;
      listener?.({
        data: frame.toString("base64"),
        sessionId: next,
        metadata: { timestamp: timestampMs / 1000 },
      });
    },
  };
  return fake;
}

type FakeEncoder = Encoder & { args: string[]; frames: Buffer[]; ended: boolean };

function fakeEncoder(failure?: Error) {
  const started: FakeEncoder[] = [];
  const start = (args: string[]) => {
    const encoder: FakeEncoder = {
      args,
      frames: [],
      ended: false,
      write: async (frame) => {
        encoder.frames.push(frame);
      },
      end: async () => {
        encoder.ended = true;
        if (failure) throw failure;
      },
    };
    started.push(encoder);
    return encoder;
  };
  return { start, started };
}

function recordingWith(
  screencast: Screencast,
  encoder: ReturnType<typeof fakeEncoder>,
  firstFrameMs = 1000,
  documentAt: () => number | undefined = () => undefined,
  currentFrameMs = 1000,
) {
  let clock = 5000;
  const recording = new Recording({
    tab: "t1",
    file: "/out/t1.mp4",
    screencast,
    startEncoder: encoder.start,
    now: () => clock,
    firstFrameMs,
    documentAt,
    currentFrameMs,
  });
  return { recording, setClock: (at: number) => (clock = at) };
}

test("a recording acknowledges every screencast frame so the browser keeps sending", async () => {
  const screencast = fakeScreencast();
  const { recording } = recordingWith(screencast, fakeEncoder());
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  screencast.emit(frameB, 5100);
  expect(screencast.acked).toEqual([1, 2]);
});

test("a recording starts the encoder with the size of its first frame", async () => {
  const screencast = fakeScreencast();
  const encoder = fakeEncoder();
  const { recording } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(jpegOf(1024, 768), 5000);
  await starting;
  await recording.stop();
  expect(encoder.started[0]?.args).toEqual(ffmpegArgs("/out/t1.mp4", { width: 1024, height: 768 }));
});

test("stop writes frames covering the whole recording and reports duration and frames", async () => {
  const screencast = fakeScreencast();
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  screencast.emit(frameB, 6000);
  setClock(8000);
  const result = await recording.stop();
  expect({ result, written: encoder.started[0]?.frames.length }).toEqual({
    result: { tab: "t1", file: "/out/t1.mp4", durationMs: 3000, frames: 2 },
    written: 3 * RECORDING_FPS,
  });
});

test("stop ends the screencast and the encoder", async () => {
  const screencast = fakeScreencast();
  const encoder = fakeEncoder();
  const { recording } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  await recording.stop();
  expect([screencast.stopped, encoder.started[0]?.ended]).toEqual([true, true]);
});

test("stop called twice finishes the file once", async () => {
  const screencast = fakeScreencast();
  const encoder = fakeEncoder();
  const { recording } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  const [first, second] = await Promise.all([recording.stop(), recording.stop()]);
  expect([second, encoder.started.length]).toEqual([first, 1]);
});

test("stop fails clearly when no frame arrived", async () => {
  const { recording } = recordingWith(fakeScreencast(), fakeEncoder(), 10);
  await recording.start().catch(() => undefined);
  expect(recording.stop()).rejects.toThrow(/received no frame/);
});

test("stop passes on an encoder failure", async () => {
  const screencast = fakeScreencast();
  const { recording } = recordingWith(
    screencast,
    fakeEncoder(new ToolError("ffmpeg failed (exit code 1): broken pipe")),
  );
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  expect(recording.stop()).rejects.toThrow(/ffmpeg failed/);
});

test("status reports the time recorded so far and the frames received", async () => {
  const screencast = fakeScreencast();
  const { recording, setClock } = recordingWith(screencast, fakeEncoder());
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  setClock(6500);
  expect(recording.status()).toEqual({
    tab: "t1",
    file: "/out/t1.mp4",
    durationMs: 1500,
    frames: 1,
    state: "recording",
  });
});

test("start resolves once the browser sent the first frame", async () => {
  const screencast = fakeScreencast();
  const { recording } = recordingWith(screencast, fakeEncoder());
  let started = false;
  const starting = recording.start().then(() => (started = true));
  await Promise.resolve();
  const before = started;
  screencast.emit(frameA, 5000);
  await starting;
  expect([before, started]).toEqual([false, true]);
});

test("start fails clearly when the browser sends no frame", async () => {
  const screencast = fakeScreencast();
  const { recording } = recordingWith(screencast, fakeEncoder(), 10);
  expect(recording.start()).rejects.toThrow(/sent no frame/);
});

test("stop ends the video on what the tab shows at that moment", async () => {
  const screencast = fakeScreencast();
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  setClock(6000);
  await recording.stop();
  expect(encoder.started[0]?.frames.at(-1)).toEqual(frameC);
});

test("stop still finishes the video when the tab can no longer be captured", async () => {
  const screencast = fakeScreencast(async () => {
    throw new Error("Target closed");
  });
  const { recording, setClock } = recordingWith(screencast, fakeEncoder());
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  setClock(6000);
  expect((await recording.stop()).durationMs).toBe(1000);
});

test("status says a recording is stopping while its video is being finished", async () => {
  const screencast = fakeScreencast();
  const { recording } = recordingWith(screencast, fakeEncoder());
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  const stopping = recording.stop();
  const state = recording.status().state;
  await stopping;
  expect(state).toBe("stopping");
});

test("a frame the browser took before stop and delivered during it is kept", async () => {
  let screencast: FakeScreencast | undefined;
  screencast = fakeScreencast(async () => {
    screencast?.emit(frameB, 5900);
    return frameC;
  });
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder);
  const starting = recording.start();
  screencast.emit(frameA, 5000);
  await starting;
  setClock(6000);
  await recording.stop();
  expect(encoder.started[0]?.frames).toContainEqual(frameB);
});

function showingScreencast() {
  let shown: Buffer = frameA;
  const screencast = fakeScreencast(async () => shown);
  const show = (frame: Buffer, timestampMs: number) => {
    shown = frame;
    screencast.emit(frame, timestampMs);
  };
  return { screencast, show };
}

test("stop right after a new page committed waits for that page's first frame", async () => {
  const { screencast, show } = showingScreencast();
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder, 1000, () => 5500, 60_000);
  const starting = recording.start();
  show(frameA, 5000);
  await starting;
  setClock(5600);
  const stopping = recording.stop();
  await Bun.sleep(20);
  show(frameB, 5700);
  await stopping;
  expect(encoder.started[0]?.frames.at(-1)).toEqual(frameB);
});

test("stop ends on the page shown when the new page sends no frame within the wait", async () => {
  const { screencast, show } = showingScreencast();
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder, 1000, () => 5500, 20);
  const starting = recording.start();
  show(frameA, 5000);
  await starting;
  setClock(5600);
  await recording.stop();
  expect(encoder.started[0]?.frames.at(-1)).toEqual(frameA);
});

test("stop does not wait when a frame came after the last page committed", async () => {
  const { screencast, show } = showingScreencast();
  const encoder = fakeEncoder();
  const { recording, setClock } = recordingWith(screencast, encoder, 1000, () => 5100, 60_000);
  const starting = recording.start();
  show(frameA, 5000);
  await starting;
  show(frameB, 5200);
  setClock(5600);
  const result = await recording.stop();
  expect(result.frames).toBe(2);
});
