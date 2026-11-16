import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkDeployedMigrations } from "./check-deployed-migrations.mjs";

const collision = "номер 0423 занят на бою миграцией 0423_deployed.sql — перенумеруй после вливания #1997";
const manifest = { migrations: [{ number: "0423", file: "0423_deployed.sql", pr: 1997 }] };

function fixture(run) {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || path.join(process.env.HOME, "cache/scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, "deployed-git-"));
  const migrationsDir = path.join(root, "packages/db/src/migrations");
  const deployedFile = path.join(migrationsDir, ".deployed.json");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (message) => {
    git("add", "-A");
    git("-c", "user.name=Test User", "-c", "user.email=test@example.invalid", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(deployedFile, JSON.stringify(manifest));
    fs.writeFileSync(path.join(migrationsDir, "0423_old conflict.sql"), "SELECT 1;\n");
    fs.writeFileSync(path.join(migrationsDir, "0425_rename source.sql"), "SELECT 2;\n");
    fs.writeFileSync(path.join(migrationsDir, "0426_delete.sql"), "SELECT 3;\n");
    const baseSha = commit("base");
    const check = (headSha, base = baseSha) => checkDeployedMigrations({ root, migrationsDir, deployedFile, baseSha: base, headSha });
    run({ root, migrationsDir, deployedFile, git, commit, check, baseSha });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.env.MYRMIDON_SELECTION_REPEAT_CHILD !== "1") {
  test("two consecutive suite runs produce identical passing results", () => {
    const args = ["--test", "--test-reporter=dot", new URL(import.meta.url).pathname];
    const env = { ...process.env, MYRMIDON_SELECTION_REPEAT_CHILD: "1" };
    delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, args, { encoding: "utf8", env });
    const first = run();
    const second = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout.trim(), "......");
    assert.equal(second.stdout.trim(), first.stdout.trim());
  });
}

test("diff-only ignores unchanged conflicts and selects added SQL with spaces", () => fixture(({ migrationsDir, commit, check }) => {
  fs.writeFileSync(path.join(migrationsDir, "0427_new migration.sql"), "SELECT 4;\n");
  const result = check(commit("add clean"));
  assert.equal(result.passed, true);
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(result.errors, []);
}));

test("added conflicting SQL is selected", () => fixture(({ migrationsDir, commit, check }) => {
  fs.writeFileSync(path.join(migrationsDir, "0423_new conflict.sql"), "SELECT 4;\n");
  const result = check(commit("add collision"));
  assert.equal(result.passed, false);
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(result.errors, [collision]);
}));

test("renamed SQL is selected using its destination name", () => fixture(({ migrationsDir, commit, check }) => {
  fs.renameSync(path.join(migrationsDir, "0425_rename source.sql"), path.join(migrationsDir, "0423_renamed migration.sql"));
  const result = check(commit("rename"));
  assert.equal(result.passed, false);
  assert.equal(result.checkedCount, 1);
  assert.deepEqual(result.errors, [collision]);
}));

test("deleted SQL is not selected", () => fixture(({ migrationsDir, commit, check }) => {
  fs.unlinkSync(path.join(migrationsDir, "0426_delete.sql"));
  const result = check(commit("delete"));
  assert.equal(result.passed, true);
  assert.equal(result.checkedCount, 0);
  assert.deepEqual(result.errors, []);
}));

test("manifest changes rescan unchanged SQL and report prior collision", () => fixture(({ deployedFile, commit, check }) => {
  fs.writeFileSync(deployedFile, JSON.stringify({ ...manifest, lastMigration: "0423_deployed.sql" }));
  const result = check(commit("manifest"));
  assert.equal(result.passed, false);
  assert.equal(result.checkedCount, 3);
  assert.deepEqual(result.errors, [collision]);
}));

test("invalid base or head fails closed", () => fixture(({ root, commit, check, baseSha }) => {
  fs.writeFileSync(path.join(root, "unrelated.txt"), "change\n");
  const headSha = commit("unrelated");
  for (const result of [check(headSha, "invalid-base"), check("invalid-head", baseSha)]) {
    assert.equal(result.passed, false);
    assert.equal(result.checkedCount, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].startsWith("Cannot determine migration changes for "));
  }
}));
