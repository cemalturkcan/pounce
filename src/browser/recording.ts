import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Page } from "playwright-core";
import { inSequence, TIMED_OUT, withDeadline } from "../shared/async.ts";
import { errorFrom, messageOf, ToolError } from "../shared/errors.ts";
import { logEvent } from "../log/logger.ts";
import { screencastSession } from "./page-session.ts";
import type { Tab } from "./tab.ts";

export const RECORDING_FPS = 60;
const JPEG_QUALITY = 80;
const STDERR_TAIL_CHARS = 2000;
const FIRST_FRAME_MS = 5000;
const LAST_FRAME_MS = 2000;
const CURRENT_FRAME_MS = 1000;
const SLOT_MS = 1000 / RECORDING_FPS;

export type ScreencastFrame = {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number };
};

export type Screencast = {
  start(onFrame: (frame: ScreencastFrame) => void): Promise<void>;
  ack(sessionId: number): Promise<void>;
  capture(): Promise<string>;
  stop(): Promise<void>;
};

export type Encoder = { write(frame: Buffer): Promise<void>; end(): Promise<void> };
export type StartEncoder = (args: string[]) => Encoder;

type Size = { width: number; height: number };
type FrameRun = { frame: Buffer; copies: number };

const START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb]);

export function jpegSize(jpeg: Buffer): Size | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 9 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return undefined;
    const marker = jpeg[offset + 1] ?? 0;
    if (START_OF_FRAME.has(marker))
      return { width: jpeg.readUInt16BE(offset + 7), height: jpeg.readUInt16BE(offset + 5) };
    offset += 2 + jpeg.readUInt16BE(offset + 2);
  }
  return undefined;
}

export class FrameTimeline {
  private readonly startedAt: number;
  private written = 0;
  private waiting?: Buffer;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  place(frame: Buffer, at: number): FrameRun[] {
    const previous = this.waiting;
    this.waiting = frame;
    const slot = this.slotOf(at);
    if (!previous || this.written > slot) return [];
    return this.fillTo(previous, Math.max(Math.round(slot), this.written + 1));
  }

  finish(at: number): FrameRun[] {
    const last = this.waiting;
    if (!last) return [];
    this.waiting = undefined;
    return this.fillTo(last, Math.max(this.written + 1, Math.round(this.slotOf(at))));
  }

  private slotOf(at: number) {
    return ((at - this.startedAt) * RECORDING_FPS) / 1000;
  }

  private fillTo(frame: Buffer, slot: number): FrameRun[] {
    const copies = slot - this.written;
    if (copies <= 0) return [];
    this.written = slot;
    return [{ frame, copies }];
  }
}

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

export function ffmpegArgs(file: string, size: Size) {
  const width = even(size.width);
  const height = even(size.height);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    String(RECORDING_FPS),
    "-c:v",
    "mjpeg",
    "-i",
    "-",
    "-an",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-movflags",
    "+faststart",
    file,
  ];
}

export function cdpScreencast(page: Page): Screencast {
  const session = screencastSession(page);
  let listening: ((frame: ScreencastFrame) => void) | undefined;
  return {
    start: async (onFrame) => {
      const open = await session;
      listening = onFrame;
      open.on("Page.screencastFrame", onFrame);
      await open.send("Page.startScreencast", { format: "jpeg", quality: JPEG_QUALITY });
    },
    ack: async (sessionId) => {
      await (await session).send("Page.screencastFrameAck", { sessionId });
    },
    capture: async () => {
      const shot = await (
        await session
      ).send("Page.captureScreenshot", {
        format: "jpeg",
        quality: JPEG_QUALITY,
      });
      return shot.data;
    },
    stop: async () => {
      const open = await session;
      if (listening) open.off("Page.screencastFrame", listening);
      listening = undefined;
      await open.send("Page.stopScreencast").catch(() => undefined);
    },
  };
}

export function spawnEncoder(command: string): StartEncoder {
  return (args) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    let failure: Error | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", (cause) => (failure ??= cause));
    const exited = once(child, "exit")
      .then(([code]) => code)
      .catch((cause: unknown) => {
        failure ??= errorFrom(cause);
        return undefined;
      });
    child.on("error", (cause) => (failure ??= cause));
    return {
      write: async (frame) => {
        if (failure || child.stdin.destroyed) return;
        if (!child.stdin.write(frame)) await Promise.race([once(child.stdin, "drain"), exited]);
      },
      end: async () => {
        child.stdin.end();
        const code = await exited;
        if (code === 0) return;
        const detail = stderr.trim() || failure?.message || "no error output";
        throw new ToolError(`ffmpeg failed (exit code ${code ?? "none"}): ${detail}`);
      },
    };
  };
}

