import type { Page } from "playwright-core";
import { z } from "zod";
import { pageSession } from "../browser/page-session.ts";

export const PAGE_FILE_FORMATS = ["pdf", "mhtml", "html"] as const;

type PageFileFormat = (typeof PAGE_FILE_FORMATS)[number];

const snapshotSchema = z.object({ data: z.string() });

async function mhtmlOf(page: Page) {
  const session = await pageSession(page);
  return snapshotSchema.parse(await session.send("Page.captureSnapshot", { format: "mhtml" })).data;
}

export function pageFile(page: Page, format: PageFileFormat): Promise<string | Buffer> {
  if (format === "pdf") return page.pdf({ printBackground: true, format: "A4" });
  if (format === "mhtml") return mhtmlOf(page);
  return page.content();
}
