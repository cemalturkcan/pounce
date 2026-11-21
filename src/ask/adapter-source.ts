import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AskAdapter } from "./adapter.ts";
import { messageOf, ToolError } from "../shared/errors.ts";

const adapterContract = z.object({ name: z.string().min(1), complete: z.instanceof(Function) });
const askAdapter = z.custom<AskAdapter>((value) => adapterContract.safeParse(value).success);
const adapterFactory = z.instanceof(Function);

export async function loadAdapterModule(modulePath: string): Promise<AskAdapter> {
  const expected =
    "Expected a default export that is an AskAdapter object ({ name: string, complete(input) }) or a function returning one.";
  if (!path.isAbsolute(modulePath))
    throw new ToolError(
      `WEB_AGENT_ASK_ADAPTER must be an absolute path, got ${modulePath}.`,
      expected,
    );
  let module: { default?: unknown };
  try {
    module = await import(pathToFileURL(modulePath).href);
  } catch (cause) {
    throw new ToolError(
      `Could not load the ask adapter at ${modulePath}: ${messageOf(cause).split("\n")[0]}`,
      expected,
    );
  }
  const exported = module.default;
  const factory = adapterFactory.safeParse(exported);
  const candidate =
    factory.success && !askAdapter.safeParse(exported).success ? await factory.data() : exported;
  const adapter = askAdapter.safeParse(candidate);
  if (!adapter.success)
    throw new ToolError(
      `The ask adapter at ${modulePath} has the wrong shape. ${expected}`,
      "Fix the module and call ask_pages again; it is loaded on first use.",
    );
  return adapter.data;
}

function adapterFromFile(file: string): AdapterChoice {
  return { key: `file:${file}`, path: file, load: () => loadAdapterModule(file) };
}

type AdapterChoice = { key: string; path?: string; load: () => Promise<AskAdapter> };

export class AskAdapterSource {
  private readonly modulePath?: string;
  private readonly defaultPath?: string;
  private readonly adapter: AskAdapter;
  private readonly loaded = new Map<string, Promise<AskAdapter>>();
  private readonly names = new Map<string, string>();

  constructor(options: { modulePath?: string; defaultPath?: string; adapter: AskAdapter }) {
    this.modulePath = options.modulePath;
    this.defaultPath = options.defaultPath;
    this.adapter = options.adapter;
  }

  private choice(): AdapterChoice {
    if (this.modulePath) return adapterFromFile(this.modulePath);
    if (this.defaultPath && existsSync(this.defaultPath)) return adapterFromFile(this.defaultPath);
    return { key: "code", load: () => Promise.resolve(this.adapter) };
  }

  get label() {
    const choice = this.choice();
    if (!choice.path) return this.adapter.name;
    const name = this.names.get(choice.key);
    return name ? `${name} (${choice.path})` : `module ${choice.path}`;
  }

  get() {
    const choice = this.choice();
    let pending = this.loaded.get(choice.key);
    if (!pending) {
      pending = choice.load().then(
        (adapter) => {
          this.names.set(choice.key, adapter.name);
          return adapter;
        },
        (cause: unknown) => {
          this.loaded.delete(choice.key);
          throw cause;
        },
      );
      this.loaded.set(choice.key, pending);
    }
    return pending;
  }
}