export const RECORDING_STATES = ["recording", "stopping", "finished", "failed"] as const;
export type RecordingState = (typeof RECORDING_STATES)[number];

export type RecordingResult = { tab: string; file: string; durationMs: number; frames: number };

type RecordingOptions = {
  tab: string;
  file: string;
  screencast: Screencast;
  startEncoder: StartEncoder;
  now?: () => number;
  firstFrameMs?: number;
  documentAt?: () => number | undefined;
  currentFrameMs?: number;
};

export class Recording {
  readonly tab: string;
  readonly file: string;
  private readonly screencast: Screencast;
  private readonly startEncoder: StartEncoder;
  private readonly now: () => number;
  private readonly firstFrameMs: number;
  private readonly documentAt: () => number | undefined;
  private readonly currentFrameMs: number;
  private lastFrameAt?: number;
  private sawFrame: (at: number) => void = () => undefined;
  private readonly firstFrame: Promise<void>;
  private sawFirstFrame: () => void = () => undefined;
  private readonly startedAt: number;
  private readonly timeline: FrameTimeline;
  private encoder?: Encoder;
  private writing: Promise<void> = Promise.resolve();
  private failure?: Error;
  private frames = 0;
  private stoppedAt?: number;
  private captured = false;
  private stopping?: Promise<RecordingResult>;
  private state: RecordingState = "recording";

  constructor(options: RecordingOptions) {
    this.tab = options.tab;
    this.file = options.file;
    this.screencast = options.screencast;
    this.startEncoder = options.startEncoder;
    this.now = options.now ?? Date.now;
    this.firstFrameMs = options.firstFrameMs ?? FIRST_FRAME_MS;
    this.documentAt = options.documentAt ?? (() => undefined);
    this.currentFrameMs = options.currentFrameMs ?? CURRENT_FRAME_MS;
    this.firstFrame = new Promise((resolve) => (this.sawFirstFrame = resolve));
    this.startedAt = this.now();
    this.timeline = new FrameTimeline(this.startedAt);
  }

  async start() {
    await this.screencast.start((frame) => this.receive(frame));
    if ((await withDeadline(this.firstFrame, this.firstFrameMs)) === TIMED_OUT)
      throw new ToolError(
        `The browser sent no frame of ${this.tab} within ${this.firstFrameMs / 1000} s, so the recording did not start.`,
        "Check that the tab still shows a page (tabs), then start again.",
      );
  }

  status() {
    return {
      tab: this.tab,
      file: this.file,
      durationMs: (this.stoppedAt ?? this.now()) - this.startedAt,
      frames: this.frames,
      state: this.state,
    };
  }

