import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { findMigrations, findSnapshots, getNextFreeNumber } from "./db-renumber-migration.mjs";

function sandbox(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-discovery-"));
  try {
    const migrations = path.join(root, "packages/db/src/migrations");
    const meta = path.join(migrations, "meta");
    return run({ root, migrations, meta });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function files(dir, names) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) fs.writeFileSync(path.join(dir, name), `content: ${name}\n`);
}

it("returns no migrations for a missing directory", () => sandbox(({ migrations }) => {
  assert.deepEqual(findMigrations(migrations), []);
}));

it("returns no snapshots for a missing directory", () => sandbox(({ meta }) => {
  assert.deepEqual(findSnapshots(meta), []);
}));

it("returns no migrations for an empty directory", () => sandbox(({ migrations }) => {
  files(migrations, []);
  assert.deepEqual(findMigrations(migrations), []);
}));

it("returns no snapshots for an empty directory", () => sandbox(({ meta }) => {
  files(meta, []);
  assert.deepEqual(findSnapshots(meta), []);
}));

it("preserves migration file, number, suffix, tag and full path", () => sandbox(({ migrations }) => {
  files(migrations, ["0042_add_some.tables.sql"]);
  assert.deepEqual(findMigrations(migrations), [{
    file: "0042_add_some.tables.sql", num: "0042", suffix: "add_some.tables",
    tag: "0042_add_some.tables", fullPath: path.join(migrations, "0042_add_some.tables.sql"),
  }]);
}));

it("preserves snapshot file, number and full path", () => sandbox(({ meta }) => {
  files(meta, ["0042_snapshot.json"]);
  assert.deepEqual(findSnapshots(meta), [{
    file: "0042_snapshot.json", num: "0042", fullPath: path.join(meta, "0042_snapshot.json"),
  }]);
}));

it("ignores migration names with other extensions or adjacent prefixes and suffixes", () => sandbox(({ migrations }) => {
  files(migrations, ["0007_valid.sql", "0008_wrong.SQL", "0009_wrong.sql.bak", "x0010_wrong.sql", "011_wrong.sql", "00111_wrong.sql", "0012wrong.sql", "0013_snapshot.json"]);
  assert.deepEqual(findMigrations(migrations).map((entry) => entry.file), ["0007_valid.sql"]);
}));

it("ignores snapshot names with other extensions or adjacent names", () => sandbox(({ meta }) => {
  files(meta, ["0007_snapshot.json", "0008_snapshot.JSON", "0009_snapshot.json.bak", "x0010_snapshot.json", "011_snapshot.json", "00111_snapshot.json", "0012_snapshot_extra.json", "0013_other.json"]);
  assert.deepEqual(findSnapshots(meta).map((entry) => entry.file), ["0007_snapshot.json"]);
}));

it("sorts migrations by number after reverse-order creation", () => sandbox(({ migrations }) => {
  files(migrations, ["0100_last.sql", "0010_middle.sql", "0002_first.sql"]);
  assert.deepEqual(findMigrations(migrations).map((entry) => entry.num), ["0002", "0010", "0100"]);
}));

it("sorts snapshots by number after reverse-order creation", () => sandbox(({ meta }) => {
  files(meta, ["0100_snapshot.json", "0010_snapshot.json", "0002_snapshot.json"]);
  assert.deepEqual(findSnapshots(meta).map((entry) => entry.num), ["0002", "0010", "0100"]);
}));

it("returns 0001 when the migration directory is absent", () => sandbox(({ root }) => {
  assert.equal(getNextFreeNumber(root), "0001");
}));

it("returns 0001 when the migration directory is empty", () => sandbox(({ root, migrations }) => {
  files(migrations, []);
  assert.equal(getNextFreeNumber(root), "0001");
}));

it("returns max plus one rather than filling a gap", () => sandbox(({ root, migrations }) => {
  files(migrations, ["0042_high.sql", "0001_low.sql", "9000_ignored.sql.bak"]);
  assert.equal(getNextFreeNumber(root), "0043");
}));

it("discovery does not write or create files", () => sandbox(({ root, migrations, meta }) => {
  files(migrations, ["0002_keep.sql", "ignored.txt"]);
  files(meta, ["0002_snapshot.json", "_journal.json"]);
  const dirs = [root, path.join(root, "packages"), path.join(root, "packages/db"), path.join(root, "packages/db/src"), migrations, meta];
  const before = dirs.map((dir) => ({ names: fs.readdirSync(dir).sort(), stat: fs.statSync(dir, { bigint: true }) }));
  const paths = [path.join(migrations, "0002_keep.sql"), path.join(migrations, "ignored.txt"), path.join(meta, "0002_snapshot.json"), path.join(meta, "_journal.json")];
  const contents = paths.map((file) => ({ data: fs.readFileSync(file), stat: fs.statSync(file, { bigint: true }) }));
  assert.equal(findMigrations(migrations).length, 1);
  assert.equal(findSnapshots(meta).length, 1);
  assert.equal(getNextFreeNumber(root), "0003");
  dirs.forEach((dir, i) => {
    assert.deepEqual(fs.readdirSync(dir).sort(), before[i].names);
    const stat = fs.statSync(dir, { bigint: true });
    assert.equal(stat.mtimeNs, before[i].stat.mtimeNs);
    assert.equal(stat.ctimeNs, before[i].stat.ctimeNs);
  });
  paths.forEach((file, i) => {
    assert.deepEqual(fs.readFileSync(file), contents[i].data);
    const stat = fs.statSync(file, { bigint: true });
    assert.equal(stat.mtimeNs, contents[i].stat.mtimeNs);
    assert.equal(stat.ctimeNs, contents[i].stat.ctimeNs);
  });
}));
