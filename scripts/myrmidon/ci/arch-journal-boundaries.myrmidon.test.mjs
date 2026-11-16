import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { checkMigrations, TEST_HOOKS } from "./arch-invariants-gate.mjs";

const migrations = "packages/db/src/migrations";
const journal = `${migrations}/meta/_journal.json`;
const files = ["0179_a.sql", "0180_b.sql", "0181_c.sql"];
const clean = [
  { idx: 179, tag: "0179_a" },
  { idx: 180, tag: "0180_b" },
  { idx: 181, tag: "0181_c" },
];

function withFixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "arch-journal-"));
  const previous = TEST_HOOKS.migrationBaselineOverride;
  try {
    const dir = path.join(root, migrations);
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(dir, file), "-- migration\n");
    TEST_HOOKS.migrationBaselineOverride = "none";
    const check = (entries) => {
      fs.writeFileSync(path.join(root, journal), JSON.stringify({ entries }));
      return checkMigrations(root);
    };
    run(check);
  } finally {
    TEST_HOOKS.migrationBaselineOverride = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it("accepts consistent files and journal at the boundary", () => withFixture((check) => {
  assert.deepEqual(check(clean), []);
}));

it("grandfathers duplicate and mismatched numeric idx below 180", () => withFixture((check) => {
  assert.deepEqual(check([
    { idx: 179, tag: "0179_a" },
    { idx: 179, tag: "0180_b" },
    { idx: 181, tag: "0181_c" },
  ]), []);
}));

it("reports exact duplicate and mismatch diagnostics at 180 and 181", () => withFixture((check) => {
  assert.deepEqual(check([
    { idx: 180, tag: "0179_a" },
    { idx: 180, tag: "0180_b" },
    { idx: 181, tag: "0181_c" },
  ]), [
    "packages/db/src/migrations/meta/_journal.json: entry 0 idx 180 does not match tag 0179_a (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: duplicate journal idx 180 (0179_a, 0180_b) (INV-13)",
  ]);
  assert.deepEqual(check([
    { idx: 179, tag: "0179_a" },
    { idx: 181, tag: "0180_b" },
    { idx: 181, tag: "0181_c" },
  ]), [
    "packages/db/src/migrations/meta/_journal.json: entry 1 idx 181 does not match tag 0180_b (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: duplicate journal idx 181 (0180_b, 0181_c) (INV-13)",
  ]);
}));

it("does not apply numeric idx checks to nonnumeric values", () => withFixture((check) => {
  assert.deepEqual(check([
    { idx: "180", tag: "0179_a" },
    { idx: "180", tag: "0180_b" },
    { idx: null, tag: "0181_c" },
  ]), []);
}));

it("reports count mismatch independently of ordering", () => withFixture((check) => {
  assert.deepEqual(check([clean[1], clean[0]]), [
    "packages/db/src/migrations/meta/_journal.json: journal/file count mismatch (2 vs 3) (INV-13)",
  ]);
}));

it("reports each position when equal counts have a different order", () => withFixture((check) => {
  assert.deepEqual(check([clean[0], clean[2], clean[1]]), [
    "packages/db/src/migrations/meta/_journal.json: journal order mismatch at 1: 0181_c.sql vs 0180_b.sql (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: journal order mismatch at 2: 0180_b.sql vs 0181_c.sql (INV-13)",
  ]);
}));

it("keeps all idx findings before ordered file findings", () => withFixture((check) => {
  assert.deepEqual(check([
    { idx: 180, tag: "0181_c" },
    { idx: 180, tag: "0180_b" },
    { idx: 181, tag: "0179_a" },
  ]), [
    "packages/db/src/migrations/meta/_journal.json: entry 0 idx 180 does not match tag 0181_c (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: duplicate journal idx 180 (0181_c, 0180_b) (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: entry 2 idx 181 does not match tag 0179_a (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: journal order mismatch at 0: 0181_c.sql vs 0179_a.sql (INV-13)",
    "packages/db/src/migrations/meta/_journal.json: journal order mismatch at 2: 0179_a.sql vs 0181_c.sql (INV-13)",
  ]);
}));
