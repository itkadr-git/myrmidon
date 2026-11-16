import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkCollisions } from "./migration-guard.mjs";

const migration = (number, name) => `packages/db/src/migrations/${number}_${name}.sql`;
const nonSql = "packages/db/src/schema/not_a_migration.ts";

const collision = (type, file, number, nextFree, message, extra = {}) => ({
  type,
  file,
  number,
  ...extra,
  nextFree,
  message
});

describe("migration collision records", () => {
  it("gives main precedence and records only the first reservation for a repeated input number", () => {
    const addedMigrations = [
      migration("0423", "first"),
      nonSql,
      migration("0423", "second"),
      migration("0424", "free")
    ];
    const mainNumbers = new Set(["0420", "0423"]);
    const openPrMigrations = [{
      prNumber: 1901,
      migrations: [migration("0423", "open")]
    }];

    const records = checkCollisions({ addedMigrations, mainNumbers, openPrMigrations });

    assert.deepEqual(records, [
      collision(
        "main_collision",
        migration("0423", "first"),
        "0423",
        "0424",
        "Migration number 0423 is already occupied in main. Next free number is 0424. Renumber using: pnpm db:renumber 0423 0424"
      ),
      {
        type: "duplicate_in_pr",
        file: migration("0423", "second"),
        number: "0423",
        message: `Duplicate migration number 0423 within the current PR: ${migration("0423", "second")}`
      }
    ]);
    assert.equal(Object.hasOwn(records[0], "conflictingPr"), false);
    assert.equal(Object.hasOwn(records[0], "conflictingFile"), false);
    assert.equal(Object.hasOwn(records[1], "nextFree"), false);
  });

  it("retains the last open-PR metadata while reversing pulls changes only the conflict fields", () => {
    const addedMigrations = [migration("0425", "current")];
    const firstPulls = [
      { prNumber: 1902, migrations: [migration("0425", "first")] },
      { prNumber: 1903, migrations: [migration("0425", "last")] }
    ];
    const reversedPulls = [...firstPulls].reverse();
    const expectedMessage = (prNumber, file) =>
      `Migration number 0425 is already reserved in open PR #${prNumber} (${file}). Next free number is 0426. Renumber using: pnpm db:renumber 0425 0426`;

    const records = checkCollisions({
      addedMigrations,
      mainNumbers: new Set(["0420"]),
      openPrMigrations: firstPulls
    });
    const reversedRecords = checkCollisions({
      addedMigrations,
      mainNumbers: new Set(["0420"]),
      openPrMigrations: reversedPulls
    });

    assert.deepEqual(records, [collision(
      "open_pr_collision",
      migration("0425", "current"),
      "0425",
      "0426",
      expectedMessage(1903, migration("0425", "last")),
      { conflictingPr: 1903, conflictingFile: migration("0425", "last") }
    )]);
    assert.deepEqual(reversedRecords, [collision(
      "open_pr_collision",
      migration("0425", "current"),
      "0425",
      "0426",
      expectedMessage(1902, migration("0425", "first")),
      { conflictingPr: 1902, conflictingFile: migration("0425", "first") }
    )]);
  });

  it("computes nextFree from main and PR reservations, not a free migration in the current PR", () => {
    const records = checkCollisions({
      addedMigrations: [migration("0427", "collision"), migration("0428", "free")],
      mainNumbers: new Set(["0420", "0427"]),
      openPrMigrations: [{ prNumber: 1904, migrations: [migration("0425", "open")] }]
    });

    assert.deepEqual(records, [collision(
      "main_collision",
      migration("0427", "collision"),
      "0427",
      "0428",
      "Migration number 0427 is already occupied in main. Next free number is 0428. Renumber using: pnpm db:renumber 0427 0428"
    )]);
    assert.deepEqual(checkCollisions({
      addedMigrations: [migration("0430", "free")],
      mainNumbers: new Set(["0420"]),
      openPrMigrations: [{ prNumber: 1905, migrations: [migration("0425", "open")] }]
    }), []);
    assert.deepEqual(checkCollisions({
      addedMigrations: [nonSql],
      mainNumbers: new Set(["0420"]),
      openPrMigrations: []
    }), []);
  });

  it("returns ordered mixed records without mutating input objects or reserving duplicates", () => {
    const input = {
      addedMigrations: [migration("0424", "open"), nonSql, migration("0424", "repeat"), migration("0422", "main"), migration("0426", "free")],
      mainNumbers: new Set(["0422"]),
      openPrMigrations: [{ prNumber: 7, migrations: [migration("0424", "theirs")] }, { prNumber: 8 }]
    };
    const before = structuredClone(input);
    const expected = [
      {
        type: "open_pr_collision", file: migration("0424", "open"), number: "0424",
        conflictingPr: 7, conflictingFile: migration("0424", "theirs"), nextFree: "0425",
        message: `Migration number 0424 is already reserved in open PR #7 (${migration("0424", "theirs")}). Next free number is 0425. Renumber using: pnpm db:renumber 0424 0425`
      },
      {
        type: "duplicate_in_pr", file: migration("0424", "repeat"), number: "0424",
        message: `Duplicate migration number 0424 within the current PR: ${migration("0424", "repeat")}`
      },
      {
        type: "main_collision", file: migration("0422", "main"), number: "0422", nextFree: "0425",
        message: "Migration number 0422 is already occupied in main. Next free number is 0425. Renumber using: pnpm db:renumber 0422 0425"
      }
    ];
    assert.deepEqual(checkCollisions(input), expected);
    assert.deepEqual(input, before);
    assert.deepEqual(checkCollisions(input), expected);
    assert.deepEqual(input, before);
    assert.deepEqual(checkCollisions({
      addedMigrations: [migration("0426", "free"), migration("0427", "also_free"), nonSql],
      mainNumbers: input.mainNumbers,
      openPrMigrations: input.openPrMigrations
    }), []);
  });

  it("accepts Set, array, and object-like main inputs without mutation and stays independent across calls", () => {
    const mainSet = new Set(["0420", "0429"]);
    const mainArray = ["0420", "0429"];
    const mainObject = { *[Symbol.iterator]() { yield "0420"; yield "0429"; } };
    const addedMigrations = [migration("0430", "unique")];

    assert.deepEqual(checkCollisions({ addedMigrations, mainNumbers: mainSet, openPrMigrations: [] }), []);
    assert.deepEqual(checkCollisions({ addedMigrations, mainNumbers: mainArray, openPrMigrations: [] }), []);
    assert.deepEqual(checkCollisions({ addedMigrations, mainNumbers: mainObject, openPrMigrations: [] }), []);
    assert.deepEqual([...mainSet], ["0420", "0429"]);
    assert.deepEqual(mainArray, ["0420", "0429"]);
    assert.deepEqual(checkCollisions({
      addedMigrations: [migration("0429", "now-colliding")],
      mainNumbers: mainSet,
      openPrMigrations: []
    }), [collision(
      "main_collision",
      migration("0429", "now-colliding"),
      "0429",
      "0430",
      "Migration number 0429 is already occupied in main. Next free number is 0430. Renumber using: pnpm db:renumber 0429 0430"
    )]);
  });
});
