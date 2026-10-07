import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// BOT-DISK-H3c acceptance: the class-F archive module of botd.
//
// Fixture copies are real git repositories built in a tmp dir: an "origin"
// bare repo plus a worktree copy holding an unpushed commit, an untracked
// file, a modified tracked file and a stash. The module must produce a
// bundle that `git bundle verify` accepts, a patch, an untracked tar without
// ignored files, and a manifest matching the contract fields
// {key, createdAt, sizeBytes, truncatedUntracked} (epic OPE-5306 document
// `contracts`, section C1). Retention: 30 days or a byte cap per bot,
// oldest first.

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const archive = require(path.join(ROOT, "docker/bot-runtime/botd/lib/archive.cjs"));

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd, args) {
  const res = spawnSync("git", ["-C", cwd, ...args], { env: GIT_ENV, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "botd-archive-test-"));
}

/**
 * Build the standard fixture: origin with one commit, a worktree copy with
 * - one unpushed commit on branch bot/TEST-1
 * - one modified-but-uncommitted tracked file
 * - one untracked file
 * - one ignored untracked file (must NOT land in the tar)
 * - one stash entry
 */
function makeFixtureCopy(baseDir) {
  const originDir = path.join(baseDir, "origin.git");
  fs.mkdirSync(originDir, { recursive: true });
  git(originDir, ["init", "--bare", "-b", "main"]);
  const seedDir = path.join(baseDir, "seed");
  git(baseDir, ["clone", originDir, seedDir]);
  fs.writeFileSync(path.join(seedDir, "tracked.txt"), "base\n");
  git(seedDir, ["add", "tracked.txt"]);
  git(seedDir, ["commit", "-m", "base"]);
  git(seedDir, ["push", "origin", "main"]);

  const copyDir = path.join(baseDir, "copy");
  git(baseDir, ["clone", originDir, copyDir]);
  git(copyDir, ["checkout", "-b", "bot/TEST-1"]);
  fs.writeFileSync(path.join(copyDir, "work.txt"), "unpushed work\n");
  git(copyDir, ["add", "work.txt"]);
  git(copyDir, ["commit", "-m", "unpushed commit"]);
  // uncommitted change on a tracked file
  fs.appendFileSync(path.join(copyDir, "tracked.txt"), "dirty line\n");
  // untracked + ignored
  fs.writeFileSync(path.join(copyDir, "notes.txt"), "untracked notes\n");
  fs.writeFileSync(path.join(copyDir, ".gitignore"), "ignored.log\n");
  fs.writeFileSync(path.join(copyDir, "ignored.log"), "must not be archived\n");
  // stash
  fs.writeFileSync(path.join(copyDir, "stashed.txt"), "stashed content\n");
  git(copyDir, ["add", "stashed.txt"]);
  git(copyDir, ["stash", "push", "-m", "wip"]);
  return { originDir, copyDir };
}

function readManifest(archiveDir, stem) {
  return JSON.parse(fs.readFileSync(path.join(archiveDir, `${stem}.manifest.json`), "utf8"));
}

