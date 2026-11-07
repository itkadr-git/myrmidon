import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Renumbers a database migration in packages/db.
 *
 * Updates:
 * 1. packages/db/src/migrations/NNNN_name.sql -> MMMM_name.sql
 * 2. Internal markers inside the .sql file (NNNN_name -> MMMM_name, migration_NNNN -> migration_MMMM, etc.)
 * 3. packages/db/src/migrations/meta/_journal.json (idx: MMMM, tag: MMMM_name, maintains ascending idx order)
 * 4. packages/db/src/migrations/meta/NNNN_snapshot.json -> MMMM_snapshot.json
 *    (prevId pointing to previous snapshot id, own id generated/valid)
 * 5. Associated migration test files (if any mention the migration tag or markers)
 */

export function parseMigrationNumber(val) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,4})/);
  if (!m) return null;
  return m[1].padStart(4, "0");
}

export function findMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  const entries = fs.readdirSync(migrationsDir);
  const results = [];
  for (const f of entries) {
    const m = f.match(/^(\d{4})_(.*)\.sql$/);
    if (m) {
      results.push({
        file: f,
        num: m[1],
        suffix: m[2],
        tag: `${m[1]}_${m[2]}`,
        fullPath: path.join(migrationsDir, f),
      });
    }
  }
  return results.sort((a, b) => Number(a.num) - Number(b.num));
}

export function findSnapshots(metaDir) {
  if (!fs.existsSync(metaDir)) return [];
  const entries = fs.readdirSync(metaDir);
  const results = [];
  for (const f of entries) {
    const m = f.match(/^(\d{4})_snapshot\.json$/);
    if (m) {
      results.push({
        file: f,
        num: m[1],
        fullPath: path.join(metaDir, f),
      });
    }
  }
  return results.sort((a, b) => Number(a.num) - Number(b.num));
}

export function getNextFreeNumber(repoRoot) {
  const migrationsDir = path.join(repoRoot, "packages/db/src/migrations");
  const list = findMigrations(migrationsDir);
  if (list.length === 0) return "0001";
  const max = Math.max(...list.map((m) => Number(m.num)));
  return String(max + 1).padStart(4, "0");
}

export function updateSqlMarkers(sqlContent, oldNum, newNum, oldTag, newTag) {
  let content = sqlContent;

  // 1. Exact tag replacement (e.g. 0423_clear_stale_replay_holds -> 0424_clear_stale_replay_holds)
  if (oldTag && newTag) {
    content = content.replaceAll(oldTag, newTag);
  }

  // 2. migration_0423 -> migration_0424
  content = content.replaceAll(`migration_${oldNum}`, `migration_${newNum}`);

  // 3. migration 0423 -> migration 0424
  content = content.replaceAll(`migration ${oldNum}`, `migration ${newNum}`);
  content = content.replaceAll(`Migration ${oldNum}`, `Migration ${newNum}`);

  // 4. Comment / marker prefixes: '-- 0423_' or '-- migration 0423'
  content = content.replaceAll(`-- ${oldNum}_`, `-- ${newNum}_`);

  // 5. String literals starting with oldNum_ (e.g. '0423_clear_stale_replay_holds: ...')
  const numPrefixRegex = new RegExp(`(['"\`])${oldNum}_`, "g");
  content = content.replace(numPrefixRegex, `$1${newNum}_`);

  return content;
}

export function updateJournal(journalPath, oldNum, newNum, oldTag, newTag) {
  if (!fs.existsSync(journalPath)) {
    throw new Error(`_journal.json not found at ${journalPath}`);
  }

  const raw = fs.readFileSync(journalPath, "utf8");
  const journal = JSON.parse(raw);
  const oldNumInt = Number(oldNum);
  const newNumInt = Number(newNum);

  let targetEntry = null;
  for (const entry of journal.entries) {
    if (
      entry.idx === oldNumInt ||
      entry.tag === oldTag ||
      (entry.tag && entry.tag.startsWith(`${oldNum}_`))
    ) {
      targetEntry = entry;
      break;
    }
  }

  if (!targetEntry) {
    throw new Error(`Journal entry for migration ${oldNum} (${oldTag}) not found in ${journalPath}`);
  }

  targetEntry.idx = newNumInt;
  targetEntry.tag = newTag;

  // Sort journal entries by idx ascending
  journal.entries.sort((a, b) => a.idx - b.idx);

  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2) + "\n", "utf8");
  return targetEntry;
}

