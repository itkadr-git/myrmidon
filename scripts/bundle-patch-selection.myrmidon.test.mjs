import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { selectBundledDependencyPatches } from "./prepare-bundled-package.mjs";

function withFixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".myrmidon-scratch");
  mkdirSync(scratch, { recursive: true });
  const dir = mkdtempSync(join(scratch, "bundle-patch-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function manifest(dir, packageName, contents) {
  const packageDir = join(dir, "node_modules", packageName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), contents);
}

test("selects only installed versions for scoped and unscoped packages, once each", () => withFixture((dir) => {
  manifest(dir, "alpha", JSON.stringify({ name: "alpha", version: "2.0.0" }));
  manifest(dir, "@scope/beta", JSON.stringify({ name: "@scope/beta", version: "1.0.0" }));
  assert.deepEqual(selectBundledDependencyPatches(dir, ["alpha", "@scope/beta", "alpha", "@scope/beta"], {
    "alpha@1.0.0": "patches/alpha-old.patch",
    "alpha@2.0.0": "patches/alpha-new.patch",
    "@scope/beta@1.0.0": "patches/beta.patch",
    "@scope/beta@2.0.0": "patches/beta-new.patch",
    "other@1.0.0": "patches/other.patch",
  }), [
    { packageName: "alpha", specifier: "alpha@2.0.0", patchPath: "patches/alpha-new.patch" },
    { packageName: "@scope/beta", specifier: "@scope/beta@1.0.0", patchPath: "patches/beta.patch" },
  ]);
}));

test("unpatched dependency does not require an installed manifest", () => withFixture((dir) => {
  assert.deepEqual(selectBundledDependencyPatches(dir, ["unpatched"], { "other@1.0.0": "other.patch" }), []);
}));

test("missing or invalid manifests report a read failure", () => withFixture((dir) => {
  const select = () => selectBundledDependencyPatches(dir, ["alpha"], { "alpha@1.0.0": "alpha.patch" });
  assert.throws(select, /alpha: failed to read/);
  manifest(dir, "alpha", "{ invalid json");
  assert.throws(select, /alpha: failed to read/);
}));

test("rejects manifest name mismatch and empty version", () => withFixture((dir) => {
  const select = () => selectBundledDependencyPatches(dir, ["alpha"], { "alpha@1.0.0": "alpha.patch" });
  manifest(dir, "alpha", JSON.stringify({ name: "other", version: "1.0.0" }));
  assert.throws(select, /expected name and a version/);
  manifest(dir, "alpha", JSON.stringify({ name: "alpha", version: "" }));
  assert.throws(select, /expected name and a version/);
}));

test("rejects an installed version without a configured patch", () => withFixture((dir) => {
  manifest(dir, "alpha", JSON.stringify({ name: "alpha", version: "2.0.0" }));
  assert.throws(() => selectBundledDependencyPatches(dir, ["alpha"], { "alpha@1.0.0": "alpha.patch" }), /installed alpha@2\.0\.0, but configured patches are alpha@1\.0\.0/);
}));

test("rejects an empty patch path", () => withFixture((dir) => {
  manifest(dir, "alpha", JSON.stringify({ name: "alpha", version: "1.0.0" }));
  assert.throws(() => selectBundledDependencyPatches(dir, ["alpha"], { "alpha@1.0.0": "" }), /Patch path for alpha@1\.0\.0 must be a non-empty string/);
}));
