import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  migrateIdleGitRepos,
  withFleetMigrationLock,
  REPACK_MIGRATED_MARKER,
} from "../../../docker/bot-runtime/botd/lib/git-migration.js";

test("BEHAVIORAL: migrateIdleGitRepos skips when disabled or not idle", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-test-"));
  const baseDir = path.join(tmp, "base");
  const wsDir = path.join(tmp, "workspaces");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(wsDir, { recursive: true });

  // 1. Disabled
  const res1 = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: false,
  });
  assert.strictEqual(res1.skipped, true);
  assert.strictEqual(res1.migrated, 0);

  // 2. Not idle
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

  // Marker file must be created
  const markerFile = path.join(infoDir, REPACK_MIGRATED_MARKER);
  assert.strictEqual(fs.existsSync(markerFile), true);

  // Alternates must remain intact
  assert.strictEqual(fs.readFileSync(altFile, "utf8"), altContent);

  // Subsequent call skips already migrated repo
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

  // Create temporary leftover pack
  const tmpPack = path.join(packDir, ".tmp-12345-pack.pack");
  fs.writeFileSync(tmpPack, "dangling-data");

  const lockFile = path.join(tmp, "fleet.lock");

  const failingRepack = () => false;

  const res = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: true,
    repackRunner: failingRepack,
    lockPathOverride: lockFile,
  });

  assert.strictEqual(res.migrated, 0);

  // Marker must NOT be created
  const markerFile = path.join(infoDir, REPACK_MIGRATED_MARKER);
  assert.strictEqual(fs.existsSync(markerFile), false);

  // Dangling .tmp- pack must be cleaned up
  assert.strictEqual(fs.existsSync(tmpPack), false);

  // Alternates MUST persist for future retry
  assert.strictEqual(fs.readFileSync(altFile, "utf8"), altContent);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test("BEHAVIORAL: withFleetMigrationLock serializes across bots", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-lock-test-"));
  const lockFile = path.join(tmp, "test.lock");

  // First lock succeeds
  let executed = false;
  const res1 = withFleetMigrationLock(() => {
    executed = true;

    // While lock is held, concurrent attempt fails
    const concurrent = withFleetMigrationLock(() => "unreachable", lockFile);
    assert.strictEqual(concurrent, null);

    return 42;
  }, lockFile);

  assert.strictEqual(executed, true);
  assert.strictEqual(res1, 42);

  // After exit, lock is released and can be acquired again
  const res2 = withFleetMigrationLock(() => "second", lockFile);
  assert.strictEqual(res2, "second");

  fs.rmSync(tmp, { recursive: true, force: true });
});
