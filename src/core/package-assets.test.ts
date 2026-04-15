import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { resolvePackageAssetPaths } from "./package-assets.js";

test("resolves the shipped package asset set from source modules", () => {
  const assets = resolvePackageAssetPaths();

  assert.equal(existsSync(assets.configExamplePath), true);
  assert.equal(existsSync(assets.promptsRoot), true);
  assert.equal(existsSync(assets.localExampleRoot), true);
  assert.equal(existsSync(assets.artifactTemplatePath), true);
  assert.equal(existsSync(assets.evidenceTemplatePath), true);
});