  stop() {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  private receive(frame: ScreencastFrame) {
    void this.screencast.ack(frame.sessionId).catch(() => undefined);
    const at =
      frame.metadata.timestamp === undefined ? this.now() : frame.metadata.timestamp * 1000;
    if (this.stoppedAt !== undefined && (this.captured || at > this.stoppedAt)) return;
    const jpeg = Buffer.from(frame.data, "base64");
    this.frames += 1;
    this.lastFrameAt = at;
    this.sawFrame(at);
    this.sawFirstFrame();
    this.write(jpeg, this.timeline.place(jpeg, at));
  }

  private write(first: Buffer, runs: FrameRun[]) {
    this.writing = this.writing.then(async () => {
      if (this.failure) return;
      try {
        const encoder = (this.encoder ??= this.openEncoder(first));
        const frames = runs.flatMap((run) => Array.from({ length: run.copies }, () => run.frame));
        await inSequence(frames, (frame) => encoder.write(frame));
      } catch (cause) {
        this.failure = errorFrom(cause);
      }
    });
  }

  private openEncoder(frame: Buffer) {
    const size = jpegSize(frame);
    if (!size)
      throw new ToolError("The first screencast frame is not a JPEG the encoder can size.");
    return this.startEncoder(ffmpegArgs(this.file, size));
  }

  private async lastFrame() {
    const shot = await withDeadline(this.screencast.capture(), LAST_FRAME_MS).catch(
      (): typeof TIMED_OUT => TIMED_OUT,
    );
    return shot === TIMED_OUT ? undefined : Buffer.from(shot, "base64");
  }

  private async frameOfCurrentDocument() {
    const committedAt = this.documentAt();
    if (committedAt === undefined || (this.lastFrameAt ?? 0) >= committedAt) return;
    const drawn = new Promise<void>((resolve) => {
      this.sawFrame = (at) => {
        if (at >= committedAt) resolve();
      };
    });
    await withDeadline(drawn, this.currentFrameMs);
    this.sawFrame = () => undefined;
  }

  private async finish(): Promise<RecordingResult> {
    this.state = "stopping";
    await this.frameOfCurrentDocument();
    const stoppedAt = this.now();
    this.stoppedAt = stoppedAt;
    try {
      const shown = this.encoder || this.frames ? await this.lastFrame() : undefined;
      this.captured = true;
      void this.screencast.stop().catch(() => undefined);
      if (shown) this.write(shown, this.timeline.place(shown, stoppedAt - SLOT_MS));
      const runs = this.timeline.finish(stoppedAt);
      const last = runs[0];
      if (last) this.write(last.frame, runs);
      await this.writing;
      if (this.failure) throw this.failure;
      if (!this.encoder)
        throw new ToolError(
          `The recording of ${this.tab} received no frame from the browser, so no video was written.`,
        );
      await this.encoder.end();
      this.state = "finished";
      return {
        tab: this.tab,
        file: this.file,
        durationMs: stoppedAt - this.startedAt,
        frames: this.frames,
      };
    } catch (cause) {
      this.state = "failed";
      throw cause;
    }
  }
}

type RecordedTab = Pick<Tab, "id" | "page" | "documentAt">;

export class Recordings {
  private readonly byTab = new Map<string, Recording>();
  private readonly cleanups = new Map<Recording, () => void>();
  private readonly ffmpeg: string;

  constructor(ffmpeg = "ffmpeg") {
    this.ffmpeg = ffmpeg;
  }

  async start(tab: RecordedTab, file: string, holdRendering: () => () => void) {
    const current = this.byTab.get(tab.id);
    if (current?.status().state === "recording" || current?.status().state === "stopping")
      throw new ToolError(
        `${tab.id} is already recording to ${current.file}.`,
        "Call recording with action stop for this tab first.",
      );
    const command = Bun.which(this.ffmpeg, { PATH: process.env.PATH ?? "" });
    if (!command)
      throw new ToolError(
        `${this.ffmpeg} was not found on the PATH, so the recording cannot be encoded to mp4.`,
        "Install ffmpeg on this machine and try again.",
      );
    const recording = new Recording({
      tab: tab.id,
      file,
      screencast: cdpScreencast(tab.page),
      startEncoder: spawnEncoder(command),
      documentAt: () => (tab.page.isClosed() ? undefined : tab.documentAt),
    });
    this.byTab.set(tab.id, recording);
    const onClose = () => void this.finishClosed(recording);
    tab.page.once("close", onClose);
    const releaseRendering = holdRendering();
    this.cleanups.set(recording, () => {
      tab.page.off("close", onClose);
      releaseRendering();
    });
    try {
      await recording.start();
    } catch (cause) {
      this.forget(recording);
      await recording.stop().catch(() => undefined);
      throw cause;
    }
    return recording;
  }

  async stop(tabId: string) {
    const recording = this.byTab.get(tabId);
    if (!recording) {
      const recorded = this.list().map((entry) => entry.tab);
      throw new ToolError(
        `${tabId} is not recording.`,
        recorded.length
          ? `Tabs with a recording: ${recorded.join(", ")}.`
          : "No tab is recording; start one with action start.",
      );
    }
    try {
      return await recording.stop();
    } finally {
      this.forget(recording);
    }
  }

  private forget(recording: Recording) {
    if (this.byTab.get(recording.tab) === recording) this.byTab.delete(recording.tab);
    this.release(recording);
  }

  private release(recording: Recording) {
    this.cleanups.get(recording)?.();
    this.cleanups.delete(recording);
  }

  list() {
    return [...this.byTab.values()].map((recording) => recording.status());
  }

  private async finishClosed(recording: Recording) {
    if (this.byTab.get(recording.tab) !== recording) return;
    this.release(recording);
    try {
      const result = await recording.stop();
      logEvent("recording_finished", { ...result, reason: "tab closed" });
    } catch (cause) {
      logEvent("recording_failed", { tab: recording.tab, error: messageOf(cause) }, "warn");
    }
  }
}
