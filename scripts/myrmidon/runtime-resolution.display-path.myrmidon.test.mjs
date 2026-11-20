import assert from "node:assert/strict";
import { test } from "node:test";
import { formatFailures } from "./check-prod-runtime-resolution.mjs";

test("formats paths at the cwd boundary without changing failure rows", () => {
  const rows = [
    { file: "/fixture/project/..hidden/file.js", line: 3, specifier: "hidden", reason: "missing" },
    { file: "/fixture/project/src/file.js", line: 7, specifier: "inside", reason: "invalid" },
    { file: "/fixture/project/..hidden", line: 11, specifier: "directory", reason: "broken" },
    { file: "/fixture/project-other/file.js", line: 13, specifier: "sibling", reason: "external" },
    { file: "/fixture/file.js", line: 17, specifier: "parent", reason: "outside" },
    { file: "/fixture/project/src/../..hidden/nested.js", line: 19, specifier: "nested", reason: "normalized" },
  ];
  const original = structuredClone(rows);
  assert.deepEqual(formatFailures(rows, "/fixture/project"), [
    "..hidden/file.js:3 hidden → missing",
    "src/file.js:7 inside → invalid",
    "..hidden:11 directory → broken",
    "/fixture/project-other/file.js:13 sibling → external",
    "/fixture/file.js:17 parent → outside",
    "..hidden/nested.js:19 nested → normalized",
  ]);
  assert.deepEqual(rows, original);
});
