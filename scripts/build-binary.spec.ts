import { expect, test } from "bun:test";
import { embedManifests } from "./build-binary.ts";

test("embedManifests turns the runtime package.json read into a bundled require", () => {
  expect(
    embedManifests(
      'packageJSON = require(import_path8.default.join(packageRoot, "package.json"));',
    ),
  ).toBe('packageJSON = require("../package.json");');
});

test("embedManifests turns the runtime browsers.json read into a bundled require", () => {
  expect(
    embedManifests(
      'new Registry(require(import_path19.default.join(packageRoot, "browsers.json")));',
    ),
  ).toBe('new Registry(require("../browsers.json"));');
});

test("embedManifests refuses a manifest read it cannot rewrite", () => {
  expect(() => embedManifests('require(path.join(packageRoot, "package.json"));')).toThrow(
    "reads a manifest from disk",
  );
});
