import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { sleep } from "../src/shared/async.ts";
import { CLOCK_CELLS } from "./fixture.ts";
import { useToolsHarness } from "./tools-harness.ts";

const { mcp, call, ok, fixture, openedTab } = useToolsHarness("recording");

const probeSchema = z.object({
  streams: z.array(z.object({ nb_frames: z.string(), width: z.number(), height: z.number() })),
  format: z.object({ duration: z.string() }),
});

async function probe(file: string) {
  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=nb_frames,width,height",
    "-of",
    "json",
    file,
  ]);
  const parsed = probeSchema.parse(JSON.parse(stdout));
  return {
    seconds: Number(parsed.format.duration),
    frames: Number(parsed.streams[0]?.nb_frames ?? 0),
  };
}

const resultSchema = z.object({
  tab: z.string(),
  file: z.string(),
  durationMs: z.number(),
  frames: z.number(),
});

const statusSchema = z.object({
  recordings: z.array(
    z.object({ tab: z.string(), file: z.string(), frames: z.number(), state: z.string() }),
  ),
});

const rateSchema = z.object({
  streams: z.array(z.object({ r_frame_rate: z.string(), nb_frames: z.string() })),
  format: z.object({ duration: z.string() }),
});

async function declaredAndPlayedRate(file: string) {
  const { stdout } = await promisify(execFile)("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=r_frame_rate,nb_frames",
    "-of",
    "json",
    file,
  ]);
  const parsed = rateSchema.parse(JSON.parse(stdout));
  const [frames, per] = (parsed.streams[0]?.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    declared: (frames ?? 0) / (per ?? 1),
    played: Number(parsed.streams[0]?.nb_frames ?? 0) / Number(parsed.format.duration),
  };
}

async function clockReadings(file: string) {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${CLOCK_CELLS}:1:flags=area`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  return Array.from({ length: stdout.length / CLOCK_CELLS }, (_, frame) =>
    [...stdout.subarray(frame * CLOCK_CELLS, (frame + 1) * CLOCK_CELLS)].reduce(
      (ms, cell) => ms * 2 + (cell > 127 ? 10 : 0),
      0,
    ),
  );
}

async function clockAdvance(file: string, fromSecond: number, toSecond: number) {
  const { declared } = await declaredAndPlayedRate(file);
  const readings = await clockReadings(file);
  return (
    (readings[Math.round(toSecond * declared)] ?? 0) -
    (readings[Math.round(fromSecond * declared)] ?? 0)
  );
}

async function lastFrameColor(file: string) {
  const { stdout } = await promisify(execFile)(
    "ffmpeg",
    ["-v", "error", "-i", file, "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer" },
  );
  const last = stdout.subarray(-3);
  return { red: last[0] ?? 0, green: last[1] ?? 0, blue: last[2] ?? 0 };
}

async function openAnimated() {
  return openedTab(await ok("navigate", { url: `${fixture().url}/animate` }));
}

async function recordedFor(tab: string, ms: number) {
  await ok("recording", { action: "start", tab });
  await sleep(ms);
  const stopped = await call("recording", { action: "stop", tab });
  expect(stopped.isError, stopped.text).toBe(false);
  return { text: stopped.text, result: resultSchema.parse(stopped.structured) };
}

async function framesOf(tab: string) {
  const status = statusSchema.parse((await call("recording", { action: "status" })).structured);
  return status.recordings.find((entry) => entry.tab === tab)?.frames ?? 0;
}

describe("recording an animated page for about 3 s", () => {
  let tab = "";
  let recorded: Awaited<ReturnType<typeof recordedFor>>;

  test("stop returns the mp4 path in text and structured content", async () => {
    tab = await openAnimated();
    recorded = await recordedFor(tab, 3000);
    expect(recorded.text).toContain(recorded.result.file);
  });

  test("the mp4 is saved under recordings in the output directory", () => {
    expect(path.dirname(recorded.result.file)).toBe(path.join(mcp.config.outputDir, "recordings"));
  });

  test("the file is a non-empty mp4", async () => {
    expect((await stat(recorded.result.file)).size).toBeGreaterThan(0);
  });

  test("the video plays about as long as the recording ran", async () => {
    const { seconds } = await probe(recorded.result.file);
    expect(Math.abs(seconds - recorded.result.durationMs / 1000)).toBeLessThan(0.2);
  });

  test("the recording ran about 3 s", () => {
    expect(recorded.result.durationMs).toBeGreaterThan(2900);
  });

  test("the video has frames", async () => {
    expect((await probe(recorded.result.file)).frames).toBeGreaterThan(0);
  });

  test("the browser sent frames for the animation", () => {
    expect(recorded.result.frames).toBeGreaterThan(30);
  });
});

describe("recording a page that draws its clock on every frame for about 6 s", () => {
  let recorded: Awaited<ReturnType<typeof recordedFor>>;

  test("the clock in the video advances 4 s between its 1 s and 5 s marks", async () => {
    const tab = openedTab(await ok("navigate", { url: `${fixture().url}/clock` }));
    recorded = await recordedFor(tab, 6000);
    expect(Math.abs((await clockAdvance(recorded.result.file, 1, 5)) - 4000)).toBeLessThan(200);
  });

  test("the video holds as many frames per second as its header declares", async () => {
    const { declared, played } = await declaredAndPlayedRate(recorded.result.file);
    expect(Math.abs(played - declared)).toBeLessThan(declared * 0.05);
  });

  test("the video keeps nearly every frame the browser sent", async () => {
    const shown = new Set(await clockReadings(recorded.result.file)).size;
    expect(shown).toBeGreaterThan(recorded.result.frames * 0.9);
  });
});

test("the clock of a tab behind another one advances in the video as fast as in the page", async () => {
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/clock` }));
  const front = await openAnimated();
  await mcp.deps.manager.getTab(front).page.bringToFront();
  const { result } = await recordedFor(tab, 6000);
  expect(Math.abs((await clockAdvance(result.file, 1, 5)) - 4000)).toBeLessThan(200);
});

