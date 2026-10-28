import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { syncMirrorAlternates, findMirror } from "../../../docker/bot-runtime/myr-ws/lib/base.js";

function runGit(args, cwd) {
  const res = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
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

test("myr-ws shared git mirror: alternates link, <100MB own objects, and unpushed work preservation", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "myr-ws-mirror-test-"));
  const mirrorRoot = path.join(tmp, "cache", "git");
  const parsed = { owner: "itkadr-git", repo: "myrmidon" };
  const mirrorDir = path.join(mirrorRoot, parsed.owner, `${parsed.repo}.git`);
  const baseDir = path.join(tmp, "bot", "git-base", parsed.owner, `${parsed.repo}.git`);

  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  // 1. Initialize bare mirror with upstream commits
  runGit(["init", "--bare", mirrorDir]);
  const seedWork = path.join(tmp, "seed-work");
  fs.mkdirSync(seedWork, { recursive: true });
  runGit(["init", seedWork]);
  runGit(["config", "user.name", "Upstream Dev"], seedWork);
  runGit(["config", "user.email", "dev@example.com"], seedWork);

  // Generate ~1 MB of files to simulate upstream repository contents
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(seedWork, `file_${i}.txt`), "upstream content ".repeat(20000));
  }
  runGit(["add", "."], seedWork);
  const upstreamSha = runGit(["commit", "-m", "upstream release v1"], seedWork);
  runGit(["push", mirrorDir, "HEAD:refs/heads/main"], seedWork);
  runGit(["repack", "-a", "-d"], mirrorDir);

  const mirrorSize = getDirSize(path.join(mirrorDir, "objects"));
  assert.ok(mirrorSize > 1000, `mirror objects should contain repo data, got ${mirrorSize} bytes`);

  // 2. Initialize base repo and link alternates via syncMirrorAlternates
  runGit(["init", "--bare", baseDir]);
  const env = {
    MYRMIDON_GIT_MIRROR_ROOT: mirrorRoot,
    PATH: process.env.PATH,
  };

  const found = findMirror(parsed, env);
  assert.strictEqual(found, mirrorDir, "findMirror should locate mirror repository");

  const syncResult = syncMirrorAlternates(env, baseDir, parsed);
  assert.strictEqual(syncResult, mirrorDir, "syncMirrorAlternates should return mirrorDir");

  const altFile = path.join(baseDir, "objects", "info", "alternates");
  assert.ok(fs.existsSync(altFile), "objects/info/alternates file must exist");
  const altContent = fs.readFileSync(altFile, "utf8").trim();
  assert.strictEqual(altContent, path.join(mirrorDir, "objects"));

  // 3. Verify own object size is < 100 MB (< 100 KB in this test)
  const baseOwnObjectsSize = getDirSize(path.join(baseDir, "objects", "pack")) +
    getDirSize(path.join(baseDir, "objects")) -
    fs.statSync(altFile).size;
  const maxBytes = 100 * 1024 * 1024; // 100 MB criterion
  assert.ok(baseOwnObjectsSize < maxBytes, `own object store must be <100MB, got ${baseOwnObjectsSize} bytes`);

  // 4. Create developer workspace and unpushed branch/commit
  const devWork = path.join(tmp, "workspace", "OPE-1234");
  fs.mkdirSync(devWork, { recursive: true });
  runGit(["clone", baseDir, devWork]);
  runGit(["config", "user.name", "Bot Engineer"], devWork);
  runGit(["config", "user.email", "bot@example.com"], devWork);
  runGit(["checkout", "-b", "myr/feature-unpushed"], devWork);

  fs.writeFileSync(path.join(devWork, "unpushed_feature.txt"), "local unpushed critical work");
  runGit(["add", "unpushed_feature.txt"], devWork);
  const unpushedSha = runGit(["commit", "-m", "feat: unpushed local commit"], devWork);
  runGit(["push", "origin", "myr/feature-unpushed"], devWork);

  // Verify unpushed commit exists in baseDir
  const baseCommitLog = runGit(["log", "-1", "--format=%s", "refs/heads/myr/feature-unpushed"], baseDir);
  assert.strictEqual(baseCommitLog, "feat: unpushed local commit");

  // 5. Re-run syncMirrorAlternates with repack to simulate migration pass
  const secondSync = syncMirrorAlternates(env, baseDir, parsed);
  assert.strictEqual(secondSync, mirrorDir);

  // 6. Assert unpushed commit is NOT lost after repack/migration pass
  const postLog = runGit(["log", "-1", "--format=%s", "refs/heads/myr/feature-unpushed"], baseDir);
  assert.strictEqual(postLog, "feat: unpushed local commit", "unpushed commit must be preserved");

  const fsckRes = spawnSync("/usr/bin/git", ["fsck", "--full"], { cwd: baseDir, encoding: "utf8" });
  assert.strictEqual(fsckRes.status, 0, `git fsck failed: ${fsckRes.stderr}`);

  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true });
});
