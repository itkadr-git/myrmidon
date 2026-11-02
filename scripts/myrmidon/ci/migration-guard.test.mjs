import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  migrationNumber,
  parseMigrationNumber,
  calculateNextAvailableNumber,
  checkMainCollisions,
  openPrWarnings,
  checkGeneratorCollisions,
  checkCollisions,
  runGuard
} from "./migration-guard.mjs";

const sql = (name) => `packages/db/src/migrations/${name}.sql`;

describe("migration-guard (main suite)", () => {
  it("migrationNumber extracts 4-digit number from paths", () => {
    assert.equal(migrationNumber("packages/db/src/migrations/0421_fuzzy_avengers.sql"), "0421");
    assert.equal(migrationNumber("0421_fuzzy_avengers.sql"), "0421");
    assert.equal(migrationNumber("packages/db/src/migrations/meta/_journal.json"), null);
    assert.equal(migrationNumber("packages/db/src/migrations/0421_snapshot.json"), null);
    assert.equal(migrationNumber("packages/db/src/migrations/not_a_migration.sql"), null);
    assert.equal(migrationNumber(null), null);
    assert.equal(migrationNumber(undefined), null);
  });

  it("0421 already in main fails with the next free number", () => {
    const main = [sql("0420_alpha"), sql("0421_fuzzy_avengers")];
    const added = [sql("0421_my_duplicate")];
    const errors = checkMainCollisions(main, added);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /0421 is already occupied in main/);
    assert.match(errors[0], /Next free number: 0422/);
  });

  it("one PR cannot introduce two SQL migrations with the same number", () => {
    const main = [sql("0420_alpha")];
    const added = [sql("0421_first"), sql("0421_second")];
    const errors = checkMainCollisions(main, added);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /duplicate migration number 0421 within the same PR/);
  });

  it("an open PR collision warns but does not fail openPrWarnings", () => {
    assert.deepEqual(openPrWarnings([sql("0422_ours")], [
      { number: 1802, files: [sql("0422_theirs"), sql("0423_other")] },
    ]), ["Migration number 0422 is also used by open PR #1802: " + sql("0422_theirs") + ". Coordinate renumbering before merge."]);
  });

  it("unrelated PRs and non-SQL files have no collision", () => {
    assert.deepEqual(openPrWarnings([sql("0422_ours")], [
      { number: 1803, files: [sql("0421_merged_already"), "packages/db/src/schema/issues.ts"] },
    ]), []);
  });
});

describe("migration-guard (OPE-10067 acceptance & collision suite)", () => {
  it("parseMigrationNumber extracts 4-digit prefix", () => {
    assert.equal(parseMigrationNumber("packages/db/src/migrations/0423_colorful_jazinda.sql"), "0423");
    assert.equal(parseMigrationNumber("0424_clear_stale_replay_holds.sql"), "0424");
    assert.equal(parseMigrationNumber("non-migration.sql"), null);
  });

  it("calculates next available migration number taking into account main and open PRs", () => {
    const occupied = new Set(["0420", "0421", "0422", "0423"]);
    assert.equal(calculateNextAvailableNumber(occupied), "0424");

    const withGap = new Set(["0420", "0422"]);
    assert.equal(calculateNextAvailableNumber(withGap), "0423");

    assert.equal(calculateNextAvailableNumber([]), "0000");
  });

  it("detects no collision when migration number is unique", () => {
    const addedMigrations = ["packages/db/src/migrations/0424_new_feature.sql"];
    const mainNumbers = new Set(["0420", "0421", "0422", "0423"]);
    const openPrMigrations = [
      { prNumber: 100, migrations: ["packages/db/src/migrations/0422_other.sql"] }
    ];

    const collisions = checkCollisions({ addedMigrations, mainNumbers, openPrMigrations });
    assert.equal(collisions.length, 0);
  });

  it("detects collision when migration number is already occupied in main", () => {
    const addedMigrations = ["packages/db/src/migrations/0423_my_feature.sql"];
    const mainNumbers = new Set(["0420", "0421", "0422", "0423"]);
    const openPrMigrations = [];

    const collisions = checkCollisions({ addedMigrations, mainNumbers, openPrMigrations });
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].type, "main_collision");
    assert.equal(collisions[0].number, "0423");
    assert.equal(collisions[0].nextFree, "0424");
    assert.match(collisions[0].message, /pnpm db:renumber 0423 0424/);
  });

  it("acceptance criteria: two parallel PRs with the same number — the second PR fails with open_pr_collision", () => {
    const mainNumbers = new Set(["0420", "0421", "0422"]);

    // Case 1: First PR (#1997) adds 0423
    const pr1Added = ["packages/db/src/migrations/0423_colorful_jazinda.sql"];
    const pr1Collisions = checkCollisions({
      addedMigrations: pr1Added,
      mainNumbers,
      openPrMigrations: []
    });
    assert.equal(pr1Collisions.length, 0);

    // Case 2: Second PR (#2012) also adds 0423 in parallel
    const pr2Added = ["packages/db/src/migrations/0423_clear_stale_replay_holds.sql"];
    const openPrsForPr2 = [
      { prNumber: 1997, migrations: ["packages/db/src/migrations/0423_colorful_jazinda.sql"] }
    ];
    const pr2Collisions = checkCollisions({
      addedMigrations: pr2Added,
      mainNumbers,
      openPrMigrations: openPrsForPr2
    });

    assert.equal(pr2Collisions.length, 1);
    assert.equal(pr2Collisions[0].type, "open_pr_collision");
    assert.equal(pr2Collisions[0].number, "0423");
    assert.equal(pr2Collisions[0].conflictingPr, 1997);
    assert.equal(pr2Collisions[0].nextFree, "0424");
    assert.match(pr2Collisions[0].message, /already reserved in open PR #1997/);
    assert.match(pr2Collisions[0].message, /pnpm db:renumber 0423 0424/);
  });

  it("runGuard returns ok: false with actionable error and nextFree for parallel PR collision", async () => {
    const result = await runGuard({
      addedMigrations: ["packages/db/src/migrations/0423_dup.sql"],
      mainNumbers: new Set(["0421", "0422"]),
      openPrMigrations: [
        { prNumber: 1997, migrations: ["packages/db/src/migrations/0423_first.sql"] }
      ]
    });

    assert.equal(result.ok, false);
    assert.equal(result.collisions.length, 1);
    assert.equal(result.collisions[0].nextFree, "0424");
  });

  it("runGuard returns ok: true when no new migrations are added", async () => {
    const result = await runGuard({
      addedMigrations: [],
      mainNumbers: new Set(["0421", "0422"]),
      openPrMigrations: []
    });

    assert.equal(result.ok, true);
    assert.equal(result.collisions.length, 0);
  });
});
