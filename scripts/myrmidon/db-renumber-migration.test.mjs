import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import {
  renumberMigration,
  updateSqlMarkers,
  parseMigrationNumber,
  findMigrations,
  findSnapshots,
} from "./db-renumber-migration.mjs";
import { checkMigrations } from "./ci/arch-invariants-gate.mjs";

function createSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db-renumber-test-"));
  const migDir = path.join(dir, "packages/db/src/migrations");
  const metaDir = path.join(migDir, "meta");
  fs.mkdirSync(metaDir, { recursive: true });

  // Baseline migrations: 0421, 0422, 0423
  const snap421Id = crypto.randomUUID();
  const snap422Id = crypto.randomUUID();
  const snap423Id = crypto.randomUUID();

  fs.writeFileSync(
    path.join(migDir, "0421_fixed_grim_reaper.sql"),
    "-- migration 0421\nSELECT 1;\n"
  );
  fs.writeFileSync(
    path.join(migDir, "0422_interaction_routing.sql"),
    "-- migration 0422\nSELECT 2;\n"
  );
  fs.writeFileSync(
    path.join(migDir, "0423_clear_stale_replay_holds.sql"),
    `-- migration 0423_clear_stale_replay_holds.sql
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  reason text DEFAULT 'migration_0423_dedupe'
);
-- migration 0423: clear stale holds
UPDATE task_holds SET status = 'released' WHERE reason = '0423_clear_stale_replay_holds';
`
  );

  fs.writeFileSync(
    path.join(metaDir, "0421_snapshot.json"),
    JSON.stringify({ id: snap421Id, prevId: "00000000-0000-0000-0000-000000000000", version: "7" }, null, 2)
  );
  fs.writeFileSync(
    path.join(metaDir, "0422_snapshot.json"),
    JSON.stringify({ id: snap422Id, prevId: snap421Id, version: "7" }, null, 2)
  );
  fs.writeFileSync(
    path.join(metaDir, "0423_snapshot.json"),
    JSON.stringify({ id: snap423Id, prevId: snap422Id, version: "7" }, null, 2)
  );

  fs.writeFileSync(
    path.join(metaDir, "_journal.json"),
    JSON.stringify(
      {
        version: "7",
        dialect: "postgresql",
        entries: [
          { idx: 421, version: "7", when: 1700000001000, tag: "0421_fixed_grim_reaper", breakpoints: true },
          { idx: 422, version: "7", when: 1700000002000, tag: "0422_interaction_routing", breakpoints: true },
          { idx: 423, version: "7", when: 1700000003000, tag: "0423_clear_stale_replay_holds", breakpoints: true },
        ],
      },
      null,
      2
    )
  );

  // Associated test file
  const testDir = path.join(dir, "packages/db/src");
  fs.writeFileSync(
    path.join(testDir, "replay-holds-migration.test.ts"),
    `import { describe, it } from 'vitest';
describe('0423_clear_stale_replay_holds', () => {
  it('applies migration_0423 safely', () => {});
});
`
  );

  return { dir, migDir, metaDir, snap421Id, snap422Id, snap423Id };
}

