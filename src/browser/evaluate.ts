import type { Page as PatchrightPage } from "patchright";
import type { CDPSession, Page } from "playwright-core";
import { z } from "zod";
import type { Engine } from "../config/config.ts";
import { pageSession } from "./page-session.ts";
import { messageOf, ToolError } from "../shared/errors.ts";
import {
  BUILTIN_FUNCTIONS,
  BUILTIN_GETTERS,
  BUILTIN_LOOKALIKES,
  BUILTIN_OBJECTS,
  builtinsFromEntriesSource,
  missingBuiltins,
  nativeName,
  nativeSource,
  STRUCTURED_VALUE_SOURCE,
} from "../script/text.ts";

const ISOLATED_WORLD = "web-agent-isolated";

export async function evaluateMain<T>(
  engine: Engine,
  page: Page,
  expression: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (engine === "patchright") {
    // SAFETY: with the patchright engine every page comes from patchright's chromium, whose evaluate takes the extra isolatedContext argument.
    const patchrightPage = page as PatchrightPage;
    return schema.parse(
      await patchrightPage.evaluate<unknown>(expression, undefined, undefined, false),
    );
  }
  return schema.parse(await page.evaluate<unknown>(expression));
}

export async function evaluateIsolated<T>(
  engine: Engine,
  page: Page,
  expression: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (engine === "patchright") return schema.parse(await page.evaluate<unknown>(expression));
  const session = await pageSession(page);
  return inObjectGroup(session, async (objectGroup) => {
    const { frameTree } = await session.send("Page.getFrameTree");
    const { executionContextId } = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: ISOLATED_WORLD,
    });
    const evaluated = await session.send("Runtime.evaluate", {
      expression,
      contextId: executionContextId,
      objectGroup,
      awaitPromise: true,
      returnByValue: true,
    });
    return schema.parse(settled(evaluated).value);
  });
}

type RemoteObject = {
  type: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
  description?: string;
};

type Outcome = {
  result: RemoteObject;
  exceptionDetails?: { text: string; exception?: RemoteObject };
};

function settled({ result, exceptionDetails }: Outcome) {
  if (!exceptionDetails) return result;
  const thrown = exceptionDetails.exception;
  throw new Error(thrown ? (thrown.description ?? String(thrown.value)) : exceptionDetails.text);
}

const primitive = z.union([z.string(), z.number(), z.boolean(), z.null(), z.undefined()]);

function remoteValue(remote: RemoteObject): z.infer<typeof primitive> | bigint {
  const unserializable = remote.unserializableValue;
  if (unserializable === undefined) return primitive.parse(remote.value);
  return remote.type === "bigint" ? BigInt(unserializable.slice(0, -1)) : Number(unserializable);
}

type Property = { value?: RemoteObject; get?: RemoteObject };

type Owner = { objectId?: string; properties: Map<string, Property> };

async function ownProperties(session: CDPSession, objectId: string): Promise<Owner> {
  const { result, internalProperties } = await session.send("Runtime.getProperties", {
    objectId,
    ownProperties: true,
  });
  const target = internalProperties?.find((property) => property.name === "[[Target]]")?.value;
  if (target?.objectId) return ownProperties(session, target.objectId);
  return { objectId, properties: new Map(result.map((property) => [property.name, property])) };
}

const isNative = (remote: RemoteObject | undefined, name: string) =>
  remote?.type === "function" && remote.description === nativeSource(name);

const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf(".")));

function propertyReader(session: CDPSession, globalId: string) {
  const owners = new Map<string, Promise<Owner>>();
  const ownerAt = (path: string): Promise<Owner> => {
    const known = owners.get(path);
    if (known) return known;
    const found = objectIdAt(path).then((objectId) =>
      objectId ? ownProperties(session, objectId) : { properties: new Map<string, Property>() },
    );
    owners.set(path, found);
    return found;
  };
  const dataAt = async (path: string): Promise<RemoteObject | undefined> =>
    (await ownerAt(parentPath(path))).properties.get(nativeName(path))?.value;
  const objectIdAt = async (path: string): Promise<string | undefined> => {
    if (path === "") return globalId;
    const value = await dataAt(path);
    return value?.type === "object" || value?.type === "function" ? value.objectId : undefined;
  };
  return { ownerAt, dataAt };
}

