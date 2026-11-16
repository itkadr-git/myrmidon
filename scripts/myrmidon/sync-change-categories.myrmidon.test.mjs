import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyChanges, parseNameStatus } from "./vendor-sync/lib.mjs";

test("parses name-status records with exact status, destination and origin", () => {
  assert.deepEqual(parseNameStatus([
    "A\tadded.txt", "M\tmodified.txt", "D\tdeleted.txt",
    "R100\told.txt\tnew.txt", "C100\tsource.txt\tcopy.txt", "T\ttype.txt", "",
  ].join("\n")), [
    { status: "A", path: "added.txt", from: null },
    { status: "M", path: "modified.txt", from: null },
    { status: "D", path: "deleted.txt", from: null },
    { status: "R", path: "new.txt", from: "old.txt" },
    { status: "C", path: "copy.txt", from: "source.txt" },
    { status: "T", path: "type.txt", from: null },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("classifies the complete matrix without losing order or object identity", () => {
  const changes = parseNameStatus([
    "A\t.github/workflows/build.yml",
    "M\t.github/workflows/nested/package.json",
    "A\t.github/workflows-extra/not.yml",
    "M\tx/.github/workflows/not.yml",
    "A\tpackages/db/src/migrations/001.sql",
    "M\tpackages/db/src/migrations/002.sql",
    "D\tpackages/db/src/migrations/003.sql",
    "A\tpackages/db/src/migrations/nested/004.sql",
    "A\tpackages/db/src/migrations/005.json",
    "A\tpackages/db/src/migrations-extra/006.sql",
    "R100\tmarked/old.ts\tunmarked/new.ts",
    "C100\tsource.ts\tmarked/copy.ts",
    "T\tapps/web/package.json",
    "M\tapps/web/pnpm-lock.yaml",
    "M\tapps/web/pnpm-workspace.yaml",
    "M\tapps/web/Dockerfile.release",
    "M\tapps/web/package.json.bak",
    "M\tapps/web/xpnpm-lock.yaml",
    "M\tapps/web/pnpm-workspace.yaml.bak",
    "M\tapps/web/notDockerfile",
    "M\tpackage.json",
    "M\tDockerfile",
  ].join("\n"));
  const expected = {
    workflows: [changes[0], changes[1]],
    migrations: [changes[4]],
    marked: [changes[1], changes[4], changes[10], changes[11]],
    dependencies: [changes[1], changes[12], changes[13], changes[14], changes[15], changes[20], changes[21]],
  };
  const actual = classifyChanges(changes, { markedFiles: [
    ".github/workflows/nested/package.json", "packages/db/src/migrations/001.sql",
    "marked/old.ts", "marked/copy.ts",
  ] });
  assert.deepEqual(actual, expected);
  for (const category of Object.keys(expected)) {
    expected[category].forEach((change, index) => assert.strictEqual(actual[category][index], change));
  }
});

test("returns all four empty categories for no changes", () => {
  assert.deepEqual(classifyChanges([], { markedFiles: ["unused"] }), {
    workflows: [], migrations: [], marked: [], dependencies: [],
  });
});
