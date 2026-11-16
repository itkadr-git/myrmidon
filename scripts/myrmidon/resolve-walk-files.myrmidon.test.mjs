import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { walkJsFiles } from "./check-prod-runtime-resolution.mjs";

function withFixture(files, run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache", "myrmidon-tests");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "resolve-walk-"));
  try {
    for (const file of files) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const paths = (root, names) => names.map((name) => join(root, name));

test("walks sorted JavaScript files while excluding only compiled test.js artifacts and node_modules", () => {
  withFixture([
    "z.cjs", "a.mjs", "nested/deep/entry.js", "nested/entry.cjs", "test.js",
    "foo.test.js", "foo.myrmidon.test.js", "foo.test.mjs", "foo.test.cjs",
    "nested/source.ts", "nested/entry.js.map", "nested/data.json",
    "node_modules/hidden.js", "nested/node_modules/hidden.mjs", "node_modules-copy/visible.js",
  ], (root) => {
    assert.deepEqual(walkJsFiles(root), paths(root, [
      "a.mjs", "foo.test.cjs", "foo.test.mjs", "nested/deep/entry.js",
      "nested/entry.cjs", "node_modules-copy/visible.js", "z.cjs",
    ]));
  });
});

test("missing roots return an empty list and deleted files do not remain cached", () => {
  withFixture(["keep.js", "remove.js"], (root) => {
    assert.deepEqual(walkJsFiles(join(root, "missing")), []);
    assert.deepEqual(walkJsFiles(root), paths(root, ["keep.js", "remove.js"]));
    rmSync(join(root, "remove.js"));
    assert.deepEqual(walkJsFiles(root), paths(root, ["keep.js"]));
  });
});

test("vendor runner filtering is optional and does not exclude similarly named paths", () => {
  withFixture([
    "app.js", "vendor/paperclip-runner/run.js", "vendor/paperclip-runner/nested/child.mjs",
    "vendor/paperclip-runner-copy/keep.js", "vendor/other/keep.cjs",
  ], (root) => {
    assert.deepEqual(walkJsFiles(root), paths(root, [
      "app.js", "vendor/other/keep.cjs", "vendor/paperclip-runner-copy/keep.js",
      "vendor/paperclip-runner/nested/child.mjs", "vendor/paperclip-runner/run.js",
    ]));
    assert.deepEqual(walkJsFiles(root, true), paths(root, [
      "app.js", "vendor/other/keep.cjs", "vendor/paperclip-runner-copy/keep.js",
    ]));
  });
});
