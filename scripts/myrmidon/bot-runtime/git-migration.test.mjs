import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  migrateIdleGitRepos,
  withFleetMigrationLock,
  removeMirrorCoveredPacks,
  runRepackWithNiceIonice,
  findMigrationCandidates,
  resolveWorktreeGitDir,
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
  fs.writeFileSync(path.join(repoDir, "HEAD"), "ref: refs/heads/main\n");

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
  fs.writeFileSync(path.join(repoDir, "HEAD"), "ref: refs/heads/main\n");

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

// ---------------------------------------------------------------------------
// OPE-10311 integration tests: real git repos on disk (git available in CI).
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
    ...opts,
  });
}

function git(gitDir, args, input) {
  const args2 = ["--git-dir", gitDir, ...args];
  return input !== undefined
    ? sh("git", args2, { input })
    : sh("git", args2);
}

/** A real repo with one reachable commit, plus unreachable loose objects. */
function makeRepo(gitDir, { unreachable = true } = {}) {
  sh("git", ["init", "-q", "--bare", gitDir]);
  const src = path.join(path.dirname(gitDir), "src-" + path.basename(gitDir));
  sh("git", ["init", "-q", src]);
  sh("git", ["-C", src, "config", "user.email", "test@example.com"]);
  sh("git", ["-C", src, "config", "user.name", "test"]);
  fs.writeFileSync(path.join(src, "file.txt"), "hello\n");
  sh("git", ["-C", src, "add", "."]);
  sh("git", ["-C", src, "commit", "-q", "-m", "init"]);
  sh("git", ["-C", src, "push", "-q", gitDir, "HEAD:refs/heads/main"]);
  if (unreachable) {
    fs.writeFileSync(path.join(src, "dangling.txt"), "dangling\n");
    sh("git", ["-C", src, "add", "."]);
    sh("git", ["-C", src, "commit", "-q", "-m", "unreachable commit"]);
    // Pushed under a ref, then the ref is deleted: its objects stay loose and
    // unreachable, like the live git-base measured in OPE-10311.
    sh("git", ["-C", src, "push", "-q", gitDir, "HEAD:refs/heads/danglingRef"]);
    git(gitDir, ["update-ref", "-d", "refs/heads/danglingRef"]);
    // Age every object past the prune-expire threshold.
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const line of git(gitDir, ["cat-file", "--batch-all-objects", "--batch-check"]).trim().split("\n")) {
      const hash = line.split(" ")[0];
      if (/^[0-9a-f]{40,64}$/.test(hash)) {
        try {
          fs.utimesSync(path.join(gitDir, "objects", hash.slice(0, 2), hash.slice(2)), old, old);
        } catch {}
      }
    }
  }
  fs.rmSync(src, { recursive: true, force: true });
  return gitDir;
}

