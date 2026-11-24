import { expect, test } from "bun:test";
import { embedManifests, missingManifests } from "./build-binary.ts";

const PACKAGE_READ =
  'packageJSON = require(import_path8.default.join(packageRoot, "package.json"));';
const BROWSERS_READ =
  'new Registry(require(import_path19.default.join(packageRoot, "browsers.json")));';

test("embedManifests turns the runtime package.json read into a bundled require", () => {
  expect(embedManifests(PACKAGE_READ).contents).toBe('packageJSON = require("../package.json");');
});

test("embedManifests turns the runtime browsers.json read into a bundled require", () => {
  expect(embedManifests(BROWSERS_READ).contents).toBe('new Registry(require("../browsers.json"));');
});

test("embedManifests reports the manifests it embedded", () => {
  expect(embedManifests(`${PACKAGE_READ}\n${BROWSERS_READ}`).embedded).toEqual([
    "package.json",
    "browsers.json",
  ]);
});

test("embedManifests refuses a manifest read it cannot rewrite", () => {
  expect(() => embedManifests('require(path.join(packageRoot, "package.json"));')).toThrow(
    "reads a manifest from disk",
  );
});

test("missingManifests is empty when both cores embedded both manifests", () => {
  expect(
    missingManifests(
      new Set([
        "patchright-core/package.json",
        "patchright-core/browsers.json",
        "playwright-core/package.json",
        "playwright-core/browsers.json",
      ]),
    ),
  ).toEqual([]);
});

test("missingManifests names every manifest a core never embedded", () => {
  expect(
    missingManifests(new Set(["patchright-core/package.json", "patchright-core/browsers.json"])),
  ).toEqual(["playwright-core/package.json", "playwright-core/browsers.json"]);
});
