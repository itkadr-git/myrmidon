import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectScannableFiles } from "../../check-no-git-push.mjs";

function fixture(t) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(os.homedir(), "cache", "scratch");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, "no-push-discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function put(root, relative) {
  const absolute = path.join(root, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, "fixture\n");
}

function expected(root, names) {
  return names.map((name) => {
    const absolute = path.join(root, name);
    return { relative: path.relative(root, absolute).split(path.sep).join("/"), absolute };
  }).sort((a, b) => a.relative.localeCompare(b.relative));
}

function collect(root, scanRoot = root) {
  return collectScannableFiles(scanRoot, root).sort((a, b) => a.relative.localeCompare(b.relative));
}

test("discovers exactly the supported extensions and skips excluded files", (t) => {
  const root = fixture(t);
  const included = ["a.ts", "b.tsx", "c.js", "d.mjs", "e.cjs", "nested/src/f.ts"];
  const excluded = ["types.d.ts", "nested/src/types.d.ts", "data.json", "README.md", "nested/src/data.json", "nested/src/README.md"];
  for (const name of [...included, ...excluded]) put(root, name);
  const actual = collect(root);
  assert.deepEqual(actual, expected(root, included));
  for (const name of included) assert.ok(actual.some((entry) => entry.absolute === path.join(root, name)), name);
  for (const name of excluded) assert.ok(!actual.some((entry) => entry.absolute === path.join(root, name)), name);
});

test("skips each excluded directory at root and nested levels, but scans similar names", (t) => {
  const root = fixture(t);
  const included = ["dist-tools/a.ts", "builders/b.js", "nested/src/c.tsx", "nested/dist-tools/d.mjs", "nested/builders/e.cjs"];
  const skipped = ["node_modules", "dist", "build", ".turbo", ".next", "coverage"];
  for (const name of included) put(root, name);
  for (const dir of skipped) {
    put(root, `${dir}/excluded.ts`);
    put(root, `nested/src/${dir}/deeper/excluded.js`);
    put(root, `${dir}/nested/src/excluded.mjs`);
  }
  assert.deepEqual(collect(root), expected(root, included));
});

test("normalizes paths relative to the repository when scanning a nested root", (t) => {
  const root = fixture(t);
  const included = ["packages/adapter/src/a.ts", "packages/adapter/src/nested/b.js"];
  for (const name of included) put(root, name);
  put(root, "outside.ts");
  assert.deepEqual(collect(root, path.join(root, "packages", "adapter")), expected(root, included));
});

test("returns no files for missing, file, and empty roots", (t) => {
  const root = fixture(t);
  put(root, "root.ts");
  mkdirSync(path.join(root, "empty"));
  assert.deepEqual(collect(root, path.join(root, "missing")), []);
  assert.deepEqual(collect(root, path.join(root, "root.ts")), []);
  assert.deepEqual(collect(root, path.join(root, "empty")), []);
});
