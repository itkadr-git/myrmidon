import assert from "node:assert/strict";
import { it } from "node:test";
import { classifyChanges } from "./lib.mjs";

it("classifies only added direct SQL migrations", () => {
  const changes = [
    { status: "A", path: "packages/db/src/migrations/001.sql", from: null },
    { status: "M", path: "packages/db/src/migrations/002.sql", from: null },
    { status: "D", path: "packages/db/src/migrations/003.sql", from: null },
    { status: "R", path: "packages/db/src/migrations/004.sql", from: "old.sql" },
    { status: "A", path: "packages/db/src/migrations/meta/001.json", from: null },
    { status: "A", path: "packages/db/src/migrations/nested/005.sql", from: null },
    { status: "A", path: "packages/db/src/migrations-extra/006.sql", from: null },
  ];
  const original = structuredClone(changes);
  const markedFiles = [];
  assert.deepEqual(classifyChanges(changes, { markedFiles }), {
    workflows: [], migrations: [changes[0]], marked: [], dependencies: [],
  });
  assert.deepEqual(changes, original);
  assert.deepEqual(markedFiles, []);
});

it("keeps categories independent and uses exact marked and path boundaries", () => {
  const changes = [
    { status: "A", path: ".github/workflows/package.json", from: null },
    { status: "M", path: ".github/workflows/ci.yml", from: null },
    { status: "M", path: ".github/workflows-extra/ci.yml", from: null },
    { status: "R", path: "new/file.js", from: "old/file.js" },
    { status: "R", path: "marked/new.js", from: "old/other.js" },
    { status: "M", path: "old/file.js.bak", from: null },
    { status: "M", path: "package.json", from: null },
    { status: "M", path: "nested/package.json", from: null },
    { status: "M", path: "pnpm-lock.yaml", from: null },
    { status: "M", path: "nested/pnpm-workspace.yaml", from: null },
    { status: "M", path: "Dockerfile", from: null },
    { status: "M", path: "nested/Dockerfile.cloud", from: null },
    { status: "M", path: "package.json.bak", from: null },
    { status: "M", path: "Dockerfile/x", from: null },
    { status: "A", path: "packages/db/src/migrations/007.sql", from: null },
  ];
  const markedFiles = [".github/workflows/package.json", "old/file.js", "marked/new.js", "packages/db/src/migrations/007.sql"];
  const originalChanges = structuredClone(changes);
  const originalMarked = [...markedFiles];
  assert.deepEqual(classifyChanges(changes, { markedFiles }), {
    workflows: [changes[0], changes[1]],
    migrations: [changes[14]],
    marked: [changes[0], changes[3], changes[4], changes[14]],
    dependencies: [changes[0], changes[6], changes[7], changes[8], changes[9], changes[10], changes[11]],
  });
  assert.deepEqual(changes, originalChanges);
  assert.deepEqual(markedFiles, originalMarked);
});
