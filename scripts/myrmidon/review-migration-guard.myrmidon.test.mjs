import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectMigrationViolation } from "./review-approve-label.mjs";

const root = "packages/db/src/migrations";
const sql = `${root}/0042_existing.sql`;
const snapshot = `${root}/meta/0042_snapshot.json`;
const staleSql = `${root}/0041_new.sql`;
const staleSnapshot = `${root}/meta/0041_snapshot.json`;
const overwrite = (path) => ({ reason: "migration-overwrite", path });
const stale = (path) => ({ reason: "migration-stale-number", path });

const cases = [
  ["rejects an existing SQL path", [sql], [sql], overwrite(sql)],
  ["rejects an existing snapshot path", [snapshot], [snapshot], overwrite(snapshot)],
  ["rejects new SQL below the highest SQL", [staleSql], [sql], stale(staleSql)],
  ["rejects a new snapshot below the highest SQL", [staleSnapshot], [sql], stale(staleSnapshot)],
  ["rejects new SQL below the highest snapshot", [staleSql], [snapshot], stale(staleSql)],
  ["rejects a new snapshot below the highest snapshot", [staleSnapshot], [snapshot], stale(staleSnapshot)],
  ["accepts an equal SQL number with a different basename", [`${root}/0042_other.sql`], [sql], null],
  ["accepts an equal snapshot number when only SQL exists", [snapshot], [sql], null],
  ["accepts higher SQL and snapshot numbers", [`${root}/0043_new.sql`, `${root}/meta/0043_snapshot.json`], [sql, snapshot], null],
  ["accepts null inputs", null, null, null],
  ["accepts an empty PR against main", [], [sql], null],
  ["accepts a new migration against null main", [staleSql], null, null],
  ["accepts a new migration against empty main", [staleSql], [], null],
  ["ignores three-digit SQL and snapshots", [`${root}/041_old.sql`, `${root}/meta/041_snapshot.json`], [sql], null],
  ["ignores five-digit SQL and snapshots", [`${root}/00041_old.sql`, `${root}/meta/00041_snapshot.json`], [sql], null],
  ["ignores sibling migration directories", ["packages/db/src/migrations-old/0041_new.sql", "packages/db/src/migrations/meta-old/0041_snapshot.json"], [sql], null],
  ["ignores SQL outside migrations", ["packages/db/src/0041_new.sql"], [sql], null],
  ["ignores nested SQL and snapshots", [`${root}/nested/0041_new.sql`, `${root}/meta/nested/0041_snapshot.json`], [sql], null],
  ["ignores non-matching main paths when finding the maximum", [sql], [`${root}/nested/9999_fake.sql`, `${root}/meta/99999_snapshot.json`], null],
  ["returns the first stale error before a later overwrite", [staleSnapshot, sql], [sql], stale(staleSnapshot)],
  ["returns the first overwrite before a later stale error", [sql, staleSnapshot], [sql], overwrite(sql)],
  ["prefers overwrite when the same path is also below the maximum", [staleSql], [staleSql, sql], overwrite(staleSql)],
];

describe("migration guard boundary contract", () => {
  for (const [name, prFiles, mainFiles, expected] of cases) {
    it(name, () => {
      assert.deepStrictEqual(detectMigrationViolation(prFiles, mainFiles), expected);
    });
  }

  it("does not mutate either input", () => {
    const prFiles = Object.freeze([staleSnapshot, sql]);
    const mainFiles = Object.freeze([sql, snapshot]);
    assert.deepStrictEqual(detectMigrationViolation(prFiles, mainFiles), stale(staleSnapshot));
    assert.deepStrictEqual(prFiles, [staleSnapshot, sql]);
    assert.deepStrictEqual(mainFiles, [sql, snapshot]);
  });
});
