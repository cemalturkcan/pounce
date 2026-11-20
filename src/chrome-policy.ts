import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CHROME_POLICY_DIRS = [
  "/etc/opt/chrome/policies/managed",
  "/etc/opt/chrome/policies/recommended",
  "/etc/chromium/policies/managed",
  "/etc/chromium/policies/recommended",
];

const BLOCK_POLICIES = ["URLBlocklist", "URLBlacklist"];
const ALLOW_POLICIES = ["URLAllowlist", "URLWhitelist"];
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443", ftp: "21", ws: "80", wss: "443" };
const BLOCKED_ERROR = /net::ERR_BLOCKED_BY_(ADMINISTRATOR|CLIENT)(?: at (\S+))?/;

type UrlFilter = { scheme?: string; host: string; subdomains: boolean; port?: string; path: string; query: [string, string][] };

export type PolicyFile = { path: string; policies: Record<string, unknown> };
export type PolicyMatch = { file: string; policy: string; pattern: string };
export type PolicyMatches = { blocklist: PolicyMatch[]; allowlist: PolicyMatch[]; verdict: "blocked" | "allowed" | "none" };

function parseQuery(query: string): [string, string][] {
  return query
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [key = "", value = ""] = pair.split("=");
      return [key, value];
    });
}

function parseUrlFilter(raw: string): UrlFilter | undefined {
  let rest = raw.trim();
  if (!rest) return undefined;
  if (rest === "*") return { host: "", subdomains: true, path: "", query: [] };
  let scheme: string | undefined;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (schemeMatch) {
    scheme = (schemeMatch[1] ?? "").toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }
  const queryStart = rest.indexOf("?");
  const query = queryStart === -1 ? [] : parseQuery(rest.slice(queryStart + 1));
  if (queryStart !== -1) rest = rest.slice(0, queryStart);
  if (scheme === "file") return { scheme, host: "", subdomains: true, path: rest === "*" ? "" : rest.replace(/\*$/, ""), query };
  const pathStart = rest.indexOf("/");
  const authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
  const pathPart = pathStart === -1 ? "" : rest.slice(pathStart).replace(/\*$/, "");
  const hostMatch = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(authority);
  if (!hostMatch) return undefined;
  let host = (hostMatch[1] ?? "").toLowerCase();
  let subdomains = true;
  if (host.startsWith(".")) {
    subdomains = false;
    host = host.slice(1);
  }
  if (host === "*") host = "";
  return { scheme, host, subdomains, port: hostMatch[2], path: pathPart, query };
}

function filterMatches(filter: UrlFilter, url: URL) {
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (filter.scheme && filter.scheme !== scheme) return false;
  if (scheme !== "file" && filter.host) {
    const host = url.hostname.toLowerCase();
    if (host !== filter.host && !(filter.subdomains && host.endsWith(`.${filter.host}`))) return false;
  }
  if (filter.port && filter.port !== (url.port || DEFAULT_PORTS[scheme])) return false;
  const pathname = url.pathname || "/";
  if (filter.path && !pathname.startsWith(filter.path)) return false;
  return filter.query.every(([key, value]) => (value === "*" ? url.searchParams.has(key) : url.searchParams.getAll(key).includes(value)));
}

export function matchesUrlFilter(pattern: string, url: URL) {
  const filter = parseUrlFilter(pattern);
  return filter !== undefined && filterMatches(filter, url);
}

function specificity(pattern: string) {
  const filter = parseUrlFilter(pattern);
  if (!filter) return [-1, 0, 0, 0];
  return [filter.host.length, filter.subdomains ? 0 : 1, filter.path.length, filter.query.length];
}

function compareSpecificity(left: string, right: string) {
  const a = specificity(left);
  const b = specificity(right);
  for (const [index, value] of a.entries()) {
    const difference = value - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function mostSpecific(matches: PolicyMatch[]) {
  return matches.reduce<PolicyMatch | undefined>((best, match) => (!best || compareSpecificity(match.pattern, best.pattern) > 0 ? match : best), undefined);
}

function matchingPatterns(files: PolicyFile[], policies: string[], url: URL) {
  const found: PolicyMatch[] = [];
  for (const file of files) {
    for (const policy of policies) {
      const patterns = file.policies[policy];
      if (!Array.isArray(patterns)) continue;
      for (const pattern of patterns) if (typeof pattern === "string" && matchesUrlFilter(pattern, url)) found.push({ file: file.path, policy, pattern });
    }
  }
  return found;
}

export function findPolicyMatches(rawUrl: string, files: PolicyFile[]): PolicyMatches {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { blocklist: [], allowlist: [], verdict: "none" };
  }
  const blocklist = matchingPatterns(files, BLOCK_POLICIES, url);
  const allowlist = matchingPatterns(files, ALLOW_POLICIES, url);
  const block = mostSpecific(blocklist);
  const allow = mostSpecific(allowlist);
  const verdict = !block ? "none" : allow && compareSpecificity(allow.pattern, block.pattern) >= 0 ? "allowed" : "blocked";
  return { blocklist, allowlist, verdict };
}

export async function loadPolicyFiles(dirs: string[]) {
  const files: PolicyFile[] = [];
  for (const dir of dirs) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names.filter((candidate) => candidate.endsWith(".json")).sort()) {
      const file = path.join(dir, name);
      try {
        const policies = JSON.parse(await readFile(file, "utf8")) as unknown;
        if (policies && typeof policies === "object" && !Array.isArray(policies)) files.push({ path: file, policies: policies as Record<string, unknown> });
      } catch {
        continue;
      }
    }
  }
  return files;
}

const describeMatch = (match: PolicyMatch) => `${match.policy} pattern ${JSON.stringify(match.pattern)} in ${match.file}`;

export async function explainPolicyBlock(errorText: string, dirs: string[]) {
  const found = BLOCKED_ERROR.exec(errorText);
  const url = found?.[2];
  if (!found || !url) return undefined;
  const byAdministrator = found[1] === "ADMINISTRATOR";
  const matches = findPolicyMatches(url, await loadPolicyFiles(dirs));
  const block = mostSpecific(matches.blocklist);
  if (!block) {
    if (!byAdministrator) return undefined;
    return `Chrome policy: no URLBlocklist pattern in the policy files under ${dirs.join(", ")} matches ${url}; the block comes from another source, such as cloud-managed policy or an extension.`;
  }
  const lines = [`Chrome policy: ${describeMatch(block)} matches ${url}.`];
  const allow = mostSpecific(matches.allowlist);
  if (allow) {
    const outranks = matches.verdict === "allowed";
    lines.push(`${describeMatch(allow)} also matches${outranks ? " and is more specific, so these files allow the URL; the block may come from another policy source" : ", but the block pattern is more specific"}.`);
  }
  return lines.join("\n");
}