const GETTERS_SOURCE = `function (descriptor, ...owners) {
  return [${BUILTIN_GETTERS.map(([, , key], index) => `owners[${index}] ? descriptor(owners[${index}], "${key}")?.get : undefined`).join(", ")}];
}`;

async function nativeGetters(
  session: CDPSession,
  objectGroup: string,
  reader: ReturnType<typeof propertyReader>,
  descriptor: RemoteObject | undefined,
) {
  const none = BUILTIN_GETTERS.map(() => undefined);
  if (!descriptor?.objectId) return none;
  const owners = await Promise.all(
    BUILTIN_GETTERS.map(async ([, path, key]) => {
      const owner = await reader.ownerAt(path);
      return owner.properties.has(key) ? owner.objectId : undefined;
    }),
  );
  const read = await session.send("Runtime.callFunctionOn", {
    objectId: descriptor.objectId,
    functionDeclaration: GETTERS_SOURCE,
    arguments: [{ objectId: descriptor.objectId }, ...owners.map(callArgument)],
    objectGroup,
  });
  if (read.exceptionDetails || !read.result.objectId) return none;
  const { properties: listed } = await ownProperties(session, read.result.objectId);
  return BUILTIN_GETTERS.map(([, , key], index) => {
    const getter = listed.get(String(index))?.value;
    return isNative(getter, `get ${key}`) ? getter : undefined;
  });
}

const callArgument = (objectId: string | undefined) => (objectId ? { objectId } : {});

async function trustedBuiltins(session: CDPSession, objectGroup: string) {
  const global = await session.send("Runtime.evaluate", { expression: "this", objectGroup });
  const globalId = global.result.objectId;
  if (!globalId) return undefined;
  const reader = propertyReader(session, globalId);
  const nativeAt = async (path: string) => {
    const value = await reader.dataAt(path);
    return isNative(value, nativeName(path)) ? value : undefined;
  };
  const functions = await Promise.all(
    BUILTIN_FUNCTIONS.map(async ([, paths]) =>
      (await Promise.all(paths.map(nativeAt))).find((found) => found !== undefined),
    ),
  );
  const objects = await Promise.all(
    BUILTIN_OBJECTS.map(async ([, path]) => {
      const value = await reader.dataAt(path);
      return value?.type === "object" ? value : undefined;
    }),
  );
  const descriptor = functions[BUILTIN_FUNCTIONS.findIndex(([name]) => name === "descriptor")];
  const getters = await nativeGetters(session, objectGroup, reader, descriptor);
  const lookalikes = await Promise.all(BUILTIN_LOOKALIKES.map(nativeAt));
  const entries = [...functions, ...objects, ...getters, ...lookalikes];
  const assembled = await session.send("Runtime.callFunctionOn", {
    objectId: globalId,
    functionDeclaration: `function (...listed) { return ${builtinsFromEntriesSource("listed")}; }`,
    arguments: entries.map((entry) => callArgument(entry?.objectId)),
    objectGroup: BUILTINS_GROUP,
  });
  if (assembled.exceptionDetails || !assembled.result.objectId) return undefined;
  const { properties } = await ownProperties(session, assembled.result.objectId);
  const builtins = properties.get("builtins")?.value;
  return {
    builtinsId: builtins?.type === "object" ? builtins.objectId : undefined,
    replaced: missingBuiltins(String(properties.get("missing")?.value?.value ?? "")),
  };
}

type DocumentBuiltins = Awaited<ReturnType<typeof trustedBuiltins>>;

const convertSource = (special: string | undefined) =>
  `function (builtins) { let unchecked = false; const value = ${STRUCTURED_VALUE_SOURCE}({ __proto__: builtins, uncheckedToJSON: () => { unchecked = true; }${special ? `, special: ${special}` : ""} })(this); return { __proto__: null, value, unchecked }; }`;

