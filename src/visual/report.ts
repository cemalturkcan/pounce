import path from "node:path";
import type { Finding } from "./model.ts";
import type { Region } from "./pixels.ts";
import { describeUsage } from "../ask/render.ts";

export type ComparedRegion = Region & {
  findings?: Finding[];
  same?: boolean;
  modelError?: string;
  truncated?: boolean;
  crops?: { design: string; page: string };
};

export type CompareReport = {
  url: string;
  reference: string;
  referenceSize: { width: number; height: number };
  pageSize: { width: number; height: number };
  compared: { width: number; height: number };
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scaledPage: boolean;
  notes: string[];
  tolerance: number;
  minRegionArea: number;
  diffPixels: number;
  diffRatio: number;
  regions: ComparedRegion[];
  missing?: Finding[];
  model?: {
    id: string;
    adapter: string;
    calls: number;
    usage?: Record<string, number>;
    overviewError?: string;
    overviewTruncated?: boolean;
    setupError?: string;
    images: string;
  };
  files: { dir: string; screenshot: string; diff: string; report: string };
  text: string;
};

const MAX_LISTED_EXTRA = 20;

function percent(value: number) {
  return `${(value * 100).toFixed(value < 0.001 && value > 0 ? 3 : 2)}%`;
}

function findingLine(finding: Finding) {
  return `[${finding.severity}] [${finding.property}] ${finding.text}`;
}

function regionLine(region: ComparedRegion, deviceScaleFactor: number) {
  const css =
    deviceScaleFactor === 1
      ? ""
      : ` (CSS ${Math.round(region.x / deviceScaleFactor)},${Math.round(region.y / deviceScaleFactor)} ${Math.round(region.width / deviceScaleFactor)}x${Math.round(region.height / deviceScaleFactor)})`;
  const cutOff = region.truncated ? " (model answer cut off, findings may be incomplete)" : "";
  const head = `${region.id} x ${region.x} y ${region.y}, ${region.width}x${region.height} px${css}, ${Math.round(region.mismatch * 100)}% differ${cutOff}`;
  const [firstFinding, ...otherFindings] = region.findings ?? [];
  if (firstFinding)
    return [
      `${head}: ${findingLine(firstFinding)}`,
      ...otherFindings.map((finding) => `   ${findingLine(finding)}`),
    ];
  if (region.same) return [`${head}: the model saw no real difference (likely rendering noise)`];
  if (region.modelError)
    return [`${head}: pixel difference only (model call failed: ${region.modelError})`];
  return [`${head}: pixel difference only`];
}

export function renderReport(report: Omit<CompareReport, "text">, modelNote?: string) {
  const lines: string[] = [];
  const count = report.regions.length;
  lines.push(
    count
      ? `${count} region(s) differ; ${percent(report.diffRatio)} of the compared pixels (tolerance ${report.tolerance}, regions under ${report.minRegionArea} px² dropped).`
      : `No differences above tolerance ${report.tolerance} (regions under ${report.minRegionArea} px² are dropped); ${report.diffPixels} scattered pixel(s) differ.`,
  );
  lines.push(
    `Reference ${report.referenceSize.width}x${report.referenceSize.height}, page capture ${report.pageSize.width}x${report.pageSize.height} at viewport ${report.viewport.width}x${report.viewport.height} @${report.viewport.deviceScaleFactor}x. Coordinates are reference pixels.`,
  );
  for (const note of report.notes) lines.push(note);
  const listed = report.regions.filter(
    (region) => region.crops || report.regions.indexOf(region) < MAX_LISTED_EXTRA,
  );
  if (listed.length) lines.push("");
  for (const region of listed) lines.push(...regionLine(region, report.viewport.deviceScaleFactor));
  if (count > listed.length)
    lines.push(`…and ${count - listed.length} smaller region(s), listed in the report JSON.`);
  if (report.missing?.length) {
    lines.push("", "Missing on the page (whole-image check):");
    for (const finding of report.missing) lines.push(`- ${findingLine(finding)}`);
  }
  if (report.model) {
    const usage = report.model.usage ? describeUsage(report.model.usage) : "not reported";
    lines.push(
      "",
      `Model: ${report.model.id} through ${report.model.adapter}, ${report.model.calls} call(s). Usage: ${usage}.`,
      report.model.images,
    );
    if (report.model.overviewError)
      lines.push(`The whole-image check failed: ${report.model.overviewError}`);
    if (report.model.overviewTruncated)
      lines.push("The whole-image check was cut off; its list may be incomplete.");
  }
  if (modelNote) lines.push("", modelNote);
  lines.push(
    "",
    `Diff image: ${report.files.diff}`,
    `Screenshot: ${report.files.screenshot}`,
    `Report JSON: ${report.files.report}`,
  );
  if (report.regions.some((region) => region.crops))
    lines.push(
      `Region crops (design and page per region): ${path.join(report.files.dir, "crops")}`,
    );
  return lines.join("\n");
}
