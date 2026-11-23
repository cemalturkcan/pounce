import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolError } from "../shared/errors.ts";
import { defineTool, tabParam, type ToolDeps } from "./common.ts";
import { dialogBlocked } from "../browser/dialogs.ts";
import { RECORDING_FPS, RECORDING_STATES } from "../browser/recording.ts";

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function requireTab(tab: string | undefined, action: string) {
  if (tab === undefined)
    throw new ToolError(`${action} needs tab.`, "Pass the id of the tab, for example t482913.");
  return tab.trim();
}

export function registerRecordingTools(server: McpServer, deps: ToolDeps) {
  const { manager, store, recordings } = deps;

  defineTool(server, deps, {
    name: "recording",
    title: "Record a tab to video",
    description: [
      "Record what one tab shows to an mp4 video file, for example to show a flow, an animation or a bug as it happens. start begins recording the tab; stop finishes the video and returns its path, length and the number of frames the browser sent; status lists the recordings that are running or finished. The recording has no time limit: it runs until stop, until the tab closes or until the browser closes, and a recording ended by a closed tab or browser is finished and kept for the next stop or status. Other tools keep working on the tab while it records, and a tab behind other tabs keeps recording.",
      `Frames come from the browser only when the page changes, and are written at a steady ${RECORDING_FPS} frames per second, which keeps every frame of an animation drawn at that rate, so the video plays as long and as fast as the recording ran. Every frame is fitted to the size of the first one (a resized tab gets bars). Encoding uses the ffmpeg installed on the machine; the video is saved under recordings in the output directory and kept there.`,
    ].join("\n"),
    input: {
      action: z
        .enum(["start", "stop", "status"])
        .describe(
          "start begins recording the tab, stop finishes the video and returns the file, status lists recordings.",
        ),
      tab: tabParam
        .optional()
        .describe("Tab to record or stop; needed for start and stop, not used by status."),
    },
    output: {
      tab: z.string().optional(),
      file: z.string().optional(),
      durationMs: z.number().optional(),
      frames: z.number().optional(),
      recordings: z
        .array(
          z.object({
            tab: z.string(),
            file: z.string(),
            durationMs: z.number(),
            frames: z.number(),
            state: z.enum(RECORDING_STATES),
          }),
        )
        .optional(),
    },
    runsWithDialog: true,
    racesDialogs: false,
    handler: async (input) => {
      if (input.action === "status") {
        const list = recordings.list();
        const lines = list.map(
          (entry) =>
            `${entry.tab}: ${entry.state}, ${seconds(entry.durationMs)}, ${entry.frames} frames, to ${entry.file}`,
        );
        return {
          text: lines.length ? lines.join("\n") : "No tab is recording.",
          data: { recordings: list },
        };
      }
      if (input.action === "stop") {
        const result = await recordings.stop(requireTab(input.tab, "stop"));
        return {
          text: `Recorded ${result.tab} for ${seconds(result.durationMs)} (${result.frames} frames from the browser) to ${result.file}`,
          data: result,
        };
      }
      const tab = manager.getTab(requireTab(input.tab, "start"));
      if (tab.dialog) throw dialogBlocked(tab, tab.dialog, "recording start");
      const file = await store.filePath(
        "recordings",
        store.uniqueName(`${tab.id}-recording`, "mp4"),
      );
      await recordings.start(tab, file, () => manager.holdRendering(tab));
      return {
        text: `Recording ${tab.id} to ${file}. Call recording with action stop and tab ${tab.id} to finish the video.`,
        data: { tab: tab.id, file },
      };
    },
  });
}
