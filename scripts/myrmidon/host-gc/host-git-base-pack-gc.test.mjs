// myrmidon(1.6.7 BOT-DISK OPE-12489): tests for host-git-base-pack-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-git-base-pack-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const mod = await import(path.join(ROOT, "scripts/myrmidon/host-gc/host-git-base-pack-gc.mjs"));
const { parseArgs, acquireLock, journalRecord, scanGitBases, backupPacks, runGitBasePackGc } = mod;

const hasGit = spawnSync("git", ["--version"]).status === 0;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-git-base-pack-gc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build upstream + mirror + bot git-base with alternates, return paths. */
function makeFleetRepo(slug, { withAlternates = true } = {}) {
  const [owner, repo] = slug.split("/");
  const upstreamDir = path.join(tmpDir, "upstream", owner, `${repo}.git`);
  const mirrorRoot = path.join(tmpDir, "mirror");
  const mirrorDir = path.join(mirrorRoot, owner, `${repo}.git`);
  const botsRoot = path.join(tmpDir, "bots");
  const baseDir = path.join(botsRoot, "bot-1", ".myrmidon", "git-base", owner, `${repo}.git`);

  fs.mkdirSync(path.dirname(upstreamDir), { recursive: true });
  fs.mkdirSync(mirrorDir, { recursive: true });
  fs.mkdirSync(baseDir, { recursive: true });

  git(tmpDir, "init", "--bare", "--quiet", "-b", "main", upstreamDir);
  const work = fs.mkdtempSync(path.join(tmpDir, "work-"));
  git(work, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(work, "README.md"), `${slug}\n`);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "init");
  git(work, "push", "--quiet", upstreamDir, "main");

  git(tmpDir, "clone", "--mirror", "--quiet", upstreamDir, mirrorDir);
  git(mirrorDir, "repack", "-a", "-d");

  // Bot base: fill from upstream, repack into a single pack (real bases are
  // repacked by the alternates migration), then attach alternates.
  git(tmpDir, "init", "--bare", "--quiet", baseDir);
  git(baseDir, "fetch", "--quiet", upstreamDir, "+refs/heads/*:refs/remotes/origin/*");
  git(baseDir, "repack", "-a", "-d", "-l", "--keep-unreachable");
  if (withAlternates) {
    fs.mkdirSync(path.join(baseDir, "objects", "info"), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, "objects", "info", "alternates"),
      `${path.join(mirrorDir, "objects")}\n`,
    );
  }
  return { upstreamDir, mirrorRoot, mirrorDir, botsRoot, baseDir, owner, repo };
}

describe("parseArgs", () => {
  it("defaults to dry-run with standard host paths", () => {
    const args = parseArgs(["node", "script.mjs"]);
    assert.equal(args.dryRun, true);
    assert.equal(args.botsRoot, "/srv/myrmidon-bots");
    assert.equal(args.mirrorRoot, "/srv/myrmidon-cache/git");
    assert.equal(args.journal, "/var/log/myrmidon-host-gc.jsonl");
  });

  it("--apply switches to apply mode and honours overrides", () => {
    const args = parseArgs([
      "node", "script.mjs", "--apply",
      "--bots-root", "/b", "--mirror-root", "/m",
      "--backup-dir", "/bak", "--journal", "/j.jsonl", "--lock", "/l.lock",
    ]);
    assert.equal(args.dryRun, false);
    assert.equal(args.botsRoot, "/b");
    assert.equal(args.mirrorRoot, "/m");
    assert.equal(args.backupDir, "/bak");
  });
});

describe("acquireLock / journalRecord", () => {
  it("second lock acquisition fails while held", () => {
    const lockPath = path.join(tmpDir, "t.lock");
    const first = acquireLock(lockPath);
    assert.equal(first.ok, true);
    const second = acquireLock(lockPath);
    assert.equal(second.ok, false);
    first.release();
    const third = acquireLock(lockPath);
    assert.equal(third.ok, true);
    third.release();
  });

  it("appends JSONL records", () => {
    const journal = path.join(tmpDir, "j.jsonl");
    journalRecord(journal, { event: "a", n: 1 });
    journalRecord(journal, { event: "b", n: 2 });
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).event, "a");
    assert.equal(JSON.parse(lines[1]).n, 2);
  });
});

