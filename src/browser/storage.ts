import type { CDPSession, Page } from "playwright-core";
import { z } from "zod";
import { inSequence, untilAborted } from "../shared/async.ts";
import { pageSession } from "./page-session.ts";
import { convertedRemote } from "./evaluate.ts";
import { cancelled, ToolError } from "../shared/errors.ts";
import { shownUrl } from "../shared/output.ts";

const IDB_PAGE_SIZE = 200;
const IDB_RECORD_LIMIT = 5000;
const INDEXED_DB_OBJECT_GROUP = "indexeddb";

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
      `The tab is at ${shownUrl(page.url())}, which has no web storage origin.`,
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

const indexedDbTurns = new WeakMap<object, Promise<unknown>>();

async function holdingObjectGroup<T>(
  page: Page,
  signal: AbortSignal,
  work: (session: CDPSession) => Promise<T>,
) {
  const session = await pageSession(page);
  let abandoned = false;
  try {
    return await untilAborted(work(session), signal, () => {
      abandoned = true;
      return cancelled();
    });
  } finally {
    if (!abandoned)
      await session
        .send("Runtime.releaseObjectGroup", { objectGroup: INDEXED_DB_OBJECT_GROUP })
        .catch(() => undefined);
  }
}

export function inTurn<Key extends object, T>(
  key: Key,
  signal: AbortSignal,
  work: () => Promise<T>,
) {
  const previous = indexedDbTurns.get(key) ?? Promise.resolve();
  const turn = previous.then(() => {
    signal.throwIfAborted();
    return work();
  });
  indexedDbTurns.set(
    key,
    turn.catch(() => undefined),
  );
  return untilAborted(turn, signal, cancelled);
}

function withSession<T>(
  page: Page,
  signal: AbortSignal,
  work: (session: CDPSession) => Promise<T>,
) {
  return inTurn(page, signal, () => holdingObjectGroup(page, signal, work));
}

const STORED_BINARY_SOURCE =
  "(value) => value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? `<binary ${value.byteLength} bytes>` : value instanceof Blob ? `<blob ${value.size} bytes>` : undefined";

async function toJson(session: CDPSession, object: RemoteObject): Promise<Json> {
  if (object.objectId === undefined)
    return object.value ?? object.unserializableValue ?? object.description ?? null;
  const { value } = await convertedRemote(
    session,
    object.objectId,
    jsonSchema.optional(),
    STORED_BINARY_SOURCE,
  );
  return value ?? object.description ?? null;
}

type IdbStore = { database: string; store: string; count: number };

export async function listIndexedDb(page: Page, signal: AbortSignal) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, signal, async (session) => {
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
  signal: AbortSignal,
) {
  const securityOrigin = storageOrigin(page);
  return withSession(page, signal, async (session) => {
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

export async function exportIndexedDb(page: Page, signal: AbortSignal) {
  const stores = await listIndexedDb(page, signal);
  const contents = await inSequence(stores, async (entry) => ({
    entry,
    content: await readIndexedDbStore(page, entry.database, entry.store, signal),
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
