import { execFile } from "node:child_process";
import { ToolError } from "./errors.ts";

export type SecretField = "password" | "username" | "otp" | (string & {});

export interface SecretStore {
  readonly backend: string;
  list(query?: string): Promise<string[]>;
  get(name: string, field: SecretField): Promise<string>;
}

type Exec = (args: string[]) => Promise<string>;

const USERNAME_KEYS = ["username", "user", "login", "email"];
const GOPASS_TIMEOUT_MS = 20_000;

function runGopass(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "gopass",
      args,
      { timeout: GOPASS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GOPASS_NO_NOTIFY: "true" } },
      (error, stdout, stderr) => {
        if (error) {
          const reason = stderr.toString().trim().split("\n")[0] || error.message;
          reject(new Error(reason));
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

function assertName(name: string) {
  if (!name || name.startsWith("-") || /[\n\r\0]/.test(name)) {
    throw new ToolError(`Invalid secret name: ${JSON.stringify(name)}`, "Use a name returned by secrets_list.");
  }
}

export function parseEntry(body: string) {
  const [first = "", ...rest] = body.split("\n");
  const fields = new Map<string, string>();
  for (const line of rest) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return { password: first.trim(), fields };
}

export class GopassStore implements SecretStore {
  readonly backend = "gopass";
  private readonly exec: Exec;

  constructor(exec: Exec = runGopass) {
    this.exec = exec;
  }

  async list(query?: string) {
    const output = await this.exec(["ls", "--flat"]).catch((error: Error) => {
      throw new ToolError(`gopass could not list entries: ${error.message}`, "Check that gopass is installed and initialised for this user.");
    });
    const names = output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!query) return names;
    const needle = query.toLowerCase();
    return names.filter((name) => name.toLowerCase().includes(needle));
  }

  async get(name: string, field: SecretField) {
    assertName(name);
    if (field === "otp") {
      return (await this.read(["otp", "-o", "--", name], name)).trim();
    }
    const entry = parseEntry(await this.read(["show", "-f", "-n", "--nofuzzysearch", "--nosync", "--", name], name));
    if (field === "password") return entry.password;
    const keys = field === "username" ? USERNAME_KEYS : [field.toLowerCase()];
    const value = keys.map((key) => entry.fields.get(key)).find((candidate) => candidate !== undefined);
    if (value === undefined) {
      throw new ToolError(
        `Secret ${name} has no ${field} field.`,
        `Available fields: password${[...entry.fields.keys()].map((key) => `, ${key}`).join("")}.`,
      );
    }
    return value;
  }

  private read(args: string[], name: string) {
    return this.exec(args).catch((error: Error) => {
      throw new ToolError(
        `gopass could not read ${name}: ${error.message}`,
        "If the GPG key is locked, ask the user to run `gopass show` once in a terminal to unlock it, then retry.",
      );
    });
  }
}

export class NoSecretStore implements SecretStore {
  readonly backend = "none";

  async list(): Promise<string[]> {
    return [];
  }

  async get(name: string): Promise<string> {
    throw new ToolError(`No secret store is configured, so ${name} cannot be read.`, "Set WEB_AGENT_SECRETS=gopass on the server.");
  }
}
