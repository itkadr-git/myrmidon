import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { checkMigrations, TEST_HOOKS } from "./arch-invariants-gate.mjs";

const migrationDir = "packages/db/src/migrations";
const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");

function withFixture(numbers, run) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "arch-baseline-"));
  const previous = TEST_HOOKS.migrationBaselineOverride;
  try {
    const dir = path.join(root, migrationDir);
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    const tags = numbers.map((number) => `${String(number).padStart(4, "0")}_fixture`);
    for (const tag of tags) fs.writeFileSync(path.join(dir, `${tag}.sql`), "-- fixture\n");
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ entries: tags.map((tag) => ({ tag })) }));
    run(root);
  } finally {
    TEST_HOOKS.migrationBaselineOverride = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeBaseline(root, baseline) {
  fs.writeFileSync(path.join(root, "baseline.json"), JSON.stringify(baseline));
}

describe("INV-13 baseline boundaries", { concurrency: false }, () => {
  it("defaults enforcement to one after the maximum baseline number", () => {
    withFixture([1, 3, 5, 7], (root) => {
      writeBaseline(root, { numbers: [1, 3, 5] });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0006 (INV-13)",
      ]);
      writeBaseline(root, { numbers: [1, 3, 5], enforceGapsFrom: 4 });
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0004 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0006 (INV-13)",
      ]);
    });
  });

  it("suppresses a gap just below the explicit boundary, but reports gaps at and above it", () => {
    withFixture([1, 5], (root) => {
      writeBaseline(root, { numbers: [1, 5], enforceGapsFrom: 3 });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0003 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0004 (INV-13)",
      ]);
      writeBaseline(root, { numbers: [1, 5], enforceGapsFrom: 2 });
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0002 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0003 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0004 (INV-13)",
      ]);
    });
  });

  it("allows recorded gaps above the boundary but still reports an unrecorded gap", () => {
    withFixture([1, 3, 5, 7], (root) => {
      writeBaseline(root, { numbers: [1, 3, 5], gaps: [4], enforceGapsFrom: 4 });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0006 (INV-13)",
      ]);
      writeBaseline(root, { numbers: [1, 3, 5], gaps: [4, 6], enforceGapsFrom: 4 });
      assert.deepEqual(checkMigrations(root), []);
    });
  });

  it("reports absent baseline numbers even when the gap is suppressed", () => {
    withFixture([1, 3, 7], (root) => {
      writeBaseline(root, { numbers: [1, 3, 5], gaps: [5], enforceGapsFrom: 8 });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: historical baseline migration 0005 unexpectedly absent (INV-13)",
      ]);
      writeBaseline(root, { numbers: [1, 3, 5], enforceGapsFrom: 5 });
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: new gap at migration number 0005 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0006 (INV-13)",
        "packages/db/src/migrations: historical baseline migration 0005 unexpectedly absent (INV-13)",
      ]);
    });
  });

  it("resolves relative and absolute overrides to identical findings", () => {
    withFixture([1, 3, 5], (root) => {
      writeBaseline(root, { numbers: [1, 3], enforceGapsFrom: 2 });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      const relative = checkMigrations(root);
      assert.deepEqual(relative, [
        "packages/db/src/migrations: new gap at migration number 0002 (INV-13)",
        "packages/db/src/migrations: new gap at migration number 0004 (INV-13)",
      ]);
      TEST_HOOKS.migrationBaselineOverride = path.join(root, "baseline.json");
      assert.deepEqual(checkMigrations(root), relative);
    });
  });

  it("uses strict contiguity for override none and a missing default baseline", () => {
    withFixture([1, 3], (root) => {
      writeBaseline(root, { numbers: [1, 3], gaps: [2], enforceGapsFrom: 2 });
      TEST_HOOKS.migrationBaselineOverride = "baseline.json";
      assert.deepEqual(checkMigrations(root), []);
      TEST_HOOKS.migrationBaselineOverride = "none";
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: gap between 0001 and 0003 (INV-13, no baseline file)",
      ]);
      TEST_HOOKS.migrationBaselineOverride = null;
      assert.deepEqual(checkMigrations(root), [
        "packages/db/src/migrations: gap between 0001 and 0003 (INV-13, no baseline file)",
      ]);
    });
  });
});
