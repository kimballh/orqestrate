import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  resolvePackageAssetPaths,
  resolvePackageRoot,
  resolveWorkspacePackageAssetPaths,
} from "./package-assets.js";

test("resolves the shipped package asset set from source modules", () => {
  const assets = resolvePackageAssetPaths();

  assert.equal(existsSync(assets.configExamplePath), true);
  assert.equal(existsSync(assets.promptsRoot), true);
  assert.equal(existsSync(assets.localExampleRoot), true);
  assert.equal(existsSync(assets.artifactTemplatePath), true);
  assert.equal(existsSync(assets.evidenceTemplatePath), true);
});

test("prefers a symlinked CLI entry path over the source checkout path", (t) => {
  const assets = resolvePackageAssetPaths();
  const tempRoot = path.join(tmpdir(), `orq-package-assets-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const consumerNodeModules = path.join(tempRoot, "consumer", "node_modules");
  const consumerBinRoot = path.join(consumerNodeModules, ".bin");
  const linkedPackageRoot = path.join(consumerNodeModules, "orqestrate");
  const linkedCliEntryPath = path.join(consumerBinRoot, "orq");

  mkdirSync(consumerBinRoot, { recursive: true });
  symlinkSync(assets.packageRoot, linkedPackageRoot, "dir");
  symlinkSync(path.join("..", "orqestrate", "dist", "index.js"), linkedCliEntryPath);
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const linkedModuleUrl = pathToFileURL(path.join(assets.packageRoot, "dist", "index.js")).href;
  const resolvedRoot = resolvePackageRoot(linkedModuleUrl, linkedCliEntryPath);

  assert.equal(resolvedRoot, linkedPackageRoot);
  assert.notEqual(resolvedRoot, assets.packageRoot);
});

test("prefers a workspace-local install when one exists", (t) => {
  const assets = resolvePackageAssetPaths();
  const tempRoot = path.join(tmpdir(), `orq-package-assets-workspace-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const localInstallRoot = path.join(tempRoot, "node_modules", "orqestrate");

  mkdirSync(path.dirname(localInstallRoot), { recursive: true });
  symlinkSync(assets.packageRoot, localInstallRoot, "dir");
  t.after(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const resolvedAssets = resolveWorkspacePackageAssetPaths(
    tempRoot,
    pathToFileURL(path.join(assets.packageRoot, "dist", "index.js")).href,
  );

  assert.equal(resolvedAssets.packageRoot, localInstallRoot);
});