test("other tools keep working on a tab while it records", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  try {
    expect(await ok("evaluate", { tab, expression: "document.title" })).toContain(
      "Fixture Animate",
    );
  } finally {
    await ok("recording", { action: "stop", tab });
  }
});

test("a tab that is not the active one keeps sending frames while it records", async () => {
  const recordedTab = await openAnimated();
  const front = await openAnimated();
  await mcp.deps.manager.getTab(front).page.bringToFront();
  await ok("recording", { action: "start", tab: recordedTab });
  try {
    await sleep(500);
    const early = await framesOf(recordedTab);
    await sleep(1500);
    expect(await framesOf(recordedTab)).toBeGreaterThan(early + 20);
  } finally {
    await ok("recording", { action: "stop", tab: recordedTab });
  }
});

test("status lists a running recording", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  try {
    expect(await ok("recording", { action: "status" })).toMatch(
      new RegExp(`^${tab}: recording, `, "m"),
    );
  } finally {
    await ok("recording", { action: "stop", tab });
  }
});

test("stop finishes the video while the tab has an open dialog", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  await ok("evaluate", { tab, expression: "setTimeout(() => alert('Hold on'), 50)" });
  await sleep(300);
  const stopped = await call("recording", { action: "stop", tab });
  await ok("tabs", { close: [tab] });
  expect(stopped.text).toMatch(/^Recorded /);
});

test("start is refused while the tab has an open dialog", async () => {
  const tab = await openAnimated();
  await ok("evaluate", { tab, expression: "setTimeout(() => alert('Hold on'), 50)" });
  await sleep(300);
  const started = await call("recording", { action: "start", tab });
  await ok("tabs", { close: [tab] });
  expect(started.text).toMatch(/An alert dialog is open: "Hold on"/);
});

test("status says so when no tab is recording", async () => {
  expect(await ok("recording", { action: "status" })).toBe("No tab is recording.");
});