export function updateSnapshots(metaDir, oldNum, newNum) {
  const oldSnapshotFile = `${oldNum}_snapshot.json`;
  const newSnapshotFile = `${newNum}_snapshot.json`;
  const oldSnapshotPath = path.join(metaDir, oldSnapshotFile);
  const newSnapshotPath = path.join(metaDir, newSnapshotFile);

  const newNumInt = Number(newNum);

  // Find preceding snapshot for newNumInt
  const snapshots = findSnapshots(metaDir).filter(
    (s) => s.num !== oldNum && Number(s.num) < newNumInt
  );

  let precedingSnapshotId = null;
  let precedingSnapshotFile = null;
  if (snapshots.length > 0) {
    const lastPreceding = snapshots[snapshots.length - 1];
    precedingSnapshotFile = lastPreceding.file;
    const precRaw = fs.readFileSync(lastPreceding.fullPath, "utf8");
    const precJson = JSON.parse(precRaw);
    precedingSnapshotId = precJson.id;
  }

  let snapshotData;
  if (fs.existsSync(oldSnapshotPath)) {
    snapshotData = JSON.parse(fs.readFileSync(oldSnapshotPath, "utf8"));
  } else if (snapshots.length > 0) {
    // Data-only migration without existing snapshot: synthesize from preceding snapshot
    snapshotData = JSON.parse(fs.readFileSync(snapshots[snapshots.length - 1].fullPath, "utf8"));
    snapshotData.id = crypto.randomUUID();
  } else {
    throw new Error(`Cannot renumber snapshot: old snapshot ${oldSnapshotPath} does not exist and no preceding snapshot found`);
  }

  if (precedingSnapshotId) {
    snapshotData.prevId = precedingSnapshotId;
  }
  // Ensure id is unique and doesn't match prevId
  if (!snapshotData.id || snapshotData.id === snapshotData.prevId) {
    snapshotData.id = crypto.randomUUID();
  }

  fs.writeFileSync(newSnapshotPath, JSON.stringify(snapshotData, null, 2) + "\n", "utf8");

  if (fs.existsSync(oldSnapshotPath) && oldSnapshotPath !== newSnapshotPath) {
    fs.unlinkSync(oldSnapshotPath);
  }

  return {
    snapshotPath: newSnapshotPath,
    prevId: snapshotData.prevId,
    id: snapshotData.id,
    precedingSnapshotFile,
  };
}

export function updateAssociatedTests(repoRoot, oldNum, newNum, oldTag, newTag) {
  const dirs = [
    path.join(repoRoot, "packages/db/src"),
    path.join(repoRoot, "packages/db/tests"),
    path.join(repoRoot, "server/tests"),
  ];

  const updatedFiles = [];

  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const entries = fs.readdirSync(d);
    for (const f of entries) {
      if (!f.endsWith(".test.ts") && !f.endsWith(".test.mts") && !f.endsWith(".test.js")) continue;
      const filePath = path.join(d, f);
      let content = fs.readFileSync(filePath, "utf8");
      if (content.includes(oldTag) || content.includes(`migration_${oldNum}`)) {
        content = content.replaceAll(oldTag, newTag);
        content = content.replaceAll(`migration_${oldNum}`, `migration_${newNum}`);
        fs.writeFileSync(filePath, content, "utf8");
        updatedFiles.push(path.relative(repoRoot, filePath));
      }
    }
  }

  return updatedFiles;
}

