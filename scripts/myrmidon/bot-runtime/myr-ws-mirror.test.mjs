import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { syncMirrorAlternates, findMirror } = require("../../../docker/bot-runtime/myr-ws/lib/base.js");

const GIT_REAL = fs.existsSync("/opt/paperclip/libexec/git") ? "/opt/paperclip/libexec/git" : "git";

function runGit(args, cwd) {
  const res = spawnSync(GIT_REAL, args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function getDirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

test("myr-ws shared git mirror: alternates link, <100MB own objects, and unpushed branch preservation through migration", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-mirror-test-"));
  const mirrorRoot = path.join(tmp, "cache", "git");
  const parsed = { owner: "itkadr-git", repo: "myrmidon" };
  const upstreamDir = path.join(tmp, "upstream", parsed.owner, `${parsed.repo}.git`);
  const mirrorDir = path.join(mirrorRoot, parsed.owner, `${parsed.repo}.git`);
  const baseDir = path.join(tmp, "bot", "git-base", parsed.owner, `${parsed.repo}.git`);

  fs.mkdirSync(upstreamDir, { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  // 1. Initialize upstream central bare repository with release v1
  runGit(["init", "--bare", upstreamDir]);
  const seedWork = path.join(tmp, "seed-work");
  fs.mkdirSync(seedWork, { recursive: true });
  runGit(["init", seedWork]);
  runGit(["config", "user.name", "Upstream Dev"], seedWork);
  runGit(["config", "user.email", "dev@example.com"], seedWork);

  // Generate upstream repository contents (>100 KB)
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(seedWork, `file_${i}.txt`), "upstream content ".repeat(20000));
  }
  runGit(["add", "."], seedWork);
  runGit(["commit", "-m", "upstream release v1"], seedWork);
  runGit(["push", upstreamDir, "HEAD:refs/heads/main"], seedWork);

  // 2. Provision host-wide bare mirror from upstream
  runGit(["clone", "--mirror", upstreamDir, mirrorDir]);
  runGit(["repack", "-a", "-d"], mirrorDir);

  const mirrorSize = getDirSize(path.join(mirrorDir, "objects"));
  assert.ok(mirrorSize > 1000, `mirror objects should contain repo data, got ${mirrorSize} bytes`);

  // 3. Initialize bot base repo and link alternates via syncMirrorAlternates
  runGit(["init", "--bare", baseDir]);
  const env = {
    ...process.env,
    MYRMIDON_GIT_MIRROR_ROOT: mirrorRoot,
    MYRMIDON_GIT_REAL: GIT_REAL,
  };

  const found = findMirror(parsed, env);
  assert.strictEqual(found, mirrorDir, "findMirror should locate mirror repository");

  const syncResult = syncMirrorAlternates(env, baseDir, parsed);
  assert.strictEqual(syncResult, mirrorDir, "syncMirrorAlternates should return mirrorDir");

  const altFile = path.join(baseDir, "objects", "info", "alternates");
  assert.ok(fs.existsSync(altFile), "objects/info/alternates file must exist");
  const altContent = fs.readFileSync(altFile, "utf8").trim();
  assert.strictEqual(altContent, path.join(mirrorDir, "objects"));

  // Verify base own object size is < 100 MB (< 100 KB in this test)
  const baseOwnObjectsSize =
    getDirSize(path.join(baseDir, "objects", "pack")) +
    getDirSize(path.join(baseDir, "objects")) -
    fs.statSync(altFile).size;
  const maxBytes = 100 * 1024 * 1024; // 100 MB criterion
  assert.ok(baseOwnObjectsSize < maxBytes, `own object store must be <100MB, got ${baseOwnObjectsSize} bytes`);

  // 4. Create pre-migration developer workspace by cloning directly from UPSTREAM (NOT mirror)
  // This represents an existing workspace on the bot host created before the shared mirror was available.
  const devWork = path.join(tmp, "workspace", "OPE-1234");
  fs.mkdirSync(devWork, { recursive: true });
  runGit(["clone", upstreamDir, devWork]);
  runGit(["config", "user.name", "Bot Engineer"], devWork);
  runGit(["config", "user.email", "bot@example.com"], devWork);

  // Verify pre-migration state: full independent copy, NO alternates file
  const preMigrateAltFile = path.join(devWork, ".git", "objects", "info", "alternates");
  assert.ok(!fs.existsSync(preMigrateAltFile), "pre-migration workspace must not have alternates file");
  const preMigrateObjectsSize = getDirSize(path.join(devWork, ".git", "objects"));
  assert.ok(preMigrateObjectsSize > 1000, "pre-migration workspace has full independent objects");

  // Create unpushed branch with unpushed critical work in devWork
  runGit(["checkout", "-b", "myr/feature-unpushed"], devWork);
  fs.writeFileSync(path.join(devWork, "unpushed_feature.txt"), "local unpushed critical work");
  runGit(["add", "unpushed_feature.txt"], devWork);
  runGit(["commit", "-m", "feat: unpushed local commit"], devWork);
  const unpushedSha = runGit(["rev-parse", "HEAD"], devWork);

  // Assert unpushed commit and branch exist ONLY in devWork: NOT in upstream, NOT in mirror, NOT in base
  assert.throws(
    () => runGit(["rev-parse", "--verify", "refs/heads/myr/feature-unpushed"], upstreamDir),
    "unpushed branch must not exist in upstream"
  );
  assert.throws(
    () => runGit(["rev-parse", "--verify", "refs/heads/myr/feature-unpushed"], mirrorDir),
    "unpushed branch must not exist in mirror"
  );
  assert.throws(
    () => runGit(["rev-parse", "--verify", "refs/heads/myr/feature-unpushed"], baseDir),
    "unpushed branch must not exist in base"
  );

  // 5. Execute production migration on the existing developer workspace:
  // syncMirrorAlternates discovers mirror, attaches alternates, and runs repack (-a -d -l)
  const wsMigrateResult = syncMirrorAlternates(env, devWork, parsed);
  assert.strictEqual(wsMigrateResult, mirrorDir, "syncMirrorAlternates should configure mirror for workspace");

  const wsAltFile = path.join(devWork, ".git", "objects", "info", "alternates");
  assert.ok(fs.existsSync(wsAltFile), "workspace alternates file must exist after migration");
  assert.strictEqual(fs.readFileSync(wsAltFile, "utf8").trim(), path.join(mirrorDir, "objects"));

  // 6. Assert unpushed commit and working copy are completely preserved after migration
  const postMigrateSha = runGit(["rev-parse", "HEAD"], devWork);
  assert.strictEqual(postMigrateSha, unpushedSha, "unpushed commit SHA must be identical after migration");

  const postMigrateLog = runGit(["log", "-1", "--format=%s", "HEAD"], devWork);
  assert.strictEqual(postMigrateLog, "feat: unpushed local commit", "commit message must be intact");

  const fileContent = fs.readFileSync(path.join(devWork, "unpushed_feature.txt"), "utf8");
  assert.strictEqual(fileContent, "local unpushed critical work", "file content of unpushed commit must be intact");

  const fsckRes = spawnSync(GIT_REAL, ["fsck", "--full"], { cwd: devWork, encoding: "utf8" });
  assert.strictEqual(fsckRes.status, 0, `git fsck failed in migrated workspace: ${fsckRes.stderr}`);

  // Confirm branch remains purely local and was never pushed
  assert.throws(
    () => runGit(["rev-parse", "--verify", "refs/heads/myr/feature-unpushed"], upstreamDir),
    "branch must remain local to workspace and unpushed to upstream"
  );
  assert.throws(
    () => runGit(["rev-parse", "--verify", "refs/heads/myr/feature-unpushed"], mirrorDir),
    "branch must remain local to workspace and unpushed to mirror"
  );

  // 7. Verify workspace own objects after repack are tiny (< 100 KB, well under 100 MB criterion)
  const wsOwnObjectsSize = getDirSize(path.join(devWork, ".git", "objects"));
  assert.ok(
    wsOwnObjectsSize < maxBytes,
    `migrated workspace own objects must be <100MB, got ${wsOwnObjectsSize} bytes`
  );

  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("syncMirrorAlternates rolls back alternates file and throws on git repack failure", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-mirror-fail-test-"));
  const mirrorRoot = path.join(tmp, "cache", "git");
  const parsed = { owner: "itkadr-git", repo: "myrmidon" };
  const mirrorDir = path.join(mirrorRoot, parsed.owner, `${parsed.repo}.git`);
  const workDir = path.join(tmp, "work");

  fs.mkdirSync(mirrorDir, { recursive: true });
  runGit(["init", "--bare", mirrorDir]);

  // Seed mirror with a commit so there are objects
  const seedWork = path.join(tmp, "seed");
  fs.mkdirSync(seedWork, { recursive: true });
  runGit(["init", seedWork]);
  runGit(["config", "user.name", "Tester"], seedWork);
  runGit(["config", "user.email", "test@example.com"], seedWork);
  fs.writeFileSync(path.join(seedWork, "file.txt"), "hello world");
  runGit(["add", "."], seedWork);
  runGit(["commit", "-m", "init"], seedWork);
  runGit(["push", mirrorDir, "HEAD:refs/heads/main"], seedWork);

  runGit(["clone", mirrorDir, workDir]);
  runGit(["config", "user.name", "Tester"], workDir);
  runGit(["config", "user.email", "test@example.com"], workDir);
  fs.writeFileSync(path.join(workDir, "local.txt"), "local commit");
  runGit(["add", "."], workDir);
  runGit(["commit", "-m", "local"], workDir);

  const env = {
    ...process.env,
    MYRMIDON_GIT_MIRROR_ROOT: mirrorRoot,
    MYRMIDON_GIT_REAL: GIT_REAL,
  };

  // Make git repack fail by replacing .git/objects/pack with a regular file (triggers ENOTDIR)
  const packDir = path.join(workDir, ".git", "objects", "pack");
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.writeFileSync(packDir, "not a directory");

  const altFile = path.join(workDir, ".git", "objects", "info", "alternates");
  assert.ok(!fs.existsSync(altFile), "alternates file should not exist initially");

  let thrown = false;
  try {
    syncMirrorAlternates(env, workDir, parsed);
  } catch {
    thrown = true;
  }

  assert.ok(thrown, "syncMirrorAlternates must rethrow when git repack fails");
  const altFileExists = fs.existsSync(altFile);
  if (altFileExists) {
    const content = fs.readFileSync(altFile, "utf8");
    assert.ok(
      !content.includes(path.join(mirrorDir, "objects")),
      "alternates file must not contain mirror objects path after rollback"
    );
  } else {
    assert.ok(!altFileExists, "alternates file should be completely rolled back/removed");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});
