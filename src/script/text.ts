import { types } from "node:util";
import vm from "node:vm";
import { z } from "zod";
import type { StructuredValue } from "../shared/output.ts";

export const structuredJson: z.ZodType<StructuredValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(structuredJson),
    z.record(z.string(), structuredJson),
  ]),
);

export const BUILTIN_FUNCTIONS = [
  ["call", ["Function.prototype.call"], false],
  ["bind", ["Function.prototype.bind"], false],
  ["apply", ["Reflect.apply"], false],
  ["descriptor", ["Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor"], false],
  ["define", ["Reflect.defineProperty", "Object.defineProperty"], true],
  ["ownKeys", ["Reflect.ownKeys", "Object.getOwnPropertyNames"], true],
  ["enumerable", ["Object.prototype.propertyIsEnumerable"], true],
  ["prototypeOf", ["Object.getPrototypeOf", "Reflect.getPrototypeOf"], true],
  ["text", ["String"], true],
  ["objectTag", ["Object.prototype.toString"], false],
  ["split", ["String.prototype.split"], false],
  ["trim", ["String.prototype.trim"], false],
  ["startsWith", ["String.prototype.startsWith"], false],
  ["isArray", ["Array.isArray"], false],
  ["isError", ["Error.isError"], false],
  ["mapHas", ["Map.prototype.has"], false],
  ["mapForEach", ["Map.prototype.forEach"], false],
  ["setHas", ["Set.prototype.has"], false],
  ["setForEach", ["Set.prototype.forEach"], false],
  ["dateTime", ["Date.prototype.getTime"], false],
  ["dateText", ["Date.prototype.toISOString"], false],
  ["regExpText", ["RegExp.prototype.toString"], false],
  ["functionText", ["Function.prototype.toString"], false],
] as const;

export const BUILTIN_OBJECTS = [
  ["errorPrototype", "Error.prototype"],
  ["regExpPrototype", "RegExp.prototype"],
] as const;

export const BUILTIN_GETTERS = [
  ["mapSize", "Map.prototype", "size"],
  ["setSize", "Set.prototype", "size"],
  ["regExpSource", "RegExp.prototype", "source"],
  ["windowCheck", "", "window"],
  ["documentCheck", "Document.prototype", "URL"],
  ["nodeCheck", "Node.prototype", "nodeType"],
] as const;

export const BUILTIN_LOOKALIKES = [
  "WeakMap.prototype.has",
  "WeakSet.prototype.has",
  "Reflect.has",
  "Array.prototype.forEach",
  "Function.prototype.apply",
  "Array.prototype.toString",
  "Error.prototype.toString",
  "Number.prototype.toString",
  "Boolean.prototype.toString",
  "String.prototype.toString",
  "Symbol.prototype.toString",
  "BigInt.prototype.toString",
  "Date.prototype.toString",
] as const;

export const nativeSource = (name: string) => `function ${name}() { [native code] }`;

export const nativeName = (path: string) => path.slice(path.lastIndexOf(".") + 1);

const ENTRIES = [
  ...BUILTIN_FUNCTIONS.map(([name, paths]) => [name, paths.join(",")] as const),
  ...BUILTIN_OBJECTS,
  ...BUILTIN_GETTERS.map(([name, owner, key]) => [name, owner ? `${owner}.${key}` : key] as const),
];

const ENTRY_NAMES = ENTRIES.map(([name]) => name);

const UNREPORTED = new Set<string>(["functionText"]);

const REPORTED = ENTRIES.filter(([name]) => !UNREPORTED.has(name));

const RECEIVER_CHECKED = [
  "objectTag",
  "split",
  "trim",
  "startsWith",
  "mapHas",
  "mapForEach",
  "setHas",
  "setForEach",
  "dateTime",
  "dateText",
  "regExpText",
  "mapSize",
  "setSize",
  "regExpSource",
];

const REQUIRED = BUILTIN_FUNCTIONS.filter(([, , required]) => required).map(([name]) => name);

