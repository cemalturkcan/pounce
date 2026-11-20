import type { BrowserContext } from "playwright-core";
import { ToolError } from "./errors.ts";

export const PERMISSION_NAMES = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "clipboard-read",
  "clipboard-write",
  "midi",
  "midi-sysex",
  "accelerometer",
  "gyroscope",
  "magnetometer",
  "ambient-light-sensor",
  "background-sync",
  "local-fonts",
  "local-network-access",
  "payment-handler",
  "storage-access",
  "screen-wake-lock",
] as const;

export type PermissionName = (typeof PERMISSION_NAMES)[number];

type HttpCredential = { origin: string; secret: string; username: string; password: string };

export function originOf(value: string) {
  let origin: string;
  try {
    origin = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`).origin;
  } catch {
    throw new ToolError(`${value} is not a URL or origin.`, "Pass an origin such as https://intranet.example.com, or a tab on that site.");
  }
  if (origin === "null") throw new ToolError(`${value} has no web origin.`, "Pass an http or https origin such as https://intranet.example.com.");
  return origin;
}

export class ProfileSettings {
  private readonly credentials = new Map<string, HttpCredential>();
  private readonly grants = new Map<string, Set<PermissionName>>();

  async apply(context: BrowserContext) {
    if (this.credentials.size) await this.applyCredentials(context);
    for (const [origin, names] of this.grants) await context.grantPermissions([...names], { origin });
  }

  async setCredential(context: BrowserContext, credential: HttpCredential) {
    this.credentials.set(credential.origin, credential);
    await this.applyCredentials(context);
  }

  async clearCredentials(context: BrowserContext, origin?: string) {
    const removed = origin ? (this.credentials.delete(origin) ? [origin] : []) : [...this.credentials.keys()];
    if (!origin) this.credentials.clear();
    await this.applyCredentials(context);
    return removed;
  }

  listCredentials() {
    return [...this.credentials.values()].map(({ origin, secret }) => ({ origin, secret }));
  }

  private applyCredentials(context: BrowserContext) {
    return context.setHTTPCredentials([...this.credentials.values()].map(({ origin, username, password }) => ({ origin, username, password })));
  }

  async grant(context: BrowserContext, origin: string, names: PermissionName[]) {
    const merged = this.grants.get(origin) ?? new Set<PermissionName>();
    for (const name of names) merged.add(name);
    this.grants.set(origin, merged);
    await context.grantPermissions([...merged], { origin });
    return [...merged];
  }

  async clearGrants(context: BrowserContext, origin?: string) {
    const cleared = origin ? [...(this.grants.get(origin) ?? [])] : [...this.grants.values()].flatMap((names) => [...names]);
    if (origin) this.grants.delete(origin);
    else this.grants.clear();
    await context.clearPermissions();
    for (const [kept, names] of this.grants) await context.grantPermissions([...names], { origin: kept });
    return cleared;
  }
}