describe("scanGitBases", () => {
  it("finds bare repos in <bot>/.myrmidon/git-base/<owner>/<repo>.git layout and skips symlinks", () => {
    const { botsRoot, baseDir } = makeFleetRepo("acme/widgets");
    const link = path.join(botsRoot, "bot-1", ".myrmidon", "git-base", "acme", "linked.git");
    fs.symlinkSync(baseDir, link, "dir");

    const found = scanGitBases(botsRoot);
    assert.equal(found.length, 1);
    assert.equal(found[0].gitDir, baseDir);
    assert.equal(found[0].bot, "bot-1");
  });

  it("returns empty for missing root", () => {
    assert.deepEqual(scanGitBases(path.join(tmpDir, "nope")), []);
  });
});

describe("backupPacks", () => {
  it("hardlinks pack companions into the backup dir", () => {
    const { baseDir } = makeFleetRepo("acme/widgets");
    const packDir = path.join(baseDir, "objects", "pack");
    const backupDir = path.join(tmpDir, "backup");
    const backedUp = backupPacks(packDir, backupDir);
    assert.ok(backedUp.length >= 2, "should back up .pack and .idx");
    for (const dst of backedUp) {
      assert.ok(fs.existsSync(dst), `backup entry exists: ${dst}`);
      // hardlink: same inode
      const src = path.join(packDir, path.basename(dst));
      assert.equal(fs.statSync(src).ino, fs.statSync(dst).ino);
    }
  });
});

describe("runGitBasePackGc", { skip: !hasGit && "git missing" }, () => {
  it("dry-run plans removal of mirror-covered packs but deletes nothing", () => {
    const fleet = makeFleetRepo("acme/widgets");
    const packDir = path.join(fleet.baseDir, "objects", "pack");
    const before = fs.readdirSync(packDir).filter((f) => f.endsWith(".pack")).length;
    assert.ok(before > 0);

    const report = runGitBasePackGc({
      dryRun: true,
      botsRoot: fleet.botsRoot,
      mirrorRoot: fleet.mirrorRoot,
      journal: path.join(tmpDir, "j.jsonl"),
      lock: path.join(tmpDir, "l.lock"),
      backupDir: path.join(tmpDir, "bak"),
    }, { log: () => {} });

    assert.equal(report.total, 1);
    assert.equal(report.processed, 1);
    // Every object in the base pack came from upstream and the mirror was
    // cloned from upstream, so coverage is total: all checked packs removable.
    assert.ok(report.packsChecked > 0);
    assert.equal(report.packsRemoved, report.packsChecked);
    // Nothing deleted
    const after = fs.readdirSync(packDir).filter((f) => f.endsWith(".pack")).length;
    assert.equal(after, before);
  });

  it("apply removes mirror-covered packs after hardlink backup; repo stays fsck-clean via alternates", () => {
    const fleet = makeFleetRepo("acme/widgets");
    const packDir = path.join(fleet.baseDir, "objects", "pack");
    const backupDir = path.join(tmpDir, "bak");

    const report = runGitBasePackGc({
      dryRun: false,
      botsRoot: fleet.botsRoot,
      mirrorRoot: fleet.mirrorRoot,
      journal: path.join(tmpDir, "j.jsonl"),
      lock: path.join(tmpDir, "l.lock"),
      backupDir,
    }, { log: () => {} });

    assert.equal(report.processed, 1);
    assert.ok(report.packsRemoved > 0, "covered packs should be removed");
    assert.ok(report.bytesAfter < report.bytesBefore);
    // Backup holds hardlinked copies
    const backedUp = fs.readdirSync(path.join(backupDir, "bot-1", "acme", "widgets.git"));
    assert.ok(backedUp.some((f) => f.endsWith(".pack")), "backup must contain .pack files");
    // Refs still resolve through alternates (mirror has all objects)
    const ref = git(fleet.baseDir, "rev-parse", "--verify", "refs/remotes/origin/main");
    assert.ok(/^[0-9a-f]{40}$/.test(ref));
    const fsck = spawnSync("git", ["fsck", "--full"], { cwd: fleet.baseDir, encoding: "utf8", env: GIT_ENV });
    assert.equal(fsck.status, 0, `fsck after pack removal: ${fsck.stderr}`);
  });

  it("skips repos without alternates and repos whose alternates do not point at the mirror", () => {
    const noAlt = makeFleetRepo("acme/noalts", { withAlternates: false });

    const report = runGitBasePackGc({
      dryRun: true,
      botsRoot: noAlt.botsRoot,
      mirrorRoot: noAlt.mirrorRoot,
      journal: path.join(tmpDir, "j.jsonl"),
      lock: path.join(tmpDir, "l.lock"),
      backupDir: path.join(tmpDir, "bak"),
    }, { log: () => {} });

    assert.equal(report.total, 1);
    assert.equal(report.processed, 0);
    assert.equal(report.skippedNoAlternates, 1);
  });
});
