import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkDeployedMigrations, parseMigrationNumber } from "./check-deployed-migrations.mjs";

const deployedConfig = {
  migrations: [
    { number: "0423", file: "0423_deployed.sql", pr: 1997 },
    { number: "0424", file: "0424_production.sql" },
  ],
};

test("parseMigrationNumber recognizes only migration basenames", () => {
  const cases = [
    ["0000_initial.sql", "0000"],
    ["nested/path/0423_feature.sql", "0423"],
    ["423_short.sql", null],
    ["10423_long.sql", null],
    ["0423_feature.json", null],
    ["0423_feature.SQL", null],
    ["0423_.sql", null],
    ["feature.sql", null],
  ];
  for (const [filename, expected] of cases) {
    assert.equal(parseMigrationNumber(filename), expected, filename);
  }
});

test("candidate accounting preserves collision order and counts duplicates", () => {
  const result = checkDeployedMigrations({
    deployedConfig,
    filesToCheck: [
      "nested/0423_deployed.sql",
      "0425_free.sql",
      "nested/0424_other.sql",
      "0423_other.sql",
      "README.md",
      "0423_other.sql",
      "0423_bad.SQL",
      "0423_.sql",
    ],
  });
  assert.deepEqual(result, {
    passed: false,
    errors: [
      "номер 0424 занят на бою миграцией 0424_production.sql — перенумеруй",
      "номер 0423 занят на бою миграцией 0423_deployed.sql — перенумеруй после вливания #1997",
      "номер 0423 занят на бою миграцией 0423_deployed.sql — перенумеруй после вливания #1997",
    ],
    checkedCount: 5,
    deployedCount: 2,
  });
  assert.deepEqual(checkDeployedMigrations({
    deployedConfig,
    filesToCheck: ["0423_deployed.sql", "0425_free.sql", "README.md"],
  }), { passed: true, errors: [], checkedCount: 2, deployedCount: 2 });
});

test("empty candidates do not scan; null candidates scan only SQL files", () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, "deployed-candidates-"));
  try {
    fs.writeFileSync(path.join(dir, "0423_collision.sql"), "");
    fs.writeFileSync(path.join(dir, "0425_free.sql"), "");
    fs.writeFileSync(path.join(dir, "0424_collision.SQL"), "");
    fs.writeFileSync(path.join(dir, "0424_collision.txt"), "");
    fs.writeFileSync(path.join(dir, "not_a_migration.sql"), "");
    assert.deepEqual(checkDeployedMigrations({ deployedConfig, migrationsDir: dir, filesToCheck: [] }), {
      passed: true, errors: [], checkedCount: 0, deployedCount: 2,
    });
    assert.deepEqual(checkDeployedMigrations({ deployedConfig, migrationsDir: dir, filesToCheck: null }), {
      passed: false,
      errors: ["номер 0423 занят на бою миграцией 0423_deployed.sql — перенумеруй после вливания #1997"],
      checkedCount: 2,
      deployedCount: 2,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
