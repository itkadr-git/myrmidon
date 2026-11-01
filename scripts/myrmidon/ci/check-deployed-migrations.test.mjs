import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkDeployedMigrations,
  normalizeDeployedMigrations,
  parseMigrationNumber,
} from "./check-deployed-migrations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const SCRIPT = path.join(HERE, "check-deployed-migrations.mjs");

test("parseMigrationNumber parses 4-digit prefix of .sql migration files", () => {
  assert.equal(parseMigrationNumber("0423_colorful_jazinda.sql"), "0423");
  assert.equal(parseMigrationNumber("packages/db/src/migrations/0000_mature_masked_marvel.sql"), "0000");
  assert.equal(parseMigrationNumber("0424_clear_stale_replay_holds.sql"), "0424");
  assert.equal(parseMigrationNumber("0423_snapshot.json"), null);
  assert.equal(parseMigrationNumber("not_a_migration.sql"), null);
  assert.equal(parseMigrationNumber("42_short.sql"), null);
});

test("normalizeDeployedMigrations supports various config formats", () => {
  const empty = normalizeDeployedMigrations(null);
  assert.equal(empty.size, 0);

  // Array format with objects
  const fromArray = normalizeDeployedMigrations({
    migrations: [
      { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
      { number: 424, file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
    ],
  });
  assert.equal(fromArray.size, 2);
  assert.deepEqual(fromArray.get("0423"), {
    number: "0423",
    file: "0423_colorful_jazinda.sql",
    pr: 1997,
    tag: null,
  });
  assert.deepEqual(fromArray.get("0424"), {
    number: "0424",
    file: "0424_clear_stale_replay_holds.sql",
    pr: 2012,
    tag: null,
  });

  // Object map format
  const fromMap = normalizeDeployedMigrations({
    migrations: {
      "0423": { file: "0423_colorful_jazinda.sql", pr: 1997 },
      "0424": "0424_clear_stale_replay_holds.sql",
    },
  });
  assert.equal(fromMap.size, 2);
  assert.equal(fromMap.get("0423").pr, 1997);
  assert.equal(fromMap.get("0424").file, "0424_clear_stale_replay_holds.sql");
  assert.equal(fromMap.get("0424").pr, null);
});

test("checkDeployedMigrations passes when PR has no new migrations", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
      ],
    },
    filesToCheck: [],
  });
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
});

test("checkDeployedMigrations passes when PR introduces matching deployed migration (#1997)", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        { number: "0424", file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0423_colorful_jazinda.sql",
    ],
  });
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.checkedCount, 1);
});

test("checkDeployedMigrations passes when PR introduces unreserved migration number (e.g. 0425)", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        { number: "0424", file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0425_next_feature.sql",
    ],
  });
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.checkedCount, 1);
});

test("checkDeployedMigrations fails when PR adds migration colliding with deployed migration 0423", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        { number: "0424", file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0423_custom_feature.sql",
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0],
    "номер 0423 занят на бою миграцией 0423_colorful_jazinda.sql — перенумеруй после вливания #1997",
  );
});

test("checkDeployedMigrations fails when PR adds migration colliding with deployed migration 0424", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        { number: "0424", file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0424_another_feature.sql",
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0],
    "номер 0424 занят на бою миграцией 0424_clear_stale_replay_holds.sql — перенумеруй после вливания #2012",
  );
});

test("checkDeployedMigrations reports multiple collisions when PR has several conflicting migrations", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        { number: "0424", file: "0424_clear_stale_replay_holds.sql", pr: 2012 },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0423_foo.sql",
      "packages/db/src/migrations/0424_bar.sql",
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 2);
  assert.equal(
    result.errors[0],
    "номер 0423 занят на бою миграцией 0423_colorful_jazinda.sql — перенумеруй после вливания #1997",
  );
  assert.equal(
    result.errors[1],
    "номер 0424 занят на бою миграцией 0424_clear_stale_replay_holds.sql — перенумеруй после вливания #2012",
  );
});

test("checkDeployedMigrations handles deployed entries without pr number cleanly", () => {
  const result = checkDeployedMigrations({
    deployedConfig: {
      migrations: [
        { number: "0423", file: "0423_colorful_jazinda.sql" },
      ],
    },
    filesToCheck: [
      "packages/db/src/migrations/0423_collision.sql",
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.errors.length, 1);
  assert.equal(
    result.errors[0],
    "номер 0423 занят на бою миграцией 0423_colorful_jazinda.sql — перенумеруй",
  );
});

test("checkDeployedMigrations passes against real repo tree", () => {
  const result = checkDeployedMigrations({ root: ROOT });
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
  assert(result.deployedCount >= 2);
});

test("CLI execution exits 0 on valid repository and 1 on collision", () => {
  // Test exit 0 on current repo
  const cleanRun = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cleanRun.status, 0, `Expected 0 but got ${cleanRun.status}: ${cleanRun.stderr}`);
  assert.match(cleanRun.stdout, /Все номера миграций согласованы с применёнными на бою/);

  // Test exit 1 with collision
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dep-test-"));
  try {
    const migrationsDir = path.join(tmpDir, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "0423_conflicting_migration.sql"), "SELECT 1;");
    const deployedFile = path.join(tmpDir, ".deployed.json");
    fs.writeFileSync(
      deployedFile,
      JSON.stringify({
        migrations: [
          { number: "0423", file: "0423_colorful_jazinda.sql", pr: 1997 },
        ],
      }),
    );

    const collisionRun = spawnSync(
      "node",
      [SCRIPT, "--migrations", migrationsDir, "--deployed", deployedFile],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(collisionRun.status, 1);
    assert.match(
      collisionRun.stderr,
      /номер 0423 занят на бою миграцией 0423_colorful_jazinda\.sql — перенумеруй после вливания #1997/,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