describe("db-renumber-migration", () => {
  it("parseMigrationNumber formats numbers to 4 digits", () => {
    assert.equal(parseMigrationNumber("1"), "0001");
    assert.equal(parseMigrationNumber(42), "0042");
    assert.equal(parseMigrationNumber("0423"), "0423");
    assert.equal(parseMigrationNumber("0423_tag"), "0423");
    assert.equal(parseMigrationNumber(null), null);
  });

  it("updateSqlMarkers replaces tags, migration prefixes, and string literals", () => {
    const raw = `-- migration 0423_clear_stale_replay_holds.sql
UPDATE task_holds SET tag = '0423_clear_stale_replay_holds';
-- migration 0423
SELECT 'migration_0423_dedupe';`;

    const updated = updateSqlMarkers(
      raw,
      "0423",
      "0424",
      "0423_clear_stale_replay_holds",
      "0424_clear_stale_replay_holds"
    );

    assert.ok(updated.includes("-- migration 0424_clear_stale_replay_holds.sql"));
    assert.ok(updated.includes("'0424_clear_stale_replay_holds'"));
    assert.ok(updated.includes("-- migration 0424"));
    assert.ok(updated.includes("'migration_0424_dedupe'"));
    assert.ok(!updated.includes("0423"));
  });

  it("renumbers migration from 0423 to 0424 with all files, journal, and snapshots intact", () => {
    const { dir, migDir, metaDir, snap422Id } = createSandbox();

    const res = renumberMigration({ root: dir, from: "0423", to: "0424" });
    assert.equal(res.fromNum, "0423");
    assert.equal(res.toNum, "0424");
    assert.equal(res.newTag, "0424_clear_stale_replay_holds");

    // 1. Check SQL file
    assert.ok(!fs.existsSync(path.join(migDir, "0423_clear_stale_replay_holds.sql")));
    assert.ok(fs.existsSync(path.join(migDir, "0424_clear_stale_replay_holds.sql")));
    const sqlContent = fs.readFileSync(path.join(migDir, "0424_clear_stale_replay_holds.sql"), "utf8");
    assert.ok(sqlContent.includes("0424_clear_stale_replay_holds"));
    assert.ok(sqlContent.includes("migration_0424_dedupe"));
    assert.ok(sqlContent.includes("-- migration 0424: clear stale holds"));
    assert.ok(!sqlContent.includes("0423"));

    // 2. Check journal
    const journal = JSON.parse(fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8"));
    const entry = journal.entries.find((e) => e.idx === 424);
    assert.ok(entry, "Entry with idx 424 must exist in journal");
    assert.equal(entry.tag, "0424_clear_stale_replay_holds");
    assert.ok(!journal.entries.some((e) => e.idx === 423), "Old idx 423 must not remain");
    // Verify ascending order
    for (let i = 1; i < journal.entries.length; i++) {
      assert.ok(journal.entries[i].idx > journal.entries[i - 1].idx);
    }

    // 3. Check snapshot
    assert.ok(!fs.existsSync(path.join(metaDir, "0423_snapshot.json")));
    assert.ok(fs.existsSync(path.join(metaDir, "0424_snapshot.json")));
    const snap424 = JSON.parse(fs.readFileSync(path.join(metaDir, "0424_snapshot.json"), "utf8"));
    assert.equal(snap424.prevId, snap422Id, "0424 prevId must point to 0422 id");
    assert.ok(snap424.id && snap424.id !== snap422Id);

    // 4. Check test file updated
    const testContent = fs.readFileSync(path.join(dir, "packages/db/src/replay-holds-migration.test.ts"), "utf8");
    assert.ok(testContent.includes("0424_clear_stale_replay_holds"));
    assert.ok(testContent.includes("migration_0424"));

    // 5. Invariant check: when main has landed 0423, the full sequence 0421..0424 is contiguous and gapless
    fs.writeFileSync(path.join(migDir, "0423_colorful_jazinda.sql"), "-- migration 0423\nSELECT 3;\n");
    const updatedJournal = JSON.parse(fs.readFileSync(path.join(metaDir, "_journal.json"), "utf8"));
    updatedJournal.entries.unshift({ idx: 423, version: "7", when: 1700000002500, tag: "0423_colorful_jazinda", breakpoints: true });
    updatedJournal.entries.sort((a, b) => a.idx - b.idx);
    fs.writeFileSync(path.join(metaDir, "_journal.json"), JSON.stringify(updatedJournal, null, 2) + "\n");

    const migCheck = checkMigrations(dir);
    assert.deepEqual(migCheck, [], "checkMigrations from arch-invariants-gate must find no violations");
  });

  it("auto-detects next free number when 'to' is omitted", () => {
    const { dir, migDir } = createSandbox();
    const res = renumberMigration({ root: dir, from: "0423" });
    assert.equal(res.toNum, "0424");
    assert.ok(fs.existsSync(path.join(migDir, "0424_clear_stale_replay_holds.sql")));
  });

  it("handles data-only migration without existing snapshot by deriving from predecessor", () => {
    const { dir, migDir, metaDir, snap422Id } = createSandbox();
    // Delete 0423 snapshot to simulate data-only migration
    fs.unlinkSync(path.join(metaDir, "0423_snapshot.json"));

    const res = renumberMigration({ root: dir, from: "0423", to: "0424" });
    assert.ok(fs.existsSync(path.join(metaDir, "0424_snapshot.json")));
    const snap424 = JSON.parse(fs.readFileSync(path.join(metaDir, "0424_snapshot.json"), "utf8"));
    assert.equal(snap424.prevId, snap422Id);
    assert.ok(snap424.id && snap424.id !== snap422Id);
  });

  it("throws clear error on nonexistent source migration", () => {
    const { dir } = createSandbox();
    assert.throws(
      () => renumberMigration({ root: dir, from: "0999", to: "1000" }),
      /Migration 0999 not found/
    );
  });

  it("throws clear error if target migration already exists", () => {
    const { dir } = createSandbox();
    assert.throws(
      () => renumberMigration({ root: dir, from: "0423", to: "0422" }),
      /Target migration number 0422 is already occupied/
    );
  });
});
