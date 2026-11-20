import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { resolveBuildCommit } from "../../server/scripts/write-build-stamp.mjs";

const source = fileURLToPath(new URL("../../server/scripts/write-build-stamp.mjs", import.meta.url));

test("trims sources, prefers git, and accepts arbitrary nonempty text", () => {
  assert.equal(resolveBuildCommit(" \t\n", "  supplied value \n"), "supplied value");
  assert.equal(resolveBuildCommit("  not a SHA! \n", " supplied "), "not a SHA!");
  assert.equal(resolveBuildCommit("", ""), null);
  assert.equal(resolveBuildCommit(" \n", " \t"), null);
});

test("ignores non-string inputs without coercing or mutating them", () => {
  const object = Object.freeze({ toString() { throw new Error("coercion"); } });
  const array = Object.freeze([object]);
  const values = [null, undefined, 42, true, false, object, array];
  for (const value of values) {
    assert.equal(resolveBuildCommit(value, " fallback "), "fallback");
    assert.equal(resolveBuildCommit(" \n", value), null);
    assert.equal(resolveBuildCommit(" git ", value), "git");
  }
  assert.equal(Object.isFrozen(object), true);
  assert.equal(Object.isFrozen(array), true);
  assert.equal(array.length, 1);
  assert.equal(array[0], object);
  assert.deepEqual(Object.keys(object), ["toString"]);
});

test("successive resolutions are independent", () => {
  assert.equal(resolveBuildCommit(" first ", "fallback"), "first");
  assert.equal(resolveBuildCommit(null, " second "), "second");
  assert.equal(resolveBuildCommit("", ""), null);
  assert.equal(resolveBuildCommit(" third ", null), "third");
  assert.equal(resolveBuildCommit(null, " fourth "), "fourth");
});

test("importing the real module does not execute git, create dist, or write stdout", () => {
  const scratchBase = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache");
  mkdirSync(scratchBase, { recursive: true });
  const root = mkdtempSync(join(scratchBase, "build-stamp-import-"));
  try {
    const script = join(root, "server", "scripts", "write-build-stamp.mjs");
    const bin = join(root, "bin");
    const marker = join(root, "git-called");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(bin);
    copyFileSync(source, script);
    writeFileSync(join(bin, "git"), '#!/bin/sh\nprintf called > "$MARKER"\nprintf fake-commit\n', { mode: 0o755 });
    const env = { PATH: bin, MARKER: marker, PAPERCLIP_BUILD_COMMIT: "supplied" };
    const control = spawnSync(join(bin, "git"), [], { env, encoding: "utf8" });
    assert.equal(control.status, 0);
    assert.equal(control.stdout, "fake-commit");
    assert.equal(readFileSync(marker, "utf8"), "called");
    rmSync(marker);
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(script).href)})`], { cwd: root, env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, "server", "dist")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
