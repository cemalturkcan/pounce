import path from "node:path";
import type { BunPlugin } from "bun";

const ROOT = path.join(import.meta.dir, "..");
const TARGETS = { x64: "bun-linux-x64-baseline", arm64: "bun-linux-arm64" } as const;
const ARCHES = ["x64", "arm64"] as const;
const ENTRYPOINTS = ["src/server.ts", "src/script/worker.ts", "src/visual/diff-worker.ts"];
const CORES = ["patchright-core", "playwright-core"];
const MANIFESTS = ["package.json", "browsers.json"];
const PLAYWRIGHT_LIB = /\/node_modules\/(patchright-core|playwright-core)\/lib\/[^/]+\.js$/;
const MANIFEST_READ =
  /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
const LEFTOVER_READ = /join\(packageRoot, "[^"]+\.json"\)/;

export function embedManifests(source: string) {
  const embedded = [...source.matchAll(MANIFEST_READ)].map((match) => `${match[1]}.json`);
  const contents = source.replace(MANIFEST_READ, 'require("../$1.json")');
  if (LEFTOVER_READ.test(contents))
    throw new Error(
      "A Playwright library file reads a manifest from disk in a form the build does not embed.",
    );
  return { contents, embedded };
}

export function missingManifests(embedded: ReadonlySet<string>) {
  return CORES.flatMap((core) => MANIFESTS.map((name) => `${core}/${name}`)).filter(
    (manifest) => !embedded.has(manifest),
  );
}

function embedPlaywrightManifests(embedded: Set<string>): BunPlugin {
  return {
    name: "embed-playwright-manifests",
    setup(build) {
      build.onLoad({ filter: PLAYWRIGHT_LIB }, async (args) => {
        const core = PLAYWRIGHT_LIB.exec(args.path)?.[1];
        const result = embedManifests(await Bun.file(args.path).text());
        for (const name of result.embedded) embedded.add(`${core}/${name}`);
        return { contents: result.contents, loader: "js" };
      });
    },
  };
}

export async function buildBinary(
  arch: (typeof ARCHES)[number],
  outfile = path.join(ROOT, "dist", `pounce-linux-${arch}`),
) {
  const embedded = new Set<string>();
  await Bun.build({
    entrypoints: ENTRYPOINTS.map((entry) => path.join(ROOT, entry)),
    root: path.join(ROOT, "src"),
    external: ["chromium-bidi", "chromium-bidi/*"],
    plugins: [embedPlaywrightManifests(embedded)],
    compile: {
      target: TARGETS[arch],
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  const missing = missingManifests(embedded);
  if (missing.length > 0)
    throw new Error(`The ${arch} binary would read ${missing.join(", ")} from disk at runtime.`);
  process.stdout.write(`${path.relative(ROOT, outfile)}\n`);
}

if (import.meta.main) await Promise.all(ARCHES.map((arch) => buildBinary(arch)));