test("start on a tab that is already recording fails clearly", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  try {
    expect((await call("recording", { action: "start", tab })).text).toMatch(
      new RegExp(`${tab} is already recording to `),
    );
  } finally {
    await ok("recording", { action: "stop", tab });
  }
});

test("stop on a tab that is not recording fails clearly", async () => {
  const tab = await openAnimated();
  expect((await call("recording", { action: "stop", tab })).text).toMatch(
    new RegExp(`${tab} is not recording`),
  );
});

test("start without tab fails clearly", async () => {
  expect((await call("recording", { action: "start" })).text).toMatch(/start needs tab/);
});

test("start fails clearly when ffmpeg is not installed", async () => {
  const tab = await openAnimated();
  const saved = process.env.PATH;
  process.env.PATH = await mkdtemp(path.join(tmpdir(), "web-agent-no-ffmpeg-"));
  try {
    expect((await call("recording", { action: "start", tab })).text).toMatch(
      /ffmpeg was not found on the PATH/,
    );
  } finally {
    process.env.PATH = saved;
  }
});

test("closing the tab finishes the video for the next stop", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  await sleep(1000);
  await ok("tabs", { close: [tab] });
  const stopped = resultSchema.parse((await call("recording", { action: "stop", tab })).structured);
  expect((await probe(stopped.file)).seconds).toBeGreaterThan(0.8);
});

test("closing a recorded tab releases its rendering hold", async () => {
  const { manager } = mcp.deps;
  const holdRendering = manager.holdRendering.bind(manager);
  let held = 0;
  manager.holdRendering = (target) => {
    held += 1;
    const release = holdRendering(target);
    return () => {
      held -= 1;
      release();
    };
  };
  try {
    const tab = await openAnimated();
    await ok("recording", { action: "start", tab });
    await ok("tabs", { close: [tab] });
    await sleep(500);
    expect(held).toBe(0);
    await call("recording", { action: "stop", tab });
  } finally {
    manager.holdRendering = holdRendering;
  }
});

test("closing the browser finishes the video for the next stop", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  await sleep(1000);
  await mcp.deps.manager.shutdown();
  const stopped = resultSchema.parse((await call("recording", { action: "stop", tab })).structured);
  expect((await probe(stopped.file)).seconds).toBeGreaterThan(0.8);
});

test("status right after the tab closed shows its recording stopping or finished", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  await sleep(500);
  await ok("tabs", { close: [tab] });
  const status = statusSchema.parse((await call("recording", { action: "status" })).structured);
  expect(["stopping", "finished"]).toContain(
    status.recordings.find((entry) => entry.tab === tab)?.state ?? "missing",
  );
  await call("recording", { action: "stop", tab });
});

test("a page loaded right before stop is the last frame of the video", async () => {
  const tab = await openAnimated();
  await ok("recording", { action: "start", tab });
  await sleep(1000);
  await ok("navigate", {
    tab,
    url: "data:text/html,<body style='margin:0;background:rgb(255,0,0)'></body>",
  });
  const stopped = resultSchema.parse((await call("recording", { action: "stop", tab })).structured);
  const { red, green, blue } = await lastFrameColor(stopped.file);
  expect(red - Math.max(green, blue)).toBeGreaterThan(150);
  await ok("tabs", { close: [tab] });
});

test("a page from the same site loaded with the default wait right before stop is the last frame of a tab behind another one", async () => {
  const tab = openedTab(await ok("navigate", { url: `${fixture().url}/` }));
  const front = await openAnimated();
  await mcp.deps.manager.getTab(front).page.bringToFront();
  await ok("recording", { action: "start", tab });
  await sleep(1000);
  await ok("navigate", { tab, url: `${fixture().url}/slow-style` });
  const stopped = resultSchema.parse((await call("recording", { action: "stop", tab })).structured);
  const { red, green, blue } = await lastFrameColor(stopped.file);
  expect(red - Math.max(green, blue)).toBeGreaterThan(150);
  await ok("tabs", { close: [tab, front] });
});
