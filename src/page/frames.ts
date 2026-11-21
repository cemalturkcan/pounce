import type { Frame, Page } from "playwright-core";
import { TIMED_OUT, withDeadline } from "../shared/async.ts";
import { frameMarkdown } from "./markdown.ts";

const FRAME_READ_MS = 5000;

function frameInnerText() {
  return (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

async function readFrame(frame: Frame, format: "text" | "markdown") {
  const reading = format === "markdown" ? frameMarkdown(frame) : frame.evaluate(frameInnerText);
  const text = await withDeadline(reading, FRAME_READ_MS).catch(
    (error: Error) => `[frame not readable: ${error.message.split("\n")[0]}]`,
  );
  return text === TIMED_OUT ? `[frame did not answer within ${FRAME_READ_MS} ms]` : text;
}

export async function framesText(page: Page, format: "text" | "markdown") {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame() && !frame.isDetached());
  const sections = await Promise.all(
    frames.map(async (frame) => {
      const text = await readFrame(frame, format);
      return text ? `--- frame: ${frame.url()} ---\n${text}` : "";
    }),
  );
  return sections.filter(Boolean).join("\n\n");
}