export const builtinsFromEntriesSource = (entries: string) => `(() => {
  const entries = ${entries};
  const unique = (index) => {
    const entry = entries[index];
    for (let other = 0; other < entries.length; other += 1)
      if (other !== index && entries[other] === entry) return undefined;
    return entry;
  };
  const builtins = {
    __proto__: null,
    ${ENTRY_NAMES.map((name, index) => `${name}: unique(${index}),`).join("\n    ")}
  };
  const { call, bind, apply } = builtins;
  builtins.invoke =
    call && bind && call.bind === bind
      ? call.bind(call)
      : apply
        ? ((wrap) => wrap)((fn, self, ...args) => apply(fn, self, args))
        : undefined;
  const probe = { __proto__: null };
  const hostMethod = (fn) => {
    try {
      builtins.invoke(fn, probe);
      return false;
    } catch (cause) {
      if (typeof cause !== "object" || cause === null || !builtins.descriptor) return false;
      return builtins.descriptor(cause, "message")?.value === "Illegal invocation";
    }
  };
  if (builtins.invoke) {
    ${RECEIVER_CHECKED.map((name) => `if (builtins.${name} && hostMethod(builtins.${name})) builtins.${name} = undefined;`).join("\n    ")}
  }
  let missing = "";
  ${REPORTED.map(([name, path]) => `if (builtins.${name} === undefined) missing += ",${path}";`).join("\n  ")}
  return {
    __proto__: null,
    builtins: builtins.invoke${REQUIRED.map((name) => ` && builtins.${name}`).join("")} ? builtins : undefined,
    missing,
  };
})()`;

export const missingBuiltins = (missing: string) => missing.split(",").filter(Boolean);

const contextGetter = (owner: string, key: string) =>
  `((owner) => (owner ? Object.getOwnPropertyDescriptor(owner, "${key}")?.get : undefined))(${owner ? `globalThis.${owner.split(".").join("?.")}` : "globalThis"})`;

const CONTEXT_BUILTINS_SOURCE = `${builtinsFromEntriesSource(
  `[${[
    ...BUILTIN_FUNCTIONS.map(([, [path]]) => path),
    ...BUILTIN_OBJECTS.map(([, path]) => path),
    ...BUILTIN_GETTERS.map(([, owner, key]) => contextGetter(owner, key)),
    ...BUILTIN_LOOKALIKES.map((path) => `globalThis.${path.split(".").join("?.")}`),
  ].join(", ")}]`,
)}.builtins`;

