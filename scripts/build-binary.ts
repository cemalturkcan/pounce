import path from "node:path";
import type { BunPlugin } from "bun";

const ROOT = path.join(import.meta.dir, "..");
const ARCHES = ["x64", "arm64"] as const;
const ENTRYPOINTS = ["src/server.ts", "src/script/worker.ts", "src/visual/diff-worker.ts"];
const PLAYWRIGHT_LIB = /\/node_modules\/(?:patchright-core|playwright-core)\/lib\/[^/]+\.js$/;
const MANIFEST_READ =
  /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
const LEFTOVER_READ = /join\(packageRoot, "[^"]+\.json"\)/;

export function embedManifests(source: string) {
  const rewritten = source.replace(MANIFEST_READ, 'require("../$1.json")');
  if (LEFTOVER_READ.test(rewritten))
    throw new Error(
      "A Playwright library file reads a manifest from disk in a form the build does not embed.",
    );
  return rewritten;
}

const embedPlaywrightManifests: BunPlugin = {
  name: "embed-playwright-manifests",
  setup(build) {
    build.onLoad({ filter: PLAYWRIGHT_LIB }, async (args) => ({
      contents: embedManifests(await Bun.file(args.path).text()),
      loader: "js",
    }));
  },
};

async function buildBinary(arch: (typeof ARCHES)[number]) {
  const outfile = path.join(ROOT, "dist", `pounce-linux-${arch}`);
  await Bun.build({
    entrypoints: ENTRYPOINTS.map((entry) => path.join(ROOT, entry)),
    external: ["chromium-bidi", "chromium-bidi/*"],
    plugins: [embedPlaywrightManifests],
    compile: {
      target: `bun-linux-${arch}`,
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
  });
  process.stdout.write(`${path.relative(ROOT, outfile)}\n`);
}

if (import.meta.main) await Promise.all(ARCHES.map(buildBinary));
