import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeployedMigrations } from "./check-deployed-migrations.mjs";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("normalizes the migrations array, preserving order and replacing duplicates", () => {
  const input = deepFreeze({
    migrations: [
      { number: 7, file: "dir/0007_first.sql", pr: 15, tag: "release-seven" },
      { number: "8", name: "dir/0008_name.sql", pr: "16" },
      { number: "9", tag: "folder/0009_tag" },
      { file: "dir/0010_inferred.sql" },
      { name: "dir/0011_inferred.sql" },
      null,
      { number: 12 },
      { file: "no-number.sql" },
      { tag: "0013_tag_only" },
      { number: "7", file: "dir/0007_last.sql", pr: "17", tag: "last" },
    ],
    deployedMigrations: [{ number: 99, file: "0099_fallback.sql" }],
  });
  assert.deepEqual([...normalizeDeployedMigrations(input)], [
    ["0007", { number: "0007", file: "0007_last.sql", pr: 17, tag: "last" }],
    ["0008", { number: "0008", file: "0008_name.sql", pr: 16, tag: null }],
    ["0009", { number: "0009", file: "0009_tag.sql", pr: null, tag: "folder/0009_tag" }],
    ["0010", { number: "0010", file: "0010_inferred.sql", pr: null, tag: null }],
    ["0011", { number: "0011", file: "0011_inferred.sql", pr: null, tag: null }],
  ]);
  assert.deepEqual(input.migrations[0], { number: 7, file: "dir/0007_first.sql", pr: 15, tag: "release-seven" });
});

test("uses deployedMigrations only when migrations is not an array", () => {
  const fallback = deepFreeze({
    migrations: { "1": "0001_ignored.sql" },
    deployedMigrations: [{ number: "2", file: "nested/0002_fallback.sql", pr: "21" }],
  });
  assert.deepEqual([...normalizeDeployedMigrations(fallback)], [
    ["0002", { number: "0002", file: "0002_fallback.sql", pr: 21, tag: null }],
  ]);
  assert.deepEqual([...normalizeDeployedMigrations(deepFreeze({
    migrations: [],
    deployedMigrations: [{ number: 2, file: "0002_ignored.sql" }],
  }))], []);
});

test("normalizes string and object map values without mutating input", () => {
  const input = deepFreeze({ migrations: {
    "0021": "nested/0021_string.sql",
    "0022": { name: "nested/0022_name.sql", pr: 22, tag: "retained" },
    "0023": { tag: "nested/0023_tag" },
    "0024": null,
    "0025": { number: "26", file: "nested/custom.sql", pr: "27" },
  } });
  assert.deepEqual([...normalizeDeployedMigrations(input)], [
    ["0021", { number: "0021", file: "0021_string.sql", pr: null, tag: null }],
    ["0022", { number: "0022", file: "0022_name.sql", pr: 22, tag: "retained" }],
    ["0023", { number: "0023", file: "0023_tag.sql", pr: null, tag: "nested/0023_tag" }],
    ["0026", { number: "0026", file: "custom.sql", pr: 27, tag: null }],
  ]);
  assert.deepEqual(input.migrations["0022"], { name: "nested/0022_name.sql", pr: 22, tag: "retained" });
});

test("returns independent maps and entries for separate calls", () => {
  const input = deepFreeze({ migrations: [{ number: 1, file: "0001_original.sql" }] });
  const first = normalizeDeployedMigrations(input);
  const second = normalizeDeployedMigrations(input);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.get("0001"), second.get("0001"));
  first.get("0001").file = "changed.sql";
  first.set("0002", { number: "0002" });
  assert.deepEqual([...second], [
    ["0001", { number: "0001", file: "0001_original.sql", pr: null, tag: null }],
  ]);
  assert.deepEqual([...normalizeDeployedMigrations(null)], []);
  assert.deepEqual([...normalizeDeployedMigrations({})], []);
});
