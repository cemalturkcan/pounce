import type { CDPSession, Page } from "playwright-core";
import { ToolError } from "./errors.ts";

export type StorageArea = "local" | "session" | "indexeddb";

const IDB_PAGE_SIZE = 200;
const IDB_RECORD_LIMIT = 5000;

type RemoteObject = { type: string; value?: unknown; objectId?: string; description?: string; unserializableValue?: string };
type DataEntry = { key: RemoteObject; primaryKey: RemoteObject; value: RemoteObject };

export function storageOrigin(page: Page) {
  const origin = new URL(page.url()).origin;
  if (!/^https?:/.test(origin)) {
    throw new ToolError(`The tab is at ${page.url()}, which has no web storage origin.`, "Navigate the tab to the site first.");
  }
  return origin;
}

export async function readWebStorage(page: Page, area: "local" | "session") {
  return page.evaluate((which) => {
    const store = which === "local" ? window.localStorage : window.sessionStorage;
    const entries: Record<string, string> = {};
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null) entries[key] = store.getItem(key) ?? "";
    }
    return entries;
  }, area);
}

async function withSession<T>(page: Page, work: (session: CDPSession) => Promise<T>) {
  const session = await page.context().newCDPSession(page);
  try {
    return await work(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function toJson(session: CDPSession, object: RemoteObject): Promise<unknown> {
  if (object.objectId === undefined) return object.value ?? object.unserializableValue ?? object.description ?? null;
  const result = (await session.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration:
      "function() { try { return JSON.stringify(this, (key, value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? `<binary ${value.byteLength} bytes>` : value instanceof Blob ? `<blob ${value.size} bytes>` : value instanceof Map ? Object.fromEntries(value) : value instanceof Set ? [...value] : value); } catch (error) { return JSON.stringify(String(this)); } }",
    returnByValue: true,
  })) as { result: { value?: string } };
  return result.result.value === undefined ? (object.description ?? null) : JSON.parse(result.result.value);
}

export type IdbStore = { database: string; store: string; count: number };

export async function listIndexedDb(page: Page) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, async (session) => {
    const { databaseNames } = (await session.send("IndexedDB.requestDatabaseNames", { securityOrigin })) as { databaseNames: string[] };
    const stores: IdbStore[] = [];
    for (const databaseName of databaseNames) {
      const { databaseWithObjectStores } = (await session.send("IndexedDB.requestDatabase", { securityOrigin, databaseName })) as {
        databaseWithObjectStores: { objectStores: { name: string }[] };
      };
      for (const objectStore of databaseWithObjectStores.objectStores) {
        const meta = (await session
          .send("IndexedDB.getMetadata", { securityOrigin, databaseName, objectStoreName: objectStore.name })
          .catch(() => ({ entriesCount: -1 }))) as { entriesCount: number };
        stores.push({ database: databaseName, store: objectStore.name, count: meta.entriesCount });
      }
    }
    return stores;
  });
}

export async function readIndexedDbStore(page: Page, databaseName: string, objectStoreName: string) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, async (session) => {
    const records: { key: unknown; value: unknown }[] = [];
    let truncated = false;
    for (let skipCount = 0; ; skipCount += IDB_PAGE_SIZE) {
      const batch = (await session.send("IndexedDB.requestData", { securityOrigin, databaseName, objectStoreName, skipCount, pageSize: IDB_PAGE_SIZE })) as {
        objectStoreDataEntries: DataEntry[];
        hasMore: boolean;
      };
      for (const entry of batch.objectStoreDataEntries) {
        records.push({ key: await toJson(session, entry.primaryKey), value: await toJson(session, entry.value) });
      }
      if (!batch.hasMore) break;
      if (records.length >= IDB_RECORD_LIMIT) {
        truncated = true;
        break;
      }
    }
    return { records, truncated };
  });
}

export async function exportIndexedDb(page: Page) {
  const stores = await listIndexedDb(page);
  const result: Record<string, Record<string, { records: { key: unknown; value: unknown }[]; truncated: boolean }>> = {};
  for (const entry of stores) {
    result[entry.database] ??= {};
    const databases = result[entry.database] ?? {};
    databases[entry.store] = await readIndexedDbStore(page, entry.database, entry.store);
  }
  return { stores, data: result };
}

export function splitStoreKey(key: string, stores: IdbStore[]) {
  const match = stores.find((entry) => `${entry.database}/${entry.store}` === key) ?? stores.filter((entry) => entry.store === key);
  const found = Array.isArray(match) ? (match.length === 1 ? match[0] : undefined) : match;
  if (!found) {
    const known = stores.map((entry) => `${entry.database}/${entry.store}`).join(", ") || "none";
    throw new ToolError(`No IndexedDB object store ${JSON.stringify(key)} for this origin.`, `Give key as database/store. Stores: ${known}.`);
  }
  return found;
}