export function renumberMigration({ root, from, to }) {
  const repoRoot = path.resolve(root || process.cwd());
  const migrationsDir = path.join(repoRoot, "packages/db/src/migrations");
  const metaDir = path.join(migrationsDir, "meta");
  const journalPath = path.join(metaDir, "_journal.json");

  const fromNum = parseMigrationNumber(from);
  if (!fromNum) {
    throw new Error(`Invalid source migration number: "${from}". Must be 1 to 4 digits.`);
  }

  let toNum = parseMigrationNumber(to);
  if (!toNum) {
    toNum = getNextFreeNumber(repoRoot);
  }

  if (fromNum === toNum) {
    throw new Error(`Source and target migration numbers are identical (${fromNum}).`);
  }

  // 1. Locate existing .sql migration
  const allMigrations = findMigrations(migrationsDir);
  const targetMigration = allMigrations.find((m) => m.num === fromNum);
  if (!targetMigration) {
    throw new Error(`Migration ${fromNum} not found in ${migrationsDir}`);
  }

  const oldTag = targetMigration.tag;
  const newTag = `${toNum}_${targetMigration.suffix}`;
  const oldSqlPath = targetMigration.fullPath;
  const newSqlPath = path.join(migrationsDir, `${newTag}.sql`);

  // Check if target migration number is already occupied
  const existingTarget = allMigrations.find((m) => m.num === toNum);
  if (existingTarget && existingTarget.num !== fromNum) {
    throw new Error(`Target migration number ${toNum} is already occupied by ${existingTarget.file}`);
  }

  // Check if target SQL already exists
  if (fs.existsSync(newSqlPath) && newSqlPath !== oldSqlPath) {
    throw new Error(`Target migration file already exists: ${newSqlPath}`);
  }

  // 2. Read and update SQL file
  const oldSqlContent = fs.readFileSync(oldSqlPath, "utf8");
  const newSqlContent = updateSqlMarkers(oldSqlContent, fromNum, toNum, oldTag, newTag);
  fs.writeFileSync(newSqlPath, newSqlContent, "utf8");
  if (oldSqlPath !== newSqlPath) {
    fs.unlinkSync(oldSqlPath);
  }

  // 3. Update _journal.json
  const journalEntry = updateJournal(journalPath, fromNum, toNum, oldTag, newTag);

  // 4. Update snapshot
  const snapshotResult = updateSnapshots(metaDir, fromNum, toNum);

  // 5. Update associated test references
  const updatedTests = updateAssociatedTests(repoRoot, fromNum, toNum, oldTag, newTag);

  return {
    fromNum,
    toNum,
    oldTag,
    newTag,
    oldSqlFile: path.basename(oldSqlPath),
    newSqlFile: path.basename(newSqlPath),
    journalEntry,
    snapshotResult,
    updatedTests,
  };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let fromArg = null;
  let toArg = null;
  let rootArg = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      rootArg = args[++i];
    } else if (!fromArg) {
      fromArg = args[i];
    } else if (!toArg) {
      toArg = args[i];
    }
  }

  if (!fromArg) {
    console.error("Usage: node scripts/myrmidon/db-renumber-migration.mjs <from-number> [to-number] [--root <repo-root>]");
    console.error("Example: node scripts/myrmidon/db-renumber-migration.mjs 0423 0424");
    process.exit(1);
  }

  try {
    const res = renumberMigration({ root: rootArg, from: fromArg, to: toArg });
    console.log(`Successfully renumbered migration:`);
    console.log(`  SQL:       ${res.oldSqlFile} -> ${res.newSqlFile}`);
    console.log(`  Journal:   idx ${res.fromNum} -> ${res.toNum} (${res.newTag})`);
    console.log(`  Snapshot:  meta/${res.toNum}_snapshot.json (prevId -> ${res.snapshotResult.prevId})`);
    if (res.updatedTests.length > 0) {
      console.log(`  Tests:     updated ${res.updatedTests.join(", ")}`);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
