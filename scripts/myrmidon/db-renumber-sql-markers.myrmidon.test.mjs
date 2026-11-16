import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { updateSqlMarkers } from "./db-renumber-migration.mjs";

const from = "0423";
const to = "0424";
const oldTag = "0423_example";
const newTag = "0424_example";
const update = (sql) => updateSqlMarkers(sql, from, to, oldTag, newTag);

const cases = [
  ["exact tag in a comment", "-- 0423_example\nSELECT 1;\n", "-- 0424_example\nSELECT 1;\n"],
  ["exact tag inside text", "SELECT 'before 0423_example after';\n", "SELECT 'before 0424_example after';\n"],
  ["migration underscore", "SELECT 'migration_0423_task';\n", "SELECT 'migration_0424_task';\n"],
  ["lowercase migration and space", "-- migration 0423\nSELECT 1;\n", "-- migration 0424\nSELECT 1;\n"],
  ["uppercase Migration and space", "-- Migration 0423\nSELECT 1;\n", "-- Migration 0424\nSELECT 1;\n"],
  ["comment number prefix", "-- 0423_other\nSELECT 1;\n", "-- 0424_other\nSELECT 1;\n"],
  ["single-quoted prefix", "SELECT '0423_other';\n", "SELECT '0424_other';\n"],
  ["double-quoted prefix", "SELECT \"0423_other\";\n", "SELECT \"0424_other\";\n"],
  ["backtick-quoted prefix", "SELECT `0423_other`;\n", "SELECT `0424_other`;\n"],
  ["multiple occurrences", "-- migration 0423\nSELECT 'migration_0423', 'migration_0423';\n-- migration 0423\n", "-- migration 0424\nSELECT 'migration_0424', 'migration_0424';\n-- migration 0424\n"],
  ["no marker", "-- ordinary SQL\nSELECT 423, 'unrelated';\n", "-- ordinary SQL\nSELECT 423, 'unrelated';\n"],
  ["preserves CRLF and surrounding SQL", "BEGIN;\r\n-- 0423_other\r\nSELECT 1;\r\nCOMMIT;", "BEGIN;\r\n-- 0424_other\r\nSELECT 1;\r\nCOMMIT;"],
  ["several marker forms", "-- 0423_example\nSELECT 'migration_0423', '0423_other';\n-- Migration 0423\n", "-- 0424_example\nSELECT 'migration_0424', '0424_other';\n-- Migration 0424\n"],
  ["replacement applies inside larger text", "SELECT 'x_migration_0423_suffix';", "SELECT 'x_migration_0424_suffix';"],
  ["unrelated numbers remain", "SELECT 0423, 'x0423_other', '0425_other';\n-- 0423_other\n", "SELECT 0423, 'x0423_other', '0425_other';\n-- 0424_other\n"],
];

describe("SQL migration marker replacement", () => {
  for (const [name, input, expected] of cases) {
    it(name, () => {
      assert.equal(update(input), expected);
    });
  }

  it("does not change the result when applied twice with the same numbers", () => {
    const input = "-- 0423_example\nSELECT 'migration_0423', '0423_other';\n-- Migration 0423\n";
    const expected = "-- 0424_example\nSELECT 'migration_0424', '0424_other';\n-- Migration 0424\n";
    const once = update(input);
    assert.equal(once, expected);
    assert.equal(update(once), expected);
  });
});
