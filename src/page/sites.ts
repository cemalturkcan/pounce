import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDomain } from "tldts";
import { z } from "zod";
import { parseJson } from "../shared/decode.ts";
import { ToolError } from "../shared/errors.ts";
import { localDay } from "../shared/output.ts";

export function siteHost(value: string) {
  const trimmed = value.trim().toLowerCase();
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
      .hostname;
  } catch {
    throw new ToolError(
      `${JSON.stringify(value)} is not a host name or URL.`,
      "Pass a host such as shop.example.com, or a tab.",
    );
  }
  host = host.replace(/^\[|\]$/g, "").replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.:-]*$/.test(host)) {
    throw new ToolError(
      `${JSON.stringify(value)} has no usable host name.`,
      "Site notes work for http and https pages; pass a host such as shop.example.com.",
    );
  }
  return host.replace(/:/g, "_");
}

export function registrableDomain(host: string) {
  const bare = host.toLowerCase().replace(/\.$/, "");
  return getDomain(bare, { allowPrivateDomains: true, extractHostname: false }) ?? bare;
}

export function mainLabel(host: string) {
  if (/^\d+(\.\d+){3}$/.test(host)) return host;
  return registrableDomain(host).split(".")[0] ?? host;
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

export async function appendSiteNote(
  sitesDir: string,
  host: string,
  note: string,
  date = new Date(),
) {
  const text = note.replace(/\s*\n\s*/g, " ").trim();
  if (!text) throw new ToolError("append needs a non-empty note.");
  await mkdir(sitesDir, { recursive: true });
  const existing = await readSiteNotes(sitesDir, host);
  const header =
    existing === undefined
      ? `# ${host}\n\n`
      : existing.endsWith("\n") || existing === ""
        ? ""
        : "\n";
  const file = siteNotesPath(sitesDir, host);
  await appendFile(file, `${header}- ${localDay(date)}: ${text}\n`);
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
  return `Site notes exist for ${host} (${countNoteLines(notes)} lines): read them with site.`;
}

const settingsSchema = z.record(z.string(), z.object({ consoleCapture: z.boolean().optional() }));

type SiteSettings = z.infer<typeof settingsSchema>;

const settingsPath = (sitesDir: string) => path.join(sitesDir, "settings.json");

async function readSiteSettings(sitesDir: string): Promise<SiteSettings> {
  const text = await readFile(settingsPath(sitesDir), "utf8").catch(() => "{}");
  return parseJson(text, settingsSchema).data ?? {};
}

export async function consoleCaptureSites(sitesDir: string) {
  const settings = await readSiteSettings(sitesDir);
  return Object.keys(settings).filter((site) => settings[site]?.consoleCapture === true);
}

const settingsTurns = new Map<string, Promise<void>>();

function inSettingsTurn<T>(file: string, work: () => Promise<T>) {
  const turn = (settingsTurns.get(file) ?? Promise.resolve()).then(work);
  settingsTurns.set(
    file,
    turn.then(
      () => undefined,
      () => undefined,
    ),
  );
  return turn;
}

export async function setConsoleCapture(sitesDir: string, host: string, on: boolean) {
  const site = registrableDomain(host.replace(/^www\./, ""));
  const file = settingsPath(sitesDir);
  await inSettingsTurn(file, async () => {
    const settings = await readSiteSettings(sitesDir);
    const { consoleCapture: _, ...rest } = settings[site] ?? {};
    const next = on ? { ...rest, consoleCapture: true } : rest;
    if (Object.keys(next).length) settings[site] = next;
    else delete settings[site];
    await mkdir(sitesDir, { recursive: true });
    const staged = `${file}.${randomUUID()}.tmp`;
    await writeFile(staged, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(staged, file);
  });
  return site;
}
