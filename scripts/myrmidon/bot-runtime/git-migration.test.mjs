import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  migrateIdleGitRepos,
  withFleetMigrationLock,
  REPACK_MIGRATED_MARKER,
} from "../../../docker/bot-runtime/botd/lib/git-migration.js";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { runGitMigration } = require(path.join(ROOT, "docker/bot-runtime/botd/botd"));

test("botd idle git migration wiring passes the configured myr-ws workspace root", () => {
  const calls = [];
  const logs = [];
  runGitMigration({
    migrationEnabled: true,
    idle: true,
    gitMigrationMod: {
      migrateIdleGitRepos: (options) => {
        calls.push(options);
        return { migrated: 1 };
      },
    },
    log: (line) => logs.push(line),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspacesDir, "/workspace");
  assert.equal(calls[0].idle, true);
  assert.equal(calls[0].enabled, true);
  assert.deepEqual(logs, ["botd: git migration repacked 1 repos (idle-gated)"]);
});

test("BEHAVIORAL: migrateIdleGitRepos skips when disabled or not idle", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-test-"));
  const baseDir = path.join(tmp, "base");
  const wsDir = path.join(tmp, "workspaces");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const res1 = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: false,
  });
  assert.strictEqual(res1.skipped, true);
  assert.strictEqual(res1.migrated, 0);

  const res2 = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: false,
    enabled: true,
  });
  assert.strictEqual(res2.skipped, true);
  assert.strictEqual(res2.migrated, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("BEHAVIORAL: migrateIdleGitRepos migrates candidate, writes marker, and preserves alternates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-test-"));
  const baseDir = path.join(tmp, "base");
  const wsDir = path.join(tmp, "workspaces");
  const repoDir = path.join(baseDir, "my-repo.git");
  const objectsDir = path.join(repoDir, "objects");
  const infoDir = path.join(objectsDir, "info");
  const packDir = path.join(objectsDir, "pack");

  fs.mkdirSync(infoDir, { recursive: true });
  fs.mkdirSync(packDir, { recursive: true });

  const altFile = path.join(infoDir, "alternates");
  const altContent = "/cache/git/itkadr-git/myrmidon.git/objects\n";
  fs.writeFileSync(altFile, altContent, "utf8");

  const lockFile = path.join(tmp, "fleet.lock");
  let repackCalledWith = null;
  const mockRepack = (gitDir) => {
    repackCalledWith = gitDir;
    return true;
  };

  const res = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: true,
    repackRunner: mockRepack,
    lockPathOverride: lockFile,
  });

  assert.strictEqual(res.migrated, 1);
  assert.strictEqual(repackCalledWith, repoDir);

  const markerFile = path.join(infoDir, REPACK_MIGRATED_MARKER);
  assert.strictEqual(fs.existsSync(markerFile), true);
  assert.strictEqual(fs.readFileSync(altFile, "utf8"), altContent);

  const res2 = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: true,
    repackRunner: () => {
      throw new Error("should not be called");
    },
    lockPathOverride: lockFile,
  });
  assert.strictEqual(res2.migrated, 0);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("BEHAVIORAL: migrateIdleGitRepos on repack failure cleans up .tmp- packs and preserves alternates", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-test-"));
  const baseDir = path.join(tmp, "base");
  const wsDir = path.join(tmp, "workspaces");
  const repoDir = path.join(baseDir, "fail-repo.git");
  const objectsDir = path.join(repoDir, "objects");
  const infoDir = path.join(objectsDir, "info");
  const packDir = path.join(objectsDir, "pack");

  fs.mkdirSync(infoDir, { recursive: true });
  fs.mkdirSync(packDir, { recursive: true });

  const altFile = path.join(infoDir, "alternates");
  const altContent = "/cache/git/itkadr-git/myrmidon.git/objects\n";
  fs.writeFileSync(altFile, altContent, "utf8");

  const tmpPack = path.join(packDir, ".tmp-12345-pack.pack");
  fs.writeFileSync(tmpPack, "dangling-data");

  const lockFile = path.join(tmp, "fleet.lock");
  const res = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: true,
    repackRunner: () => false,
    lockPathOverride: lockFile,
  });

  assert.strictEqual(res.migrated, 0);
  assert.strictEqual(fs.existsSync(path.join(infoDir, REPACK_MIGRATED_MARKER)), false);
  assert.strictEqual(fs.existsSync(tmpPack), false);
  assert.strictEqual(fs.readFileSync(altFile, "utf8"), altContent);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("BEHAVIORAL: withFleetMigrationLock serializes across bots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-lock-test-"));
  const lockFile = path.join(tmp, "test.lock");

  let executed = false;
  const res1 = withFleetMigrationLock(() => {
    executed = true;
    const concurrent = withFleetMigrationLock(() => "unreachable", lockFile);
    assert.strictEqual(concurrent, null);
    return 42;
  }, lockFile);

  assert.strictEqual(executed, true);
  assert.strictEqual(res1, 42);
  const res2 = withFleetMigrationLock(() => "second", lockFile);
  assert.strictEqual(res2, "second");

  fs.rmSync(tmp, { recursive: true, force: true });
});
