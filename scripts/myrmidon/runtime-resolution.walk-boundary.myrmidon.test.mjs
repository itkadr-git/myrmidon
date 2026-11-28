import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { walkJsFiles } from "./check-prod-runtime-resolution.mjs";

test("walkJsFiles respects filesystem and vendor boundaries", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || process.env.TMPDIR;
  assert.ok(scratch, "a permitted scratch directory is required");
  const fixture = mkdtempSync(path.join(scratch, "resolution-walk-"));
  try {
    const dist = path.join(fixture, "dist");
    const files = [
      "z.cjs", "a.js", "nested/b.mjs", "nested/ignore.json", "nested/ignore.ts",
      "node_modules/root.js", "nested/node_modules/deep.js",
      "vendor/paperclip-runner/runner.js", "vendor/paperclip-runner/sub/worker.mjs",
      "vendor/paperclip-runner-extra/keep.js",
    ];
    for (const name of files) {
      const file = path.join(dist, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "// fixture\n");
    }
    const outside = path.join(fixture, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "external.js"), "// fixture\n");
    symlinkSync(outside, path.join(dist, "linked-dir"), "dir");
    symlinkSync(path.join(outside, "external.js"), path.join(dist, "linked-file.js"), "file");
    symlinkSync(dist, path.join(dist, "nested", "cycle"), "dir");

    const expected = [
      "a.js", "nested/b.mjs", "vendor/paperclip-runner-extra/keep.js",
      "vendor/paperclip-runner/runner.js", "vendor/paperclip-runner/sub/worker.mjs", "z.cjs",
    ].map((name) => path.join(dist, name)).sort();
    const withoutRunner = [
      "a.js", "nested/b.mjs", "vendor/paperclip-runner-extra/keep.js", "z.cjs",
    ].map((name) => path.join(dist, name)).sort();

    assert.deepEqual(walkJsFiles(dist), expected);
    assert.deepEqual(walkJsFiles(dist), expected);
    assert.deepEqual(walkJsFiles(dist, false), expected);
    assert.deepEqual(walkJsFiles(dist, true), withoutRunner);
    assert.deepEqual(walkJsFiles(dist, true), withoutRunner);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