export const STRUCTURED_VALUE_SOURCE = `((builtins) => {
  const anonymous = (fn) => fn;
  const {
    invoke,
    define,
    descriptor,
    ownKeys,
    enumerable,
    prototypeOf,
    text,
    objectTag,
    split,
    trim,
    startsWith,
    isArray,
    isError,
    mapHas,
    mapForEach,
    setHas,
    setForEach,
    dateTime,
    dateText,
    regExpText,
    functionText,
    errorPrototype,
    regExpPrototype,
    mapSize,
    setSize,
    regExpSource,
    windowCheck,
    documentCheck,
    nodeCheck,
    special,
    uncheckedToJSON,
  } = builtins;
  const pageKinds = [
    ["Window", windowCheck],
    ["Document", documentCheck],
    ["Node", nodeCheck],
  ];
  const ancestors = [];
  const tooDeep = {};
  const MAX_DEPTH = 64;
  const branded = anonymous((value, check) => {
    if (!check) return false;
    try {
      invoke(check, value);
      return true;
    } catch {
      return false;
    }
  });
  const listLike = anonymous((value) =>
    isArray ? isArray(value) : objectTag ? invoke(objectTag, value) === "[object Array]" : false,
  );
  const errorLike = anonymous((value) => {
    if (isError ? isError(value) : objectTag && invoke(objectTag, value) === "[object Error]")
      return true;
    let link = prototypeOf(value);
    for (let steps = 0; link; steps += 1) {
      if (steps >= MAX_DEPTH) throw tooDeep;
      if (link === errorPrototype) return true;
      link = prototypeOf(link);
    }
    return false;
  });
  const unconvertible = anonymous((cause) => {
    let reason = "";
    try {
      reason =
        typeof cause === "object" && cause !== null && errorLike(cause)
          ? text(cause.name) + ": " + text(cause.message)
          : text(cause);
    } catch {
      reason = "";
    }
    return reason ? "[Unconvertible: " + reason + "]" : "[Unconvertible]";
  });
  const read = anonymous((value, key) => {
    try {
      return value[key];
    } catch (cause) {
      return unconvertible(cause);
    }
  });
  const shownText = anonymous((value) => {
    try {
      return text(value);
    } catch (cause) {
      return unconvertible(cause);
    }
  });
  const put = anonymous((copy, key, value) =>
    define(copy, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true }),
  );
  const pageRef = anonymous((value) => {
    for (let index = 0; index < pageKinds.length; index += 1) {
      const kind = pageKinds[index];
      if (branded(value, kind[1])) return "ref: <" + kind[0] + ">";
    }
    return undefined;
  });
  const numberValue = anonymous((value) => {
    if (value !== value) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return value === 0 && 1 / value < 0 ? "-0" : value;
  });
  const firstFrame = anonymous((stack) => {
    if (typeof stack !== "string" || !split || !trim || !startsWith) return undefined;
    const lines = invoke(split, stack, "\\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = invoke(trim, lines[index]);
      if (invoke(startsWith, line, "at ")) return line;
    }
    return undefined;
  });
  const absent = anonymous((value) => {
    if (typeof value === "function") return "[Function]";
    if (typeof value === "symbol") return "[" + shownText(value) + "]";
    return "[undefined]";
  });
  const part = anonymous((value, depth) => {
    const shown = visit(value, depth);
    return shown === undefined ? absent(value) : shown;
  });
  const fields = anonymous((value, depth) => {
    const copy = {};
    const keys = ownKeys(value);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== "string" || !invoke(enumerable, value, key)) continue;
      put(copy, key, part(read(value, key), depth + 1));
    }
    return copy;
  });
  const list = anonymous((value, depth) => {
    const copy = [];
    const length = value.length;
    for (let index = 0; index < length; index += 1)
      put(copy, index, part(read(value, index), depth + 1));
    return copy;
  });
  const pairs = anonymous((value, depth) => {
    const copy = [];
    invoke(
      mapForEach,
      value,
      anonymous((item, key) => {
        const pair = [];
        put(pair, 0, part(key, depth + 2));
        put(pair, 1, part(item, depth + 2));
        put(copy, copy.length, pair);
      }),
    );
    return copy;
  });
  const members = anonymous((value, depth) => {
    const copy = [];
    invoke(
      setForEach,
      value,
      anonymous((item) => put(copy, copy.length, part(item, depth + 1))),
    );
    return copy;
  });
  const errorFields = anonymous((value, depth) => {
    const copy = fields(value, depth);
    put(copy, "name", shownText(read(value, "name")));
    put(copy, "message", shownText(read(value, "message")));
    const stack = firstFrame(read(value, "stack"));
    if (stack) put(copy, "stack", stack);
    return copy;
  });
  const ownData = anonymous((owner, key) => {
    const found = descriptor(owner, key);
    return found && invoke(enumerable, found, "value") ? found.value : undefined;
  });
  const nativeFunction = anonymous((value) => {
    if (typeof value !== "function" || !functionText || !split || !trim) return false;
    const name = ownData(value, "name");
    if (typeof name !== "string") return false;
    const halves = invoke(split, invoke(functionText, value), "[native code]");
    return (
      halves.length === 2 &&
      invoke(trim, halves[0]) === "function " + name + "() {" &&
      invoke(trim, halves[1]) === "}"
    );
  });
  const builtinPrototypeToJSON = anonymous((link) => {
    const constructor = ownData(link, "constructor");
    if (typeof constructor !== "function" || ownData(constructor, "prototype") !== link)
      return false;
    if (prototypeOf(link) === null) return true;
    if (!functionText) {
      if (uncheckedToJSON) uncheckedToJSON();
      return false;
    }
    return nativeFunction(constructor) && !nativeFunction(ownData(link, "toJSON"));
  });
  const pageAddedToJSON = anonymous((value) => {
    if (!descriptor) return false;
    let link = value;
    for (let steps = 0; link; steps += 1) {
      if (steps >= MAX_DEPTH) throw tooDeep;
      if (descriptor(link, "toJSON")) return link !== value && builtinPrototypeToJSON(link);
      link = prototypeOf(link);
    }
    return false;
  });
  const container = anonymous((value, depth) => {
    const shown = special ? special(value) : undefined;
    if (shown !== undefined) return shown;
    const ref = pageRef(value);
    if (ref) return ref;
    if (listLike(value)) return list(value, depth);
    if (mapForEach && (branded(value, mapHas) || branded(value, mapSize)))
      return pairs(value, depth);
    if (setForEach && (branded(value, setHas) || branded(value, setSize)))
      return members(value, depth);
    if (dateText && branded(value, dateTime)) {
      const time = invoke(dateTime, value);
      return time !== time ? null : invoke(dateText, value);
    }
    if (regExpText && value !== regExpPrototype && branded(value, regExpSource))
      return invoke(regExpText, value);
    if (errorLike(value)) return errorFields(value, depth);
    const toJSON = value.toJSON;
    if (typeof toJSON === "function" && !pageAddedToJSON(value)) return visit(invoke(toJSON, value), depth);
    return fields(value, depth);
  });
  const visit = anonymous((value, depth) => {
    if (typeof value === "number") return numberValue(value);
    if (typeof value === "bigint") return text(value);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    for (let index = 0; index < ancestors.length; index += 1)
      if (ancestors[index] === value) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Too deep]";
    put(ancestors, ancestors.length, value);
    try {
      return container(value, depth);
    } catch (cause) {
      return cause === tooDeep ? "[Too deep]" : unconvertible(cause);
    } finally {
      ancestors.length -= 1;
    }
  });
  return anonymous((root) => visit(root, 0));
})`;