test("INTEGRATION: prune+repack reclaims aged unreachable loose objects (real git)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-int-"));
  const repo = makeRepo(path.join(tmp, "repo.git"));
  const looseBefore = fs.readdirSync(path.join(repo, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
  assert.ok(looseBefore > 0, "fixture must have loose objects");

  const ok = runRepackWithNiceIonice(repo, { pruneExpire: "2.weeks.ago" });
  assert.strictEqual(ok, true);

  const looseAfter = fs.readdirSync(path.join(repo, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
  assert.ok(looseAfter < looseBefore, `prune must remove unreachable loose objects (${looseBefore} -> ${looseAfter})`);
  const heads = git(repo, ["rev-list", "--count", "refs/heads/main"]).trim();
  assert.strictEqual(heads, "1");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INTEGRATION: findMigrationCandidates finds nested git-base/<owner>/<repo>.git and no-alternates repos", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-nest-"));
  const baseDir = path.join(tmp, "git-base");
  const nested = path.join(baseDir, "itkadr-git", "myrmidon.git");
  const plain = path.join(baseDir, "vendor.git");
  makeRepo(nested);
  makeRepo(plain);

  const cands = findMigrationCandidates(baseDir, path.join(tmp, "no-workspaces"));
  assert.ok(cands.some((c) => c.gitDir === nested), "nested <owner>/<repo>.git must be found");
  assert.ok(cands.some((c) => c.gitDir === plain), "legacy one-level repo must be found");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INTEGRATION: resolveWorktreeGitDir follows .git pointer and commondir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-wt-"));
  const base = makeRepo(path.join(tmp, "base.git"));
  const wt = path.join(tmp, "worktree");
  git(base, ["worktree", "add", "--detach", wt, "refs/heads/main"]);
  const resolved = resolveWorktreeGitDir(wt);
  assert.ok(resolved, "pointer must resolve");
  assert.strictEqual(fs.realpathSync(resolved), fs.realpathSync(base));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INTEGRATION: removeMirrorCoveredPacks deletes a pack fully present in the mirror", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-mirror-"));
  const mirror = makeRepo(path.join(tmp, "mirror.git"), { unreachable: false });
  git(mirror, ["repack", "-a", "-d"]);
  const repo = path.join(tmp, "repo.git");
  sh("git", ["clone", "-q", "--bare", mirror, repo]);
  git(repo, ["repack", "-a", "-d"]);
  const packDir = path.join(repo, "objects", "pack");
  const packsBefore = fs.readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  assert.ok(packsBefore.length > 0, "repo must have a pack");

  const alternates = `${path.join(mirror, "objects")}\n`;
  const res = removeMirrorCoveredPacks(repo, alternates);
  assert.strictEqual(res.checked, packsBefore.length);
  assert.ok(res.removed >= 1, `mirror-covered pack must be removed (removed=${res.removed})`);
  const packsAfter = fs.readdirSync(packDir).filter((f) => f.endsWith(".pack"));
  assert.ok(packsAfter.length < packsBefore.length);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INTEGRATION: removeMirrorCoveredPacks keeps a pack with objects missing from the mirror", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-keep-"));
  const repo = makeRepo(path.join(tmp, "repo.git"));
  git(repo, ["repack", "-a", "-d"]);
  const mirror = path.join(tmp, "mirror.git");
  sh("git", ["init", "-q", "--bare", mirror]); // empty mirror: nothing covered
  const alternates = `${path.join(mirror, "objects")}\n`;
  const res = removeMirrorCoveredPacks(repo, alternates);
  assert.strictEqual(res.removed, 0, "pack with mirror-missing objects must stay");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INTEGRATION: migrateIdleGitRepos end-to-end — prune, repack, mirror pack removal, marker", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "git-mig-e2e-"));
  const baseDir = path.join(tmp, "git-base");
  const wsDir = path.join(tmp, "workspaces");
  fs.mkdirSync(wsDir, { recursive: true });

  const mirror = makeRepo(path.join(tmp, "mirror.git"), { unreachable: false });
  git(mirror, ["repack", "-a", "-d"]);

  const repo = path.join(baseDir, "itkadr-git", "myrmidon.git");
  sh("git", ["clone", "-q", "--bare", mirror, repo]);
  fs.mkdirSync(path.join(repo, "objects", "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, "objects", "info", "alternates"), `${path.join(mirror, "objects")}\n`);
  // Keep an intentionally redundant copy of the mirror pack. The migration
  // repack may skip it (objects are already available through alternates), so
  // explicit dedupe must remove it afterward.
  git(repo, ["repack", "-a", "-d"]);
  const packDir = path.join(repo, "objects", "pack");
  const packsBefore = fs.readdirSync(packDir).filter((f) => f.endsWith(".pack")).length;
  assert.ok(packsBefore > 0);

  const du = (dir) => {
    let total = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      total += ent.isDirectory() ? du(p) : fs.statSync(p).size;
    }
    return total;
  };
  const sizeBefore = du(repo);
  const looseBefore = fs.readdirSync(path.join(repo, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;

  const res = migrateIdleGitRepos({
    baseDir,
    workspacesDir: wsDir,
    idle: true,
    enabled: true,
    pruneExpire: "2.weeks.ago",
    lockPathOverride: path.join(tmp, "fleet.lock"),
    log: () => {},
  });

  assert.strictEqual(res.migrated, 1);
  // The migration must actually reclaim storage: aged unreachable loose
  // objects pruned and/or redundant packs gone (repack -d already drops
  // fully-covered packs; the explicit mirror dedupe covers the rest).
  const looseAfter = fs.readdirSync(path.join(repo, "objects")).filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
  const sizeAfter = du(repo);
  assert.ok(
    looseAfter < looseBefore || sizeAfter < sizeBefore,
    `must reclaim storage (loose ${looseBefore}->${looseAfter}, bytes ${sizeBefore}->${sizeAfter})`
  );
  // History stays fully readable and alternates are preserved.
  const count = git(repo, ["rev-list", "--count", "refs/heads/main"]).trim();
  assert.strictEqual(count, "1");
  assert.ok(fs.existsSync(path.join(repo, "objects", "info", REPACK_MIGRATED_MARKER)));
  assert.strictEqual(
    fs.readFileSync(path.join(repo, "objects", "info", "alternates"), "utf8"),
    `${path.join(mirror, "objects")}\n`,
    "alternates must be preserved"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});
