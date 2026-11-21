import type { CDPSession, Page } from "playwright-core";
import { z } from "zod";
import { inSequence } from "../shared/async.ts";
import { parseJsonOrThrow } from "../shared/decode.ts";
import { ToolError } from "../shared/errors.ts";

const IDB_PAGE_SIZE = 200;
const IDB_RECORD_LIMIT = 5000;

const jsonSchema = z.json();

type Json = z.infer<typeof jsonSchema>;

const remoteObjectSchema = z.object({
  value: jsonSchema.optional(),
  objectId: z.string().optional(),
  description: z.string().optional(),
  unserializableValue: z.string().optional(),
});

type RemoteObject = z.infer<typeof remoteObjectSchema>;

const dataPageSchema = z.object({
  objectStoreDataEntries: z.array(
    z.object({ primaryKey: remoteObjectSchema, value: remoteObjectSchema }),
  ),
  hasMore: z.boolean(),
});

const stringifiedSchema = z.object({ result: z.object({ value: z.string().optional() }) });

const webStorageSchema = z.array(z.tuple([z.string(), z.string()]));

export function decodeWebStorage(stored: z.input<typeof webStorageSchema>) {
  const entries: Record<string, string> = Object.fromEntries(webStorageSchema.parse(stored));
  Object.setPrototypeOf(entries, null);
  return entries;
}

type IdbRecord = { key: Json; value: Json };

export function storageOrigin(page: Page) {
  const origin = new URL(page.url()).origin;
  if (!/^https?:/.test(origin)) {
    throw new ToolError(
      `The tab is at ${page.url()}, which has no web storage origin.`,
      "Navigate the tab to the site first.",
    );
  }
  return origin;
}

export async function readWebStorage(page: Page, area: "local" | "session") {
  const stored = await page.evaluate((which) => {
    const store = which === "local" ? window.localStorage : window.sessionStorage;
    const entries: [string, string][] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null) entries.push([key, store.getItem(key) ?? ""]);
    }
    return entries;
  }, area);
  return decodeWebStorage(stored);
}

async function withSession<T>(page: Page, work: (session: CDPSession) => Promise<T>) {
  const session = await page.context().newCDPSession(page);
  try {
    return await work(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function toJson(session: CDPSession, object: RemoteObject): Promise<Json> {
  if (object.objectId === undefined)
    return object.value ?? object.unserializableValue ?? object.description ?? null;
  const result = stringifiedSchema.parse(
    await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        "function() { try { return JSON.stringify(this, (key, value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? `<binary ${value.byteLength} bytes>` : value instanceof Blob ? `<blob ${value.size} bytes>` : value instanceof Map ? Object.fromEntries(value) : value instanceof Set ? [...value] : value); } catch (error) { return JSON.stringify(String(this)); } }",
      returnByValue: true,
    }),
  );
  return result.result.value === undefined
    ? (object.description ?? null)
    : parseJsonOrThrow(result.result.value, jsonSchema);
}

type IdbStore = { database: string; store: string; count: number };

export async function listIndexedDb(page: Page) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, async (session) => {
    const { databaseNames } = await session.send("IndexedDB.requestDatabaseNames", {
      securityOrigin,
    });
    const perDatabase = await inSequence(databaseNames, async (databaseName) => {
      const { databaseWithObjectStores } = await session.send("IndexedDB.requestDatabase", {
        securityOrigin,
        databaseName,
      });
      return inSequence(
        databaseWithObjectStores.objectStores,
        async (objectStore): Promise<IdbStore> => {
          const meta = await session
            .send("IndexedDB.getMetadata", {
              securityOrigin,
              databaseName,
              objectStoreName: objectStore.name,
            })
            .catch(() => ({ entriesCount: -1 }));
          return { database: databaseName, store: objectStore.name, count: meta.entriesCount };
        },
      );
    });
    return perDatabase.flat();
  });
}

export async function readIndexedDbStore(
  page: Page,
  databaseName: string,
  objectStoreName: string,
) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, async (session) => {
    const readFrom = async (
      skipCount: number,
      records: IdbRecord[],
    ): Promise<{ records: IdbRecord[]; truncated: boolean }> => {
      const batch = dataPageSchema.parse(
        await session.send("IndexedDB.requestData", {
          securityOrigin,
          databaseName,
          objectStoreName,
          skipCount,
          pageSize: IDB_PAGE_SIZE,
        }),
      );
      const decoded = await inSequence(
        batch.objectStoreDataEntries,
        async (entry): Promise<IdbRecord> => ({
          key: await toJson(session, entry.primaryKey),
          value: await toJson(session, entry.value),
        }),
      );
      records.push(...decoded);
      if (!batch.hasMore) return { records, truncated: false };
      if (records.length >= IDB_RECORD_LIMIT) return { records, truncated: true };
      return readFrom(skipCount + IDB_PAGE_SIZE, records);
    };
    return readFrom(0, []);
  });
}

export async function exportIndexedDb(page: Page) {
  const stores = await listIndexedDb(page);
  const contents = await inSequence(stores, async (entry) => ({
    entry,
    content: await readIndexedDbStore(page, entry.database, entry.store),
  }));
  const result: Record<string, Record<string, { records: IdbRecord[]; truncated: boolean }>> = {};
  for (const { entry, content } of contents) {
    result[entry.database] ??= {};
    const databases = result[entry.database] ?? {};
    databases[entry.store] = content;
  }
  return { stores, data: result };
}

export function splitStoreKey(key: string, stores: IdbStore[]) {
  const match =
    stores.find((entry) => `${entry.database}/${entry.store}` === key) ??
    stores.filter((entry) => entry.store === key);
  const found = Array.isArray(match) ? (match.length === 1 ? match[0] : undefined) : match;
  if (!found) {
    const known = stores.map((entry) => `${entry.database}/${entry.store}`).join(", ") || "none";
    throw new ToolError(
      `No IndexedDB object store ${JSON.stringify(key)} for this origin.`,
      `Give key as database/store. Stores: ${known}.`,
    );
  }
  return found;
}