export const convertedSource = (source: string) =>
  `(async () => ${STRUCTURED_VALUE_SOURCE}(${CONTEXT_BUILTINS_SOURCE})(await ${source}))()`;

const toStructured = vm.runInThisContext(`${STRUCTURED_VALUE_SOURCE}(${CONTEXT_BUILTINS_SOURCE})`);

export function structuredValue<Root>(root: Root): StructuredValue {
  return structuredJson.optional().parse(toStructured(root));
}

const isShownText = (value: StructuredValue): value is string => typeof value === "string";

function shownText(value: StructuredValue) {
  if (value === undefined) return "undefined";
  return isShownText(value) ? value : JSON.stringify(value);
}

export const valueText = (value: StructuredValue) => shownText(value);

export const logPartText = z.unknown().transform((part) => {
  const value = structuredValue(part);
  return value === undefined && part !== undefined ? String(part) : shownText(value);
});

const withMessage = z.object({ message: z.unknown() });
const errorLike = withMessage.extend({ name: z.string() });

export function unconvertible(cause: unknown) {
  try {
    const reason = types.isNativeError(cause) ? `${cause.name}: ${cause.message}` : String(cause);
    return reason ? `[Unconvertible: ${reason}]` : "[Unconvertible]";
  } catch {
    return "[Unconvertible]";
  }
}

export function errorMessage(cause: unknown) {
  try {
    const error = withMessage.safeParse(cause);
    return error.success ? String(error.data.message) : logPartText.parse(cause);
  } catch (failure) {
    return unconvertible(failure);
  }
}

export function errorLikeName(cause: unknown) {
  try {
    return errorLike.safeParse(cause).data?.name ?? "";
  } catch {
    return "";
  }
}
