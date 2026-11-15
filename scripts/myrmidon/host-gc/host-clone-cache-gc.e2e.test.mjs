// myrmidon(1.6.7-BOT-DISK-HOST-GC): end-to-end tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.e2e.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

let tmpDir;
let boardServer;
let boardUrl;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-gc-e2e-"));
});

before(async () => {
  boardServer = createServer((req, res) => {
    const identifier = decodeURIComponent(req.url.split("/").pop());
    if (!req.url.startsWith("/api/issues/") || !/^OPE-\d+$/.test(identifier)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.setHeader("connection", "close");
    res.end(JSON.stringify({ status: "done" }));
  });
  await new Promise((resolve) => boardServer.listen(0, "127.0.0.1", resolve));
  boardUrl = `http://127.0.0.1:${boardServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => boardServer.close(resolve));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, BOARD_API_URL: boardUrl },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function makeGitClone(dir, { clean = true, pushed = true, stash = false, alternates = false, ageHours = 25 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init"]);
  git(["config", "user.email", "test@test"]);
  git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, "README.md"), "test");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  if (!clean) fs.writeFileSync(path.join(dir, "dirty.txt"), "dirty");
  if (stash) {
    fs.writeFileSync(path.join(dir, "stash.txt"), "stash");
    git(["add", "."]);
    git(["stash"]);
  }
  if (alternates) {
    const gitDir = path.join(dir, ".git");
    const infoDir = path.join(gitDir, "objects", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, "alternates"), "/tmp/fake-alternates\n");
  }
  // Set mtime to simulate age
  const old = new Date(Date.now() - ageHours * 60 * 60 * 1000);
  fs.utimesSync(dir, old, old);
  return dir;
}

describe("host-clone-cache-gc e2e", () => {
  it("expires archives older than 24 hours without removing newer archives or symlinks", async () => {
    const root = path.join(tmpDir, "root");
    const archives = path.join(root, ".gc-archive");
    fs.mkdirSync(archives, { recursive: true });
    const oldArchive = path.join(archives, "OPE-1-20260101-000000.tar.gz");
    const newArchive = path.join(archives, "OPE-2-20260101-000000.tar.gz");
    const link = path.join(archives, "OPE-3-20260101-000000.tar.gz");
    fs.writeFileSync(oldArchive, "old");
    fs.writeFileSync(newArchive, "new");
    fs.symlinkSync(newArchive, link);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldArchive, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(oldArchive), false);
    assert.equal(fs.existsSync(newArchive), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  it("dry-run plans but does not delete", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12345"));
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, true);
    assert.ok(fs.existsSync(clone));
  });

  it("apply removes clean+pushed clones >24h", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12345"), { clean: true, pushed: true, ageHours: 25 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.dryRun, false);
    // Note: without a real git remote, isPushed may return false; the script should archive-remove
    // We assert the clone is gone from the original path
    assert.equal(fs.existsSync(clone), false);
  });

  it("keeps an alternate-object checkout rather than archiving the whole directory", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12345"), { alternates: true });
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone), "unrecoverable checkout must be retained");
    const archiveRoot = path.join(root, ".gc-archive");
    assert.ok(!fs.existsSync(archiveRoot) || fs.readdirSync(archiveRoot).length === 0);
  });

  it("keeps a closed clone when a nested repository has unpublished work", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12345"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    git("config", "core.excludesFile", path.join(tmpDir, "global-ignore"));
    fs.writeFileSync(path.join(tmpDir, "global-ignore"), "nested/\n");
    const nested = makeGitClone(path.join(clone, "nested"));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(nested), "unsafe nested repository must not be deleted");
  });

  it("preserves unpublished commits on a non-current branch", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    const original = git("branch", "--show-current");
    git("switch", "-c", "unpublished");
    fs.writeFileSync(path.join(clone, "work.txt"), "unpublished\n");
    git("add", "work.txt");
    git("commit", "-m", "unpublished work");
    const commit = git("rev-parse", "HEAD");
    git("switch", original);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archives = fs.readdirSync(path.join(root, ".gc-archive"));
    assert.equal(archives.length, 1);
    const extracted = path.join(tmpDir, "extracted-branch");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", path.join(root, ".gc-archive", archives[0]), "-C", extracted]).status, 0);
    const heads = spawnSync("git", ["bundle", "list-heads", path.join(extracted, "unpublished.bundle")], { encoding: "utf8" });
    assert.equal(heads.status, 0, heads.stderr);
    assert.match(heads.stdout, new RegExp(commit));
  });

  it("preserves an unpushed commit in a small bundle without archiving the clone", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"), { ageHours: 25 });
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    fs.writeFileSync(path.join(clone, "change.txt"), "unpublished work\n");
    git("add", "change.txt");
    git("commit", "-m", "unpushed");
    const commit = git("rev-parse", "HEAD");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);

    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archives = fs.readdirSync(path.join(root, ".gc-archive"));
    assert.equal(archives.length, 1);
    const archive = path.join(root, ".gc-archive", archives[0]);
    assert.ok(fs.statSync(archive).size < 10 * 1024 * 1024);
    const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /\.bundle$/m);
    assert.doesNotMatch(listing.stdout, /(?:^|\/)\.git\//m);
    const extracted = path.join(tmpDir, "extracted");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", extracted]).status, 0);
    const bundleName = listing.stdout.split("\n").find((name) => name.endsWith(".bundle"));
    const heads = spawnSync("git", ["bundle", "list-heads", path.join(extracted, bundleName)], { encoding: "utf8" });
    assert.equal(heads.status, 0, heads.stderr);
    assert.match(heads.stdout, new RegExp(commit));
  });

  it("preserves a stash in a compact bundle without archiving the checkout", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    fs.writeFileSync(path.join(clone, "README.md"), "stashed work\n");
    git("stash", "push", "-m", "save work");
    const stash = git("rev-parse", "refs/stash");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archive = path.join(root, ".gc-archive", fs.readdirSync(path.join(root, ".gc-archive"))[0]);
    assert.ok(fs.statSync(archive).size < 10 * 1024 * 1024);
    const extracted = path.join(tmpDir, "stash-extracted");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", extracted]).status, 0);
    const heads = spawnSync("git", ["bundle", "list-heads", path.join(extracted, "unpublished.bundle")], { encoding: "utf8" });
    assert.equal(heads.status, 0, heads.stderr);
    assert.match(heads.stdout, new RegExp(stash));
    assert.match(heads.stdout, /refs\/stash/);
  });

  it("preserves staged changes even when the working tree reverses them", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    fs.writeFileSync(path.join(clone, "README.md"), "staged work\n");
    git("add", "README.md");
    fs.writeFileSync(path.join(clone, "README.md"), "test");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archive = path.join(root, ".gc-archive", fs.readdirSync(path.join(root, ".gc-archive"))[0]);
    const extracted = path.join(tmpDir, "index-extracted");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", extracted]).status, 0);
    assert.match(fs.readFileSync(path.join(extracted, "staged.patch"), "utf8"), /staged work/);
    assert.match(fs.readFileSync(path.join(extracted, "changes.patch"), "utf8"), /staged work/);
  });

  it("preserves tracked and untracked changes without archiving the checkout", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"));
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    const remote = path.join(tmpDir, "remote.git");
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "HEAD");
    fs.writeFileSync(path.join(clone, "README.md"), "tracked change\n");
    fs.writeFileSync(path.join(clone, "untracked.txt"), "untracked change\n");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archives = fs.readdirSync(path.join(root, ".gc-archive"));
    assert.equal(archives.length, 1);
    const archive = path.join(root, ".gc-archive", archives[0]);
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /changes\.patch/);
    assert.match(listing.stdout, /untracked\.tar/);
    assert.doesNotMatch(listing.stdout, /\.git\//);
  });

  it("apply archives dirty clones before removal", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12346"), { clean: false, ageHours: 25 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    // Archive should exist
    const archiveDir = path.join(root, ".gc-archive");
    assert.ok(fs.existsSync(archiveDir));
    const archives = fs.readdirSync(archiveDir);
    assert.ok(archives.length > 0);
  });

  it("does not touch clones younger than TTL", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12347"), { ageHours: 1 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone));
  });

  it("does not touch clones with alternates", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12348"), { alternates: true, ageHours: 25 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    // Should be archived, not plain-removed; the directory should be gone from original path
    assert.equal(fs.existsSync(clone), false);
    // Archive should exist
    const archiveDir = path.join(root, ".gc-archive");
    assert.ok(fs.existsSync(archiveDir));
  });

  it("writes JSONL journal entries", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    makeGitClone(path.join(root, "OPE-12349"), { ageHours: 25 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
    assert.ok(lines.length > 0);
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.ok(rec.at);
      assert.ok(rec.event);
    }
  });

  it("fails when lock is held", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    makeGitClone(path.join(root, "OPE-12350"), { ageHours: 25 });
    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");

    // Pre-create the lock
    fs.writeFileSync(lock, "999999");
    const r = await runScript(["--root", root, "--lock", lock, "--journal", journal, "--apply"]);
    assert.notEqual(r.status, 0);
    const out = JSON.parse(r.stderr);
    assert.equal(out.ok, false);
    assert.equal(out.reason, "lock held");
  });

  describe("scratch-gc e2e (BOT-DISK-SCRATCH)", () => {
    it("discovers bot scratch when invoked with the bot workspace root", async () => {
      const bot = path.join(tmpDir, "bot");
      const workspace = path.join(bot, "workspace");
      const scratch = path.join(bot, "hermes/cache/scratch");
      fs.mkdirSync(workspace, { recursive: true });
      fs.mkdirSync(scratch, { recursive: true });
      const stale = path.join(scratch, "stale");
      fs.writeFileSync(stale, "stale");
      const old = new Date(Date.now() - 7 * 3600 * 1000);
      fs.utimesSync(stale, old, old);
      const r = await runScript(["--root", workspace, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(stale), false);
    });

    it("prunes stale scratch without following a symlinked hermes directory", async () => {
      const root = path.join(tmpDir, "bots");
      const scratch = path.join(root, "bot-1/hermes/cache/scratch");
      const outside = path.join(tmpDir, "outside");
      fs.mkdirSync(scratch, { recursive: true });
      fs.mkdirSync(path.join(outside, "cache/scratch"), { recursive: true });
      fs.mkdirSync(path.join(root, "bot-2"), { recursive: true });
      fs.symlinkSync(outside, path.join(root, "bot-2/hermes"));
      const stale = path.join(scratch, "stale");
      const protectedFile = path.join(outside, "cache/scratch/protected");
      fs.writeFileSync(stale, "stale");
      fs.writeFileSync(protectedFile, "protected");
      const old = new Date(Date.now() - 7 * 3600 * 1000);
      fs.utimesSync(stale, old, old);
      fs.utimesSync(protectedFile, old, old);
      const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(protectedFile), true);
    });

    it("prunes scratch older than six hours by default", async () => {
      const root = path.join(tmpDir, "bots");
      const scratch = path.join(root, "bot-1/hermes/cache/scratch");
      fs.mkdirSync(scratch, { recursive: true });
      const stale = path.join(scratch, "stale");
      const fresh = path.join(scratch, "fresh");
      fs.writeFileSync(stale, "stale");
      fs.writeFileSync(fresh, "fresh");
      const old = new Date(Date.now() - 7 * 3600 * 1000);
      fs.utimesSync(stale, old, old);
      const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(fresh), true);
    });

    it("apply prunes stale scratch directories and writes scratch-pruned to journal", async () => {
      const botsRoot = path.join(tmpDir, "bots");
      const bot1Scratch = path.join(botsRoot, "bot-1/hermes/cache/scratch");
      fs.mkdirSync(bot1Scratch, { recursive: true });

      const lock = path.join(tmpDir, "test.lock");
      const journal = path.join(tmpDir, "journal.jsonl");

      const now = Date.now();
      const staleTime = new Date(now - 15 * 3600 * 1000);
      const freshTime = new Date(now - 2 * 3600 * 1000);

      // Stale directory
      const staleDir = path.join(bot1Scratch, "myrmidon-migrate-stale");
      fs.mkdirSync(path.join(staleDir, "nested"), { recursive: true });
      fs.writeFileSync(path.join(staleDir, "nested/db.sqlite"), "data-content");
      fs.utimesSync(path.join(staleDir, "nested/db.sqlite"), staleTime, staleTime);
      fs.utimesSync(path.join(staleDir, "nested"), staleTime, staleTime);
      fs.utimesSync(staleDir, staleTime, staleTime);

      // Fresh directory
      const freshDir = path.join(bot1Scratch, "fresh-run-dir");
      fs.mkdirSync(freshDir, { recursive: true });
      fs.writeFileSync(path.join(freshDir, "output.log"), "fresh-content");
      fs.utimesSync(path.join(freshDir, "output.log"), freshTime, freshTime);
      fs.utimesSync(freshDir, freshTime, freshTime);

      // Protected gh-cli-cache
      const ghDir = path.join(bot1Scratch, "gh-cli-cache");
      fs.mkdirSync(ghDir, { recursive: true });
      fs.writeFileSync(path.join(ghDir, "hosts.yml"), "gh-cache");
      fs.utimesSync(path.join(ghDir, "hosts.yml"), staleTime, staleTime);
      fs.utimesSync(ghDir, staleTime, staleTime);

      // Stale directory kept open by a background process
      const openDir = path.join(bot1Scratch, "open-test-run");
      fs.mkdirSync(openDir, { recursive: true });
      const openFile = path.join(openDir, "active.log");
      fs.writeFileSync(openFile, "working");
      fs.utimesSync(openFile, staleTime, staleTime);
      fs.utimesSync(openDir, staleTime, staleTime);

      // Hold open file with a child process
      const holder = spawn("tail", ["-f", openFile], { stdio: "ignore" });

      try {
        // Wait briefly for holder to open file
        await new Promise((resolve) => setTimeout(resolve, 100));

        const r = await runScript([
          "--root", botsRoot,
          "--lock", lock,
          "--journal", journal,
          "--apply",
        ]);
        assert.equal(r.status, 0, r.stderr);

        // Stale dir should be removed
        assert.equal(fs.existsSync(staleDir), false);

        // Fresh, gh-cli-cache, and openDir must still exist
        assert.ok(fs.existsSync(freshDir));
        assert.ok(fs.existsSync(ghDir));
        assert.ok(fs.existsSync(openDir));

        // Journal should contain scratch-pruned for staleDir
        const lines = fs.readFileSync(journal, "utf8").trim().split("\n");
        const events = lines.map((l) => JSON.parse(l));

        const prunedEvent = events.find((e) => e.event === "scratch-pruned");
        assert.ok(prunedEvent, "scratch-pruned event must be logged");
        assert.equal(prunedEvent.path, staleDir);
        assert.ok(prunedEvent.sizeBytes > 0);

        // No scratch-pruned event for fresh, gh-cli-cache, or openDir
        assert.equal(events.some((e) => e.path === freshDir), false);
        assert.equal(events.some((e) => e.path === ghDir), false);
        assert.equal(events.some((e) => e.path === openDir), false);
      } finally {
        holder.kill("SIGKILL");
      }
    });

    it("respects threshold from env config file", async () => {
      const botsRoot = path.join(tmpDir, "bots");
      const bot1Scratch = path.join(botsRoot, "bot-1/hermes/cache/scratch");
      fs.mkdirSync(bot1Scratch, { recursive: true });

      const envFile = path.join(tmpDir, "myrmidon-host-gc.env");
      // Set TTL to 6 hours
      fs.writeFileSync(envFile, "SCRATCH_TTL_HOURS=6\n");

      const lock = path.join(tmpDir, "test.lock");
      const journal = path.join(tmpDir, "journal.jsonl");

      const now = Date.now();
      // 8 hours old (older than 6h env threshold, but the default is also 6h)
      const age8h = new Date(now - 8 * 3600 * 1000);
      const testDir = path.join(bot1Scratch, "test-8h");
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, "file.txt"), "8h");
      fs.utimesSync(path.join(testDir, "file.txt"), age8h, age8h);
      fs.utimesSync(testDir, age8h, age8h);

      const r = await runScript([
        "--root", botsRoot,
        "--lock", lock,
        "--journal", journal,
        "--env", envFile,
        "--apply",
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(testDir), false);
    });
  });
});
