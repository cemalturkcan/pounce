import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ToolError } from "./errors.ts";

export function siteHost(value: string) {
  const trimmed = value.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    throw new ToolError(`${JSON.stringify(value)} is not a host name or URL.`, "Pass a host such as shop.example.com, or a tab.");
  }
  host = host.replace(/^\[|\]$/g, "").replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.:-]*$/.test(host)) {
    throw new ToolError(`${JSON.stringify(value)} has no usable host name.`, "Site notes work for http and https pages; pass a host such as shop.example.com.");
  }
  return host.replace(/:/g, "_");
}

export function siteNotesPath(sitesDir: string, host: string) {
  return path.join(sitesDir, `${host}.md`);
}

export async function readSiteNotes(sitesDir: string, host: string) {
  return readFile(siteNotesPath(sitesDir, host), "utf8").catch(() => undefined);
}

export function countNoteLines(notes: string) {
  return notes.split("\n").filter((line) => line.trim() && !line.startsWith("# ")).length;
}

export async function appendSiteNote(sitesDir: string, host: string, note: string, date = new Date()) {
  const text = note.replace(/\s*\n\s*/g, " ").trim();
  if (!text) throw new ToolError("append needs a non-empty note.");
  await mkdir(sitesDir, { recursive: true });
  const existing = await readSiteNotes(sitesDir, host);
  const header = existing === undefined ? `# ${host}\n\n` : existing.endsWith("\n") || existing === "" ? "" : "\n";
  const file = siteNotesPath(sitesDir, host);
  await appendFile(file, `${header}- ${date.toISOString().slice(0, 10)}: ${text}\n`);
  return file;
}

export async function siteNotesHint(sitesDir: string, url: string) {
  if (!/^https?:/i.test(url)) return undefined;
  let host: string;
  try {
    host = siteHost(url);
  } catch {
    return undefined;
  }
  const notes = await readSiteNotes(sitesDir, host);
  if (!notes) return undefined;
  return `Site notes exist for ${host} (${countNoteLines(notes)} lines): read them with site_notes.`;
}