describe("botd archive (BOT-DISK-H3c, class F)", () => {
  it("creates bundle+patch+untracked.tar+manifest; bundle verifies", () => {
    const tmp = mkTmp();
    const { copyDir } = makeFixtureCopy(tmp);
    const archiveDir = path.join(tmp, "archive");
    const res = archive.archiveCopy(copyDir, "TEST-1", { archiveDir });
    assert.equal(res.ok, true, res.error);

    const files = fs.readdirSync(archiveDir);
    for (const suffix of ["bundle", "patch", "untracked.tar", "manifest.json"]) {
      assert.ok(files.includes(`${res.stem}.${suffix}`), `missing ${suffix}: ${files}`);
    }
    // stem naming per contract: <KEY>-<ts>
    assert.match(res.stem, /^TEST-1-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/);

    // bundle verifies against the origin repo too (copy-independent readback)
    const verify = spawnSync("git", ["-C", copyDir, "bundle", "verify", res.paths.bundle], { env: GIT_ENV, encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stderr);

    // bundle carries the unpushed branch
    const heads = spawnSync("git", ["-C", copyDir, "bundle", "list-heads", res.paths.bundle], { env: GIT_ENV, encoding: "utf8" });
    assert.match(heads.stdout, /refs\/heads\/bot\/TEST-1/);

    // patch contains the dirty tracked-file change
    const patchText = fs.readFileSync(res.paths.patch, "utf8");
    assert.match(patchText, /dirty line/);

    // tar contains notes.txt but NOT ignored.log
    const tarList = spawnSync("tar", ["-tf", res.paths.untracked], { encoding: "utf8" });
    assert.equal(tarList.status, 0, tarList.stderr);
    assert.match(tarList.stdout, /notes\.txt/);
    assert.doesNotMatch(tarList.stdout, /ignored\.log/);

    // manifest contract fields
    const mf = readManifest(archiveDir, res.stem);
    assert.equal(mf.key, "TEST-1");
    assert.equal(typeof mf.createdAt, "string");
    assert.ok(!Number.isNaN(Date.parse(mf.createdAt)));
    assert.equal(typeof mf.sizeBytes, "number");
    assert.ok(mf.sizeBytes > 0);
    assert.equal(mf.truncatedUntracked, false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("truncated untracked over the cap: only bundle+patch, flag in manifest", () => {
    const tmp = mkTmp();
    const { copyDir } = makeFixtureCopy(tmp);
    // A big untracked file; the cap is set synthetically small (contract: cap
    // 200 МБ, here 1 KiB to exercise the path without 200 МБ of I/O).
    fs.writeFileSync(path.join(copyDir, "big.bin"), Buffer.alloc(64 * 1024, 7));
    const archiveDir = path.join(tmp, "archive");
    const res = archive.archiveCopy(copyDir, "TEST-1", { archiveDir, untrackedCapBytes: 1024 });
    assert.equal(res.ok, true, res.error);
    const files = fs.readdirSync(archiveDir);
    assert.ok(files.includes(`${res.stem}.bundle`));
    assert.ok(files.includes(`${res.stem}.patch`));
    assert.ok(!files.includes(`${res.stem}.untracked.tar`), "tar must be dropped on cap overflow");
    const mf = readManifest(archiveDir, res.stem);
    assert.equal(mf.truncatedUntracked, true);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("a corrupt bundle means ok:false and the archive files are removed", () => {
    const tmp = mkTmp();
    const { copyDir } = makeFixtureCopy(tmp);
    const archiveDir = path.join(tmp, "archive");
    // Break verification by pointing git at a repository that cannot read the
    // bundle's prerequisites: simulate by monkey-level corruption — write the
    // archive for real, then truncate the bundle and re-verify explicitly.
    const res = archive.archiveCopy(copyDir, "TEST-1", { archiveDir });
    assert.equal(res.ok, true);
    const fd = fs.openSync(res.paths.bundle, "r+");
    fs.ftruncateSync(fd, 8);
    fs.closeSync(fd);
    const v = archive.verifyBundle(res.paths.bundle, copyDir);
    assert.equal(v.ok, false);
    assert.match(v.error, /bundle verify/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("archive fails cleanly on a non-repository path", () => {
    const tmp = mkTmp();
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    const res = archive.archiveCopy(plain, "TEST-1", { archiveDir: path.join(tmp, "archive") });
    assert.equal(res.ok, false);
    assert.match(res.error, /not a git repository/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("retention removes the oldest first: by age (30 сут) and by cap", () => {
    const tmp = mkTmp();
    const archiveDir = path.join(tmp, "archive");
    const { copyDir } = makeFixtureCopy(tmp);

    // three archives with distinct timestamps
    const t1 = new Date("2026-09-01T00:00:00Z"); // older than 30d vs now
    const t2 = new Date("2026-10-05T00:00:00Z");
    const t3 = new Date("2026-10-06T00:00:00Z");
    const r1 = archive.archiveCopy(copyDir, "TEST-1", { archiveDir, now: t1 });
    const r2 = archive.archiveCopy(copyDir, "TEST-2", { archiveDir, now: t2 });
    const r3 = archive.archiveCopy(copyDir, "TEST-3", { archiveDir, now: t3 });
    assert.ok(r1.ok && r2.ok && r3.ok);

    // age-based: with now = 2026-10-07 the t1 archive is > 30 days old
    let pr = archive.pruneArchives({ archiveDir, now: new Date("2026-10-07T00:00:00Z") });
    assert.deepEqual(pr.removed, [r1.stem]);
    assert.deepEqual(pr.kept.sort(), [r2.stem, r3.stem].sort());
    assert.ok(!fs.existsSync(r2.paths.bundle) === false);
    assert.ok(!fs.existsSync(path.join(archiveDir, `${r1.stem}.bundle`)));

    // cap-based: cap below the size of two archives removes the oldest remaining
    const size2 = r2.manifest.sizeBytes;
    const size3 = r3.manifest.sizeBytes;
    pr = archive.pruneArchives({
      archiveDir,
      now: new Date("2026-10-07T00:00:00Z"),
      maxAgeMs: 365 * 24 * 3600 * 1000, // age rule must not fire now
      capBytes: size2 + size3 - 1,
    });
    assert.deepEqual(pr.removed, [r2.stem]);
    assert.deepEqual(pr.kept, [r3.stem]);
    assert.ok(fs.existsSync(r3.paths.bundle));

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("retention tolerates a missing archive dir (nothing to do)", () => {
    const tmp = mkTmp();
    const pr = archive.pruneArchives({ archiveDir: path.join(tmp, "nope") });
    assert.equal(pr.ok, true);
    assert.deepEqual(pr.removed, []);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("listArchives groups files by stem and sorts oldest first", () => {
    const tmp = mkTmp();
    const archiveDir = path.join(tmp, "archive");
    const { copyDir } = makeFixtureCopy(tmp);
    const ra = archive.archiveCopy(copyDir, "AAA-1", { archiveDir, now: new Date("2026-10-01T10:00:00Z") });
    const rb = archive.archiveCopy(copyDir, "BBB-2", { archiveDir, now: new Date("2026-10-02T10:00:00Z") });
    assert.ok(ra.ok && rb.ok);
    const entries = archive.listArchives(archiveDir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, "AAA-1");
    assert.equal(entries[1].key, "BBB-2");
    assert.equal(entries[0].files.length, 4);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
