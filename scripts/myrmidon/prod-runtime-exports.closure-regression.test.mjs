import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectWorkspaceClosure } from "./prod-runtime-exports.mjs";

function fixture(t, manifests) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || join(homedir(), ".cache");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "closure-regression-"));
  const index = new Map();
  for (const [name, fields] of Object.entries(manifests)) {
    const dir = join(root, name.replaceAll("/", "_"));
    mkdirSync(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...fields }, null, 2) + "\n");
    index.set(name, dir);
  }
  const originalIndex = [...index];
  const snapshot = () => [...index.values()].map((dir) => readFileSync(join(dir, "package.json")));
  const originalBytes = snapshot();
  t.after(() => {
    try {
      assert.deepEqual([...index], originalIndex);
      assert.deepEqual(snapshot(), originalBytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return index;
}

test("cycle includes each package once and excludes dev and npm dependencies", (t) => {
  const index = fixture(t, {
    "@test/a": { dependencies: { "@test/b": "workspace:*", "@test/npm": "^1.0.0" }, devDependencies: { "@test/dev": "workspace:*" } },
    "@test/b": { dependencies: { "@test/a": "workspace:^" } },
    "@test/dev": {},
    "@test/npm": {},
  });
  const result = collectWorkspaceClosure("@test/a", index);
  assert.deepEqual([...result.entries()], [["@test/a", index.get("@test/a")], ["@test/b", index.get("@test/b")]]);
});

test("diamond deduplicates its shared leaf and follows optional workspace dependencies", (t) => {
  const index = fixture(t, {
    "@test/a": { dependencies: { "@test/b": "workspace:*", "@test/c": "workspace:*" } },
    "@test/b": { dependencies: { "@test/d": "workspace:*" } },
    "@test/c": { optionalDependencies: { "@test/d": "workspace:~" } },
    "@test/d": { dependencies: {}, optionalDependencies: {} },
  });
  const result = collectWorkspaceClosure("@test/a", index);
  assert.deepEqual([...result.keys()].sort(), ["@test/a", "@test/b", "@test/c", "@test/d"]);
  for (const [name, dir] of result) assert.equal(dir, index.get(name));
  // Remove the ordinary path to prove the optional edge is followed on its own.
  const optionalOnly = fixture(t, {
    "@test/a": { optionalDependencies: { "@test/d": "workspace:*" } },
    "@test/d": {},
  });
  assert.deepEqual([...collectWorkspaceClosure("@test/a", optionalOnly).keys()].sort(), ["@test/a", "@test/d"]);
});

test("empty dependency sections return the entry alone", (t) => {
  const index = fixture(t, { "@test/a": { dependencies: {}, optionalDependencies: {}, devDependencies: {} } });
  assert.deepEqual([...collectWorkspaceClosure("@test/a", index)], [["@test/a", index.get("@test/a")]]);
});

test("missing workspace dependency fails with dependency and owner names", (t) => {
  for (const section of ["dependencies", "optionalDependencies"]) {
    const index = fixture(t, {
      "@test/a": { dependencies: { "@test/b": "workspace:*" } },
      "@test/b": { [section]: { "@test/missing": "workspace:*" } },
    });
    assert.throws(() => collectWorkspaceClosure("@test/a", index), (error) => {
      assert.match(error.message, /@test\/missing/);
      assert.match(error.message, /@test\/b/);
      assert.match(error.message, /not found/);
      return true;
    });
  }
});
