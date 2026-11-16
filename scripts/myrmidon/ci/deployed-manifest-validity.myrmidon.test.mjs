import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkDeployedMigrations } from "./check-deployed-migrations.mjs";

const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? path.join(process.env.HOME, "cache", "scratch");

function withManifest(contents, run) {
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "deployed-manifest-"));
  try {
    const deployedFile = path.join(root, "manifest.json");
    if (contents !== undefined) fs.writeFileSync(deployedFile, contents);
    run({ root, deployedFile, filesToCheck: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const valid = {
  migrations: [
    { number: "0001", file: "0001_first.sql" },
    { number: "0002", file: "0002_second.sql" },
  ],
  lastMigration: "0002_second.sql",
};

function checkConfig(config) {
  withManifest(JSON.stringify(config), (options) => {
    assert.deepEqual(checkDeployedMigrations(options), {
      passed: false,
      errors: ["Production migration manifest has inconsistent or duplicate entries"],
      checkedCount: 0,
    });
  });
}

test("valid manifest with existing lastMigration passes with no candidates", () => {
  withManifest(JSON.stringify(valid), (options) => {
    assert.deepEqual(checkDeployedMigrations(options), {
      passed: true, errors: [], checkedCount: 0, deployedCount: 2,
    });
  });
});

test("missing manifest fails even with no candidates", () => {
  withManifest(undefined, (options) => {
    assert.deepEqual(checkDeployedMigrations(options), {
      passed: false, errors: ["Production migration manifest is missing or invalid"], checkedCount: 0,
    });
  });
});

test("malformed JSON reports the exact manifest path and stable prefix", () => {
  withManifest("{ invalid", (options) => {
    const result = checkDeployedMigrations(options);
    assert.equal(result.passed, false);
    assert.equal(result.checkedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].startsWith(`Failed to parse deployed migrations file (${options.deployedFile}): `));
  });
});

test("manifest without migrations array fails", () => {
  withManifest(JSON.stringify({ lastMigration: valid.lastMigration }), (options) => {
    assert.deepEqual(checkDeployedMigrations(options), {
      passed: false, errors: ["Production migration manifest is missing or invalid"], checkedCount: 0,
    });
  });
});

test("empty migrations array fails", () => {
  checkConfig({ migrations: [] });
});

test("duplicate migration numbers fail", () => {
  checkConfig({ ...valid, migrations: [...valid.migrations, { number: "0001", file: "0001_duplicate.sql" }] });
});

test("number and filename mismatch fails", () => {
  checkConfig({ ...valid, migrations: [{ number: "0003", file: "0001_first.sql" }, valid.migrations[1]] });
});

test("lastMigration referring to a missing file fails", () => {
  checkConfig({ ...valid, lastMigration: "0003_missing.sql" });
});

test("manifest without lastMigration passes", () => {
  withManifest(JSON.stringify({ migrations: valid.migrations }), (options) => {
    assert.deepEqual(checkDeployedMigrations(options), {
      passed: true, errors: [], checkedCount: 0, deployedCount: 2,
    });
  });
});