const converted = z.object({ value: z.unknown(), unchecked: z.boolean() });

const BUILTINS_GROUP = "web-agent-builtins";

const documentBuiltins = new WeakMap<CDPSession, Promise<DocumentBuiltins>>();

function builtinsOfDocument(session: CDPSession, stale?: Promise<DocumentBuiltins>) {
  const current = documentBuiltins.get(session);
  if (current && current !== stale) return current;
  const released = stale
    ? session
        .send("Runtime.releaseObjectGroup", { objectGroup: BUILTINS_GROUP })
        .catch(() => undefined)
    : Promise.resolve();
  const read = released.then(() =>
    inObjectGroup(session, (objectGroup) => trustedBuiltins(session, objectGroup)),
  );
  documentBuiltins.set(session, read);
  const forget = () => {
    if (documentBuiltins.get(session) === read) documentBuiltins.delete(session);
  };
  read.then((builtins) => {
    if (builtins?.builtinsId === undefined) forget();
  }, forget);
  return read;
}

function convertWith(
  session: CDPSession,
  objectId: string,
  builtinsId: string,
  special: string | undefined,
) {
  return session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: convertSource(special),
    arguments: [{ objectId: builtinsId }],
    returnByValue: true,
  });
}

async function plainOutcome(session: CDPSession, objectId: string) {
  try {
    return await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this; }",
      returnByValue: true,
    });
  } catch (cause) {
    if (!/Object reference chain is too long/.test(messageOf(cause))) throw cause;
    throw new ToolError(
      "The value is nested too deeply to return as plain JSON, and the page replaced built-ins the conversion needs to mark the deep part.",
      "Return a smaller part of it.",
    );
  }
}

async function convertOnce(
  session: CDPSession,
  objectId: string,
  builtins: DocumentBuiltins,
  special: string | undefined,
) {
  const outcome =
    builtins?.builtinsId === undefined
      ? await plainOutcome(session, objectId)
      : await convertWith(session, objectId, builtins.builtinsId, special);
  return { outcome, builtins };
}

export async function convertedRemote<T>(
  session: CDPSession,
  objectId: string,
  schema: z.ZodType<T>,
  special?: string,
) {
  const read = builtinsOfDocument(session);
  const first = await read;
  const { outcome, builtins } = await convertOnce(session, objectId, first, special).catch(
    async (cause: unknown) => {
      if (first?.builtinsId === undefined) throw cause;
      return convertOnce(session, objectId, await builtinsOfDocument(session, read), special);
    },
  );
  const plain = builtins?.builtinsId === undefined;
  const result = settled(outcome).value;
  const { value, unchecked } = plain
    ? { value: result, unchecked: false }
    : converted.parse(result);
  return {
    value: schema.parse(value),
    replaced: builtins?.replaced ?? [],
    plain,
    uncheckedToJSON: unchecked,
  };
}

let evaluations = 0;

async function inObjectGroup<T>(session: CDPSession, work: (objectGroup: string) => Promise<T>) {
  evaluations += 1;
  const objectGroup = `web-agent-evaluate-${evaluations}`;
  try {
    return await work(objectGroup);
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
  }
}

export async function evaluateMainValue<T>(
  page: Page,
  expression: string,
  schema: z.ZodType<T>,
): Promise<{ value: T; replaced: string[]; plain: boolean; uncheckedToJSON: boolean }> {
  const session = await pageSession(page);
  return inObjectGroup(session, async (objectGroup) => {
    const value = settled(
      await session.send("Runtime.evaluate", {
        expression,
        objectGroup,
        awaitPromise: true,
        userGesture: true,
      }),
    );
    if (value.type !== "object" || !value.objectId)
      return {
        value: schema.parse(remoteValue(value)),
        replaced: [],
        plain: false,
        uncheckedToJSON: false,
      };
    return convertedRemote(session, value.objectId, schema);
  });
}
