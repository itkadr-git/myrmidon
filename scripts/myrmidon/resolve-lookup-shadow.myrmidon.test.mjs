import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { resolveMyrmidonSpecifier } from "./check-prod-runtime-resolution.mjs";

const name = "@myrmidon/lookup-shadow-fixture";

function fixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), ".cache", "myrmidon-tests");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(scratch, "resolve-lookup-")));
  try {
    const from = path.join(root, "app", "dist");
    fs.mkdirSync(from, { recursive: true });
    run(root, from);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function packageAt(dir, target, createTarget = true) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, exports: `./${target}` }));
  if (createTarget) fs.writeFileSync(path.join(dir, target), "export default true;\n");
}

function packageDir(base) {
  return path.join(base, "node_modules", "@myrmidon", "lookup-shadow-fixture");
}

it("prefers the nearest package and falls back after it is removed", () => fixture((root, from) => {
  const ancestor = packageDir(root);
  const near = packageDir(path.join(root, "app"));
  packageAt(ancestor, "ancestor.js");
  packageAt(near, "near.js");
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: near, packageName: name, follow: path.join(near, "near.js") });
  fs.rmSync(near, { recursive: true });
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: ancestor, packageName: name, follow: path.join(ancestor, "ancestor.js") });
}));

it("follows a symlink to the real package and target", () => fixture((root, from) => {
  const ancestor = packageDir(root);
  const near = packageDir(path.join(root, "app"));
  const real = path.join(root, "real-package");
  packageAt(ancestor, "ancestor.js");
  packageAt(real, "linked.js");
  fs.mkdirSync(path.dirname(near), { recursive: true });
  fs.symlinkSync(real, near, "dir");
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: real, packageName: name, follow: path.join(real, "linked.js") });
}));

it("reports a missing package with its package name", () => fixture((root, from) => {
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { failure: "пакет не найден в node_modules", packageName: name });
  const ancestor = packageDir(root);
  packageAt(ancestor, "ancestor.js");
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: ancestor, packageName: name, follow: path.join(ancestor, "ancestor.js") });
}));

it("does not fall back when the nearest target is missing and rereads changed manifests", () => fixture((root, from) => {
  const ancestor = packageDir(root);
  const near = packageDir(path.join(root, "app"));
  packageAt(ancestor, "ancestor.js");
  packageAt(near, "first.js");
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: near, packageName: name, follow: path.join(near, "first.js") });
  packageAt(near, "missing.js", false);
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { failure: "файл не собран", packageName: name });
  packageAt(near, "second.js");
  assert.deepEqual(resolveMyrmidonSpecifier(name, from), { pkgDir: near, packageName: name, follow: path.join(near, "second.js") });
}));
