import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PRODUCT_NAME } from "../config/config.ts";
import type { ConfigFormat, EntryTarget } from "./agent-config.ts";
import type { JsonValue } from "./jsonc.ts";

export const AGENT_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  vscode: "VS Code",
  windsurf: "Windsurf",
  "claude-desktop": "Claude Desktop",
} as const;

export type AgentName = keyof typeof AGENT_LABELS;
export const AGENT_NAMES = Object.keys(AGENT_LABELS).filter(
  (name): name is AgentName => name in AGENT_LABELS,
);

const ALIASES = new Map<string, AgentName>([
  ["claude-code", "claude"],
  ["gemini-cli", "gemini"],
  ["code", "vscode"],
  ["vs-code", "vscode"],
]);

export function agentName(value: string): AgentName | undefined {
  const lowered = value.trim().toLowerCase();
  return AGENT_NAMES.find((name) => name === lowered) ?? ALIASES.get(lowered);
}

export type AgentEnvironment = {
  home: string;
  configHome: string;
  env: NodeJS.ProcessEnv;
  onPath: (binary: string) => boolean;
};

export type AgentSpec = {
  name: AgentName;
  label: string;
  target: EntryTarget;
  entry: (endpoint: string, command: readonly string[], current: JsonValue) => JsonValue;
  installed: boolean;
  skillsDir?: string;
};

const jsonObject = z.record(z.string(), z.json());

function serversKeys(key: string) {
  return () => [key, PRODUCT_NAME];
}

function opencodeKeys(current: JsonValue) {
  const mcp = jsonObject.safeParse(jsonObject.safeParse(current).data?.mcp).data;
  const legacy = mcp !== undefined && Object.keys(mcp).some((key) => key !== "servers");
  return legacy ? ["mcp", PRODUCT_NAME] : ["mcp", "servers", PRODUCT_NAME];
}

function isOpencodeLegacy(current: JsonValue) {
  return opencodeKeys(current).length === 2;
}

function opencodeEntry(endpoint: string, current: JsonValue): JsonValue {
  if (isOpencodeLegacy(current)) return { type: "remote", url: endpoint, enabled: true };
  return { type: "remote", url: endpoint };
}

function firstExisting(files: string[]) {
  return files.find((file) => existsSync(file) && statSync(file).isFile()) ?? files[0] ?? "";
}

function stdioEntry(command: readonly string[]) {
  const [file = "", ...args] = command;
  return { command: file, args: [...args, "mcp"] };
}

export function callingAgent(env: NodeJS.ProcessEnv): AgentName | undefined {
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (env.GEMINI_CLI === "1") return "gemini";
  if (env.OPENCODE === "1" || env.OPENCODE_SESSION_ID) return "opencode";
  if (env.CURSOR_AGENT) return "cursor";
  if (env.AI_AGENT === "github_copilot_vscode_agent") return "vscode";
  return undefined;
}

function exists(...files: string[]) {
  return files.some((file) => existsSync(file));
}

function json(file: string, keys: EntryTarget["keys"], format: ConfigFormat = "json"): EntryTarget {
  return { file, format, keys };
}

export function agentSpecs({ home, configHome, env, onPath }: AgentEnvironment): AgentSpec[] {
  const at = (...parts: string[]) => path.join(home, ...parts);
  const sharedSkills = at(".agents", "skills");
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || at(".claude");
  const claudeFile = env.CLAUDE_CONFIG_DIR?.trim()
    ? path.join(env.CLAUDE_CONFIG_DIR.trim(), ".claude.json")
    : at(".claude.json");
  const codexHome = env.CODEX_HOME?.trim() || at(".codex");
  const geminiHome = path.join(env.GEMINI_CLI_HOME?.trim() || home, ".gemini");
  const opencodeDir = path.join(configHome, "opencode");
  return [
    {
      name: "claude",
      label: AGENT_LABELS.claude,
      target: json(claudeFile, serversKeys("mcpServers")),
      entry: (endpoint) => ({ type: "http", url: endpoint }),
      installed: onPath("claude") || exists(claudeFile, claudeDir),
      skillsDir: path.join(claudeDir, "skills"),
    },
    {
      name: "codex",
      label: AGENT_LABELS.codex,
      target: json(path.join(codexHome, "config.toml"), serversKeys("mcp_servers"), "toml"),
      entry: (endpoint) => ({ url: endpoint }),
      installed: onPath("codex") || exists(codexHome),
      skillsDir: sharedSkills,
    },
    {
      name: "cursor",
      label: AGENT_LABELS.cursor,
      target: json(at(".cursor", "mcp.json"), serversKeys("mcpServers")),
      entry: (endpoint) => ({ url: endpoint }),
      installed: onPath("cursor") || onPath("cursor-agent") || exists(at(".cursor")),
      skillsDir: sharedSkills,
    },
    {
      name: "opencode",
      label: AGENT_LABELS.opencode,
      target: json(
        firstExisting([
          path.join(opencodeDir, "opencode.json"),
          path.join(opencodeDir, "opencode.jsonc"),
        ]),
        opencodeKeys,
      ),
      entry: (endpoint, _command, current) => opencodeEntry(endpoint, current),
      installed: onPath("opencode") || exists(opencodeDir),
      skillsDir: sharedSkills,
    },
    {
      name: "gemini",
      label: AGENT_LABELS.gemini,
      target: json(path.join(geminiHome, "settings.json"), serversKeys("mcpServers")),
      entry: (endpoint) => ({ httpUrl: endpoint }),
      installed: onPath("gemini") || exists(geminiHome),
      skillsDir: sharedSkills,
    },
    {
      name: "vscode",
      label: AGENT_LABELS.vscode,
      target: json(path.join(configHome, "Code", "User", "mcp.json"), serversKeys("servers")),
      entry: (endpoint) => ({ type: "http", url: endpoint }),
      installed: onPath("code") || exists(path.join(configHome, "Code", "User")),
      skillsDir: sharedSkills,
    },
    {
      name: "windsurf",
      label: AGENT_LABELS.windsurf,
      target: json(at(".codeium", "windsurf", "mcp_config.json"), serversKeys("mcpServers")),
      entry: (endpoint) => ({ serverUrl: endpoint }),
      installed: onPath("windsurf") || exists(at(".codeium", "windsurf")),
      skillsDir: at(".codeium", "windsurf", "skills"),
    },
    {
      name: "claude-desktop",
      label: AGENT_LABELS["claude-desktop"],
      target: json(
        path.join(configHome, "Claude", "claude_desktop_config.json"),
        serversKeys("mcpServers"),
      ),
      entry: (_endpoint, command) => stdioEntry(command),
      installed: onPath("claude-desktop") || exists(path.join(configHome, "Claude")),
    },
  ];
}
