// myrmidon(1.6.7-BOT-DISK-HOST-GC): end-to-end tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.e2e.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { startGitDaemon } from "./git-daemon-fixture.mjs";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

let tmpDir;
let gitDaemon;
let boardServer;
let boardUrl;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-gc-e2e-"));
});

before(async () => {
  gitDaemon = await startGitDaemon();
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
  gitDaemon.stop();
  await new Promise((resolve) => boardServer.close(resolve));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, BOARD_API_URL: boardUrl, ...gitDaemon.env, ...env },
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

  it("reports archive bytes without following symlinks", async () => {
    const root = path.join(tmpDir, "root");
    const archives = path.join(root, ".gc-archive");
    fs.mkdirSync(archives, { recursive: true });
    fs.writeFileSync(path.join(archives, "OPE-1.tar.gz"), "12345");
    fs.writeFileSync(path.join(archives, "OPE-2.tar.zst"), "1234567");
    fs.symlinkSync(path.join(archives, "OPE-1.tar.gz"), path.join(archives, "OPE-3.tar.gz"));
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).plan.archiveBytes, 12);
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

  // Gives a clone a bare remote and pushes HEAD, so "pushed" is real.
  const pushToOwnRemote = (clone, name) => {
    const remote = path.join(tmpDir, `${name}.git`);
    assert.equal(spawnSync("git", ["init", "--bare", remote]).status, 0);
    for (const args of [["remote", "add", "origin", remote], ["push", "-u", "origin", "HEAD"]]) {
      const r = spawnSync("git", args, { cwd: clone, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
  };
  const readJournal = (file) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("archives the unpublished work of a nested repository next to the parent, then removes the clone", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12345"));
    // The parent ignores the nested repo: only the nested pass can save its work.
    fs.writeFileSync(path.join(clone, ".gitignore"), "nested/\n");
    spawnSync("git", ["add", ".gitignore"], { cwd: clone });
    spawnSync("git", ["commit", "-m", "ignore nested"], { cwd: clone });
    pushToOwnRemote(clone, "parent-remote");
    const nested = makeGitClone(path.join(clone, "nested"));
    fs.writeFileSync(path.join(nested, "wip.txt"), "uncommitted nested work");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const journal = path.join(tmpDir, "gc.jsonl");
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false, "clone removed after its nested work was archived");
    const archives = fs.readdirSync(path.join(root, ".gc-archive"));
    assert.equal(archives.length, 1);
    const extracted = path.join(tmpDir, "extracted-nested");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", path.join(root, ".gc-archive", archives[0]), "-C", extracted]).status, 0);
    const heads = spawnSync("git", ["bundle", "list-heads", path.join(extracted, "repos", "nested", "unpublished.bundle")], { encoding: "utf8" });
    assert.equal(heads.status, 0, heads.stderr);
    const untracked = spawnSync("tar", ["-tf", path.join(extracted, "repos", "nested", "untracked.tar")], { encoding: "utf8" });
    assert.match(untracked.stdout, /wip\.txt/);
    assert.ok(!fs.existsSync(path.join(extracted, "unpublished.bundle")), "the pushed parent adds no bundle");
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.repos.map((x) => x.path), ["nested"]);
    assert.ok(fs.statSync(path.join(root, ".gc-archive", archives[0])).size < 1_000_000, "compact archive");
    assert.ok(!readJournal(journal).some((e) => e.event === "archive-full-fallback"));
  });

  it("makes no archive when the clone and its nested repository are fully pushed", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = makeGitClone(path.join(root, "OPE-12347"));
    fs.writeFileSync(path.join(clone, ".gitignore"), "nested/\n");
    spawnSync("git", ["add", ".gitignore"], { cwd: clone });
    spawnSync("git", ["commit", "-m", "ignore nested"], { cwd: clone });
    pushToOwnRemote(clone, "all-parent");
    const nested = makeGitClone(path.join(clone, "nested"));
    pushToOwnRemote(nested, "all-nested");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(clone, old, old);
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false, "pushed clone removed");
    const archiveRoot = path.join(root, ".gc-archive");
    assert.ok(!fs.existsSync(archiveRoot) || fs.readdirSync(archiveRoot).length === 0, "nothing worth archiving");
  });

  it("under disk pressure the scratch TTL drops to one hour and the journal says so", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const journal = path.join(tmpDir, "gc.jsonl");
    const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", journal, "--pressure-percent", "0.1", "--critical-percent", "100", "--scratch-ttl", "6", "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    const events = readJournal(journal);
    const p = events.find((e) => e.event === "disk-pressure");
    assert.ok(p, "pressure journaled");
    assert.equal(p.scratchTtlHours, 1);
    assert.ok(!events.some((e) => e.event === "disk-critical"));
    const calm = path.join(tmpDir, "calm.jsonl");
    const r2 = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", calm, "--pressure-percent", "101", "--apply"]);
    assert.equal(r2.status, 0, r2.stderr);
    assert.ok(!readJournal(calm).some((e) => e.event === "disk-pressure"));
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
    // Alternates cannot be safely bundled here; retain the checkout rather than archive it whole.
    assert.ok(fs.existsSync(clone));
    const archiveDir = path.join(root, ".gc-archive");
    assert.ok(!fs.existsSync(archiveDir) || fs.readdirSync(archiveDir).length === 0);
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

  it("apply removes a done bot worktree whose .git names a container path, admin dir included", async () => {
    // Bot layout: <tmp>/agent/{workspace, hermes/.myrmidon/git-base/o/r.git}. In the container the
    // bot root is /bot, so the clone's `.git` and the admin dir's `gitdir` record /bot paths the
    // host cannot read: the closed scan must map them and free the clone plus its own admin dir.
    const agent = path.join(tmpDir, "agent");
    const workspace = path.join(agent, "workspace");
    const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const git = (args, cwd) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const server = path.join(tmpDir, "server.git");
    git(["init", "-q", "--bare", "-b", "main", server]);
    const seed = path.join(tmpDir, "seed");
    git(["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "one"], seed);
    git(["push", "-q", server, "main"], seed);
    git(["clone", "-q", "--bare", server, base]);
    const dir = path.join(workspace, "OPE-32100");
    git(["--git-dir", base, "worktree", "add", "-q", "-b", "task-OPE-32100", dir, "main"]);
    fs.writeFileSync(path.join(dir, "w.txt"), "work\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "work"], dir);
    git(["push", "-q", "origin", "task-OPE-32100:task-OPE-32100"], dir);
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/OPE-32100\n");
    fs.writeFileSync(path.join(base, "worktrees/OPE-32100/gitdir"), "/bot/workspace/OPE-32100/.git\n");
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const f of fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e))) fs.utimesSync(f, old, old);
    for (const f of ["HEAD", "index", path.join("logs", "HEAD")]) {
      try { fs.utimesSync(path.join(base, "worktrees/OPE-32100", f), old, old); } catch { /* absent */ }
    }
    fs.utimesSync(dir, old, old);

    const lock = path.join(tmpDir, "test.lock");
    const journal = path.join(tmpDir, "journal.jsonl");
    const r = await runScript(["--root", workspace, "--lock", lock, "--journal", journal, "--apply"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(dir), false, "clone removed");
    assert.equal(fs.existsSync(path.join(base, "worktrees", "OPE-32100")), false, "own admin dir removed");
    const rec = fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.event === "clone-removed");
    assert.ok(rec, "clone-removed journaled");
    assert.equal(rec.path, dir);
    assert.equal(rec.reason, "clean-pushed");
  });

  describe("archive of done bot worktrees with a container gitdir (OPE-14907 archive path)", () => {
    const git = (args, cwd) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    // <tmp>/agent/{workspace, hermes/.myrmidon/git-base/o/r.git}; in the container the bot root
    // is /bot, so the clone's `.git` and the admin dir's `gitdir` record /bot paths.
    const makeBot = () => {
      const agent = path.join(tmpDir, "agent");
      const workspace = path.join(agent, "workspace");
      const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      const server = path.join(tmpDir, "server.git");
      git(["init", "-q", "--bare", "-b", "main", server]);
      const seed = path.join(tmpDir, "seed");
      git(["init", "-q", "-b", "main", seed]);
      fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
      git(["add", "."], seed);
      git(["commit", "-q", "-m", "one"], seed);
      git(["push", "-q", server, "main"], seed);
      git(["clone", "-q", "--bare", server, base]);
      return { agent, workspace, base, server };
    };
    const addLinkedClone = (bot, name, { pushed = true, dirty = false, ageHours = 25 } = {}) => {
      const dir = path.join(bot.workspace, name);
      const branch = `task-${name}`;
      git(["--git-dir", bot.base, "worktree", "add", "-q", "-b", branch, dir, "main"]);
      fs.writeFileSync(path.join(dir, "w.txt"), "work\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", `work ${name}`], dir);
      if (pushed) git(["push", "-q", "origin", `${branch}:${branch}`], dir);
      if (dirty) fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
      fs.writeFileSync(path.join(dir, ".git"), `gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/${name}\n`);
      fs.writeFileSync(path.join(bot.base, "worktrees", name, "gitdir"), `/bot/workspace/${name}/.git\n`);
      const old = new Date(Date.now() - ageHours * 60 * 60 * 1000);
      for (const f of fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e))) fs.utimesSync(f, old, old);
      for (const f of ["HEAD", "index", path.join("logs", "HEAD")]) {
        try { fs.utimesSync(path.join(bot.base, "worktrees", name, f), old, old); } catch { /* absent */ }
      }
      fs.utimesSync(dir, old, old);
      return dir;
    };
    const apply = (root) => runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    const journalEvents = () => fs.readFileSync(path.join(tmpDir, "gc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const archives = (root) => {
      const dir = path.join(root, ".gc-archive");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".tar.gz")) : [];
    };
    const archiveMembers = (root, name) => {
      const r = spawnSync("tar", ["-tzf", path.join(root, ".gc-archive", name)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`tar -tzf: ${r.stderr}`);
      return r.stdout;
    };

    it("archives a dirty mapped worktree compactly, then removes the clone and its own admin dir", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-33001", { dirty: true });
      const admin = path.join(bot.base, "worktrees", "OPE-33001");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), false, "clone removed");
      assert.equal(fs.existsSync(admin), false, "own admin dir removed");
      const names = archives(bot.workspace);
      assert.equal(names.length, 1, `one archive expected: ${JSON.stringify(names)}`);
      const listing = archiveMembers(bot.workspace, names[0]);
      assert.ok(listing.includes("changes.patch"), `compact archive holds the dirty diff:\n${listing}`);
      const events = journalEvents();
      assert.ok(events.some((e) => e.event === "clone-archived" && e.path === dir), "clone-archived journaled");
      assert.ok(events.some((e) => e.event === "clone-removed-after-archive" && e.path === dir), "clone-removed-after-archive journaled");
    });

    it("archives the unpublished commits of an unpushed mapped worktree, then removes it and its admin dir", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-33002", { pushed: false });
      const admin = path.join(bot.base, "worktrees", "OPE-33002");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), false, "clone removed");
      assert.equal(fs.existsSync(admin), false, "own admin dir removed");
      const names = archives(bot.workspace);
      assert.equal(names.length, 1, `one archive expected: ${JSON.stringify(names)}`);
      const listing = archiveMembers(bot.workspace, names[0]);
      assert.ok(listing.includes("unpublished.bundle"), `compact archive holds the unpublished commits:\n${listing}`);
    });

    it("keeps a mapped worktree whose git-base borrows objects (alternates): no archive, no removal", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-33003");
      fs.mkdirSync(path.join(bot.base, "objects", "info"), { recursive: true });
      fs.writeFileSync(path.join(bot.base, "objects", "info", "alternates"), "/tmp/fake-alternates\n");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), true, "borrowed objects: the copy stays");
      assert.equal(archives(bot.workspace).length, 0, "nothing archived");
      assert.ok(journalEvents().some((e) => e.event === "clone-archive-failed" && /alternate-objects/.test(e.error)), "the alternates reason is journaled");
    });

    it("keeps a mapped worktree with a broken nested repository (fail closed)", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-33004");
      const nested = path.join(dir, "node_modules", "broken");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, ".git"), "gitdir: /nonexistent/elsewhere\n");
      fs.writeFileSync(path.join(nested, "n.txt"), "n\n");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), true, "unrecoverable nested repository: the copy stays");
      assert.equal(fs.existsSync(path.join(bot.base, "worktrees", "OPE-33004")), true, "admin dir stays with the copy");
    });

    it("still archives and removes an ordinary dirty clone, unchanged", async () => {
      const bot = makeBot();
      const dir = path.join(bot.workspace, "OPE-33005");
      git(["clone", "-q", bot.server, dir]);
      fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      fs.utimesSync(dir, old, old);
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), false, "clone removed");
      const names = archives(bot.workspace);
      assert.equal(names.length, 1, `one archive expected: ${JSON.stringify(names)}`);
      const listing = archiveMembers(bot.workspace, names[0]);
      assert.ok(listing.includes("changes.patch"), `compact archive holds the dirty diff:\n${listing}`);
    });
  });

  describe("archive of mapped worktrees that borrow objects (alternates)", () => {
    const git = (args, cwd) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const makeBot = () => {
      const agent = path.join(tmpDir, "agent");
      const workspace = path.join(agent, "workspace");
      const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      const server = path.join(tmpDir, "server.git");
      git(["init", "-q", "--bare", "-b", "main", server]);
      const seed = path.join(tmpDir, "seed");
      git(["init", "-q", "-b", "main", seed]);
      fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
      git(["add", "."], seed);
      git(["commit", "-q", "-m", "one"], seed);
      git(["push", "-q", server, "main"], seed);
      git(["clone", "-q", "--bare", server, base]);
      return { agent, workspace, base, server };
    };
    const addLinkedClone = (bot, name, { dirty = false, ageHours = 25 } = {}) => {
      const dir = path.join(bot.workspace, name);
      const branch = `task-${name}`;
      git(["--git-dir", bot.base, "worktree", "add", "-q", "-b", branch, dir, "main"]);
      fs.writeFileSync(path.join(dir, "w.txt"), "work\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", `work ${name}`], dir);
      if (dirty) fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
      fs.writeFileSync(path.join(dir, ".git"), `gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/${name}\n`);
      fs.writeFileSync(path.join(bot.base, "worktrees", name, "gitdir"), `/bot/workspace/${name}/.git\n`);
      const old = new Date(Date.now() - ageHours * 60 * 60 * 1000);
      for (const f of fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e))) fs.utimesSync(f, old, old);
      for (const f of ["HEAD", "index", path.join("logs", "HEAD")]) {
        try { fs.utimesSync(path.join(bot.base, "worktrees", name, f), old, old); } catch { /* absent */ }
      }
      fs.utimesSync(dir, old, old);
      return dir;
    };
    // The bot git-base borrows objects from the shared mirror, as on the bots volume.
    const borrow = (bot, target) => {
      fs.mkdirSync(path.join(bot.base, "objects", "info"), { recursive: true });
      fs.writeFileSync(path.join(bot.base, "objects", "info", "alternates"), `${target}\n`);
    };
    const apply = (root) => runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    const journalEvents = () => fs.readFileSync(path.join(tmpDir, "gc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const archives = (root) => {
      const dir = path.join(root, ".gc-archive");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".tar.gz")) : [];
    };
    const archiveMembers = (root, name) => {
      const r = spawnSync("tar", ["-tzf", path.join(root, ".gc-archive", name)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`tar -tzf: ${r.stderr}`);
      return r.stdout;
    };

    it("archives a dirty unpushed mapped worktree whose alternate object store is reachable", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-34001", { dirty: true });
      const admin = path.join(bot.base, "worktrees", "OPE-34001");
      const mirror = path.join(tmpDir, "mirror-objects");
      fs.mkdirSync(mirror, { recursive: true });
      borrow(bot, mirror);
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), false, "clone removed");
      assert.equal(fs.existsSync(admin), false, "own admin dir removed");
      const names = archives(bot.workspace);
      assert.equal(names.length, 1, `one archive expected: ${JSON.stringify(names)}`);
      const listing = archiveMembers(bot.workspace, names[0]);
      assert.ok(listing.includes("unpublished.bundle"), `the unpushed commit is bundled:\n${listing}`);
      assert.ok(listing.includes("changes.patch"), `the dirty diff is patched:\n${listing}`);
      assert.ok(journalEvents().some((e) => e.event === "clone-removed-after-archive" && e.path === dir), "clone-removed-after-archive journaled");
    });

    it("keeps a mapped worktree whose alternate object store is gone, copy and admin dir", async () => {
      const bot = makeBot();
      const dir = addLinkedClone(bot, "OPE-34002", { dirty: true });
      const admin = path.join(bot.base, "worktrees", "OPE-34002");
      borrow(bot, "/nonexistent/mirror-objects");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), true, "borrowed objects unreachable: the copy stays");
      assert.equal(fs.existsSync(admin), true, "the admin dir stays with the copy");
      assert.equal(archives(bot.workspace).length, 0, "nothing archived");
      assert.ok(journalEvents().some((e) => e.event === "clone-archive-failed" && /alternate/i.test(e.error)), "the alternates reason is journaled");
    });
  });

  describe("admin dirs whose commondir names a container path (OPE-14907)", () => {
    const git = (args, cwd) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    const makeBot = () => {
      const agent = path.join(tmpDir, "agent");
      const workspace = path.join(agent, "workspace");
      const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
      fs.mkdirSync(path.dirname(base), { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      const server = path.join(tmpDir, "server.git");
      git(["init", "-q", "--bare", "-b", "main", server]);
      const seed = path.join(tmpDir, "seed");
      git(["init", "-q", "-b", "main", seed]);
      fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
      git(["add", "."], seed);
      git(["commit", "-q", "-m", "one"], seed);
      git(["push", "-q", server, "main"], seed);
      git(["clone", "-q", "--bare", server, base]);
      return { agent, workspace, base, server };
    };
    // The bots volume records container paths everywhere: the clone .git file AND the admin
    // dir's commondir both name /bot, which does not exist on the host.
    const addMappedClone = (bot, name, { dirty = false, stashes = 0, ageHours = 25 } = {}) => {
      const dir = path.join(bot.workspace, name);
      const branch = `task-${name}`;
      git(["--git-dir", bot.base, "worktree", "add", "-q", "-b", branch, dir, "main"]);
      fs.writeFileSync(path.join(dir, "w.txt"), "work\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", `work ${name}`], dir);
      for (let i = 0; i < stashes; i += 1) {
        fs.writeFileSync(path.join(dir, `stash-${i}.txt`), `stash ${i}\n`);
        git(["add", `stash-${i}.txt`], dir);
        git(["stash", "-q", "--", `stash-${i}.txt`], dir);
      }
      if (dirty) fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
      fs.writeFileSync(path.join(dir, ".git"), `gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/${name}\n`);
      fs.writeFileSync(path.join(bot.base, "worktrees", name, "gitdir"), `/bot/workspace/${name}/.git\n`);
      fs.writeFileSync(path.join(bot.base, "worktrees", name, "commondir"), "/bot/hermes/.myrmidon/git-base/o/r.git\n");
      const old = new Date(Date.now() - ageHours * 60 * 60 * 1000);
      for (const f of fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e))) fs.utimesSync(f, old, old);
      for (const f of ["HEAD", "index", path.join("logs", "HEAD")]) {
        try { fs.utimesSync(path.join(bot.base, "worktrees", name, f), old, old); } catch { /* absent */ }
      }
      fs.utimesSync(dir, old, old);
      return dir;
    };
    const apply = (root) => runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
    const journalEvents = () => fs.readFileSync(path.join(tmpDir, "gc.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const archives = (root) => {
      const dir = path.join(root, ".gc-archive");
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(".tar.gz")) : [];
    };
    const archiveMembers = (root, name) => {
      const r = spawnSync("tar", ["-tzf", path.join(root, ".gc-archive", name)], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`tar -tzf: ${r.stderr}`);
      return r.stdout;
    };

    it("archives a dirty unpushed mapped worktree whose admin commondir names a container path", async () => {
      const bot = makeBot();
      const dir = addMappedClone(bot, "OPE-35001", { dirty: true });
      const admin = path.join(bot.base, "worktrees", "OPE-35001");
      const mirror = path.join(tmpDir, "mirror-objects");
      fs.mkdirSync(mirror, { recursive: true });
      fs.writeFileSync(path.join(bot.base, "objects", "info", "alternates"), `${mirror}\n`);
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), false, "clone removed");
      assert.equal(fs.existsSync(admin), false, "exactly its own admin dir removed");
      const names = archives(bot.workspace);
      assert.equal(names.length, 1, `one archive expected: ${JSON.stringify(names)}`);
      const listing = archiveMembers(bot.workspace, names[0]);
      assert.ok(listing.includes("unpublished.bundle"), `the bundle was created through the mapped common dir:\n${listing}`);
      assert.ok(listing.includes("changes.patch"), `the dirty diff is patched:\n${listing}`);
      assert.ok(journalEvents().some((e) => e.event === "clone-removed-after-archive" && e.path === dir), "clone-removed-after-archive journaled");
    });

    it("a kept clone (multiple stash guard) gets its container commondir content back byte-exact", async () => {
      const bot = makeBot();
      const dir = addMappedClone(bot, "OPE-35002", { stashes: 2 });
      const admin = path.join(bot.base, "worktrees", "OPE-35002");
      const commondirFile = path.join(admin, "commondir");
      const before = fs.readFileSync(commondirFile, "utf8");
      assert.equal(before, "/bot/hermes/.myrmidon/git-base/o/r.git\n");
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), true, "multiple stash entries keep the copy");
      assert.equal(fs.readFileSync(commondirFile, "utf8"), before, "commondir restored byte-exact after the process exited");
      assert.equal(fs.lstatSync(commondirFile).isFile(), true, "commondir is still a regular file");
      assert.ok(journalEvents().some((e) => e.event === "clone-archive-failed" && /multiple stash entries/.test(e.error)), "the stash guard is journaled");
    });

    it("a symlinked commondir is never followed or rewritten; the target and the clone stay untouched", async () => {
      const bot = makeBot();
      const dir = addMappedClone(bot, "OPE-35003");
      const admin = path.join(bot.base, "worktrees", "OPE-35003");
      const commondirFile = path.join(admin, "commondir");
      const outside = path.join(tmpDir, "outside-commondir");
      fs.writeFileSync(outside, "/bot/hermes/.myrmidon/git-base/o/r.git\n");
      fs.rmSync(commondirFile);
      fs.symlinkSync(outside, commondirFile);
      const r = await apply(bot.workspace);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(dir), true, "the clone stays: the repair refused the symlink and git failed closed");
      assert.equal(fs.readFileSync(outside, "utf8"), "/bot/hermes/.myrmidon/git-base/o/r.git\n", "the symlink target is unchanged");
      assert.ok(fs.lstatSync(commondirFile).isSymbolicLink(), "commondir is still the bot's symlink");
    });
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
    it("retains an old scratch checkout with unpublished work", async () => {
      const root = path.join(tmpDir, "bots");
      const scratch = path.join(root, "bot-1/hermes/cache/scratch");
      fs.mkdirSync(scratch, { recursive: true });
      const clone = makeGitClone(path.join(scratch, "repo"));
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
      const ageTree = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) ageTree(child);
          else if (!entry.isSymbolicLink()) fs.utimesSync(child, old, old);
        }
        fs.utimesSync(dir, old, old);
      };
      ageTree(clone);
      const r = await runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(fs.existsSync(path.join(clone, ".git")), "scratch checkout must not be deleted as disposable data");
    });

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

// myrmidon(OPE-13218): the compact archive must bring the work back, not merely exist.
describe("host-clone-cache-gc compact archive recovery (OPE-13218)", () => {
  const gitIn = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const readJournal = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const age = (dir) => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
  };
  // A task clone on branch main, pushed to its own bare remote.
  const makeTask = (root, name, extraFiles = {}) => {
    const clone = path.join(root, name);
    fs.mkdirSync(clone, { recursive: true });
    gitIn(clone, "init", "-q", "-b", "main");
    gitIn(clone, "config", "user.email", "t@t");
    gitIn(clone, "config", "user.name", "t");
    fs.writeFileSync(path.join(clone, "a.txt"), "a\n");
    fs.writeFileSync(path.join(clone, "b.txt"), "b\n");
    fs.writeFileSync(path.join(clone, ".gitignore"), "ignored.log\nnode_modules/\ndeep/\n");
    for (const [file, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(clone, file), content);
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "init");
    const remote = path.join(tmpDir, `${name}.git`);
    assert.equal(spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]).status, 0);
    gitIn(clone, "remote", "add", "origin", remote);
    gitIn(clone, "push", "-q", "-u", "origin", "main");
    return { clone, remote };
  };
  const gc = (root, env = {}) => runScript(["--root", root, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--apply"], env);
  const journal = () => readJournal(path.join(tmpDir, "gc.jsonl"));
  const onlyArchive = (root) => {
    const dir = path.join(root, ".gc-archive");
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith(".")) : [];
    assert.equal(names.length, 1, `one archive expected, got ${JSON.stringify(names)}`);
    return path.join(dir, names[0]);
  };
  // Every file below `dir` outside .git, keyed by its name as bytes (latin1) -> content.
  const snapshot = (dir) => {
    const out = new Map();
    const walk = (d, rel) => {
      for (const name of fs.readdirSync(d, { encoding: "buffer" })) {
        const label = name.toString("latin1");
        if (label === ".git" || label === "ignored.log") continue;
        const full = Buffer.concat([d, Buffer.from("/"), name]);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) walk(full, `${rel}${label}/`);
        else out.set(`${rel}${label}`, fs.readFileSync(full).toString("hex"));
      }
    };
    walk(Buffer.from(dir), "");
    return out;
  };
  // Restores what the archive holds onto a fresh clone of the upstream: verify and fetch the
  // bundle, apply both patches, unpack the untracked files.
  const restore = (archive, remote) => {
    const extracted = path.join(tmpDir, "extracted");
    fs.mkdirSync(extracted, { recursive: true });
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", extracted]).status, 0);
    const restored = path.join(tmpDir, "restored");
    assert.equal(spawnSync("git", ["clone", "-q", remote, restored]).status, 0);
    gitIn(restored, "config", "user.email", "t@t");
    gitIn(restored, "config", "user.name", "t");
    const bundle = path.join(extracted, "unpublished.bundle");
    if (fs.existsSync(bundle)) {
      gitIn(restored, "bundle", "verify", bundle);
      let head = null;
      for (const line of gitIn(restored, "bundle", "list-heads", bundle).split("\n")) {
        const [sha, ref] = line.split(" ");
        gitIn(restored, "fetch", "-q", bundle, `+${ref}:refs/recovered/${ref.replace(/^refs\//, "")}`);
        if (ref === "HEAD") head = sha;
      }
      if (head) gitIn(restored, "checkout", "-q", "--detach", head);
    }
    if (fs.existsSync(path.join(extracted, "staged.patch"))) gitIn(restored, "apply", "--index", path.join(extracted, "staged.patch"));
    if (fs.existsSync(path.join(extracted, "changes.patch"))) gitIn(restored, "apply", path.join(extracted, "changes.patch"));
    if (fs.existsSync(path.join(extracted, "untracked.tar"))) assert.equal(spawnSync("tar", ["-xf", path.join(extracted, "untracked.tar"), "-C", restored]).status, 0);
    return { restored, extracted };
  };
  // Fake `git` that fails (or hangs) for chosen subcommands and passes every other call through.
  const gitShim = (subcommand, body) => {
    const bin = path.join(tmpDir, "shim-bin");
    fs.mkdirSync(bin, { recursive: true });
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${subcommand}" ]; then ${body}; fi\ndone\nexec ${real} "$@"\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env.PATH}` };
  };

  it("restores unpushed commits, staged and unstaged changes and untracked files to an identical tree", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20001");
    gitIn(clone, "checkout", "-q", "-b", "work");
    fs.writeFileSync(path.join(clone, "committed.txt"), "unpushed commit\n");
    gitIn(clone, "add", "committed.txt");
    gitIn(clone, "commit", "-q", "-m", "unpushed");
    fs.writeFileSync(path.join(clone, "a.txt"), "a\nstaged\n");
    gitIn(clone, "add", "a.txt");
    fs.writeFileSync(path.join(clone, "a.txt"), "a\nstaged\nworking\n");
    fs.writeFileSync(path.join(clone, "b.txt"), "b\nunstaged only\n");
    fs.mkdirSync(path.join(clone, "new", "dir"), { recursive: true });
    fs.writeFileSync(path.join(clone, "new", "dir", "u.txt"), "untracked\n");
    fs.writeFileSync(path.join(clone, "blob.dat"), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
    fs.writeFileSync(path.join(clone, "ignored.log"), "not archived\n");
    const before = snapshot(clone);
    const statusBefore = gitIn(clone, "status", "--porcelain");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archive = onlyArchive(root);
    assert.ok(fs.statSync(archive).size < 1_000_000, "compact archive");
    assert.ok(!spawnSync("tar", ["-tf", archive], { encoding: "utf8" }).stdout.includes("ignored.log"), "ignored files are not archived");
    const { restored } = restore(archive, remote);
    assert.deepEqual([...snapshot(restored)], [...before]);
    assert.equal(gitIn(restored, "status", "--porcelain"), statusBefore);
    assert.equal(gitIn(restored, "log", "-1", "--format=%s"), "unpushed");
  });

  it("keeps non-UTF-8 content and names byte for byte (D3)", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20002", { "latin.txt": Buffer.from("caf\xe9\n", "latin1") });
    fs.writeFileSync(path.join(clone, "latin.txt"), Buffer.from("caf\xe9 \xff\xfe\n", "latin1"));
    gitIn(clone, "add", "latin.txt");
    fs.writeFileSync(path.join(clone, "latin.txt"), Buffer.from("caf\xe9 \xff\xfe\nmore \xe9\n", "latin1"));
    fs.writeFileSync(Buffer.concat([Buffer.from(clone + "/"), Buffer.from([0x62, 0x61, 0x64, 0xe9, 0x2e, 0x74, 0x78, 0x74])]), Buffer.from([0xe9, 0xff, 0x0a]));
    const before = snapshot(clone);
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const { restored, extracted } = restore(onlyArchive(root), remote);
    const patch = fs.readFileSync(path.join(extracted, "changes.patch"));
    assert.ok(patch.includes(Buffer.from([0xe9])), "patch holds the raw byte");
    assert.ok(!patch.includes(Buffer.from([0xef, 0xbf, 0xbd])), "no U+FFFD replacement");
    assert.deepEqual([...snapshot(restored)], [...before]);
  });

  it("does not trust a stale tracking ref: a branch deleted on the server is bundled (D1)", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20003");
    gitIn(clone, "checkout", "-q", "-b", "feature");
    fs.writeFileSync(path.join(clone, "f.txt"), "feature work\n");
    gitIn(clone, "add", "f.txt");
    gitIn(clone, "commit", "-q", "-m", "feature commit");
    gitIn(clone, "push", "-q", "-u", "origin", "feature");
    const sha = gitIn(clone, "rev-parse", "HEAD");
    // The server loses the branch; the clone still has refs/remotes/origin/feature.
    gitIn(remote, "branch", "-q", "-D", "feature");
    assert.equal(gitIn(clone, "rev-parse", "refs/remotes/origin/feature"), sha);
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const { restored } = restore(onlyArchive(root), remote);
    assert.equal(gitIn(restored, "rev-parse", "HEAD"), sha);
  });

  it("an unreachable server is not 'pushed': the whole history is bundled, never dropped (D1)", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20004");
    const sha = gitIn(clone, "rev-parse", "HEAD");
    fs.renameSync(remote, `${remote}.gone`);
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const archive = onlyArchive(root);
    const extracted = path.join(tmpDir, "ex");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", extracted]).status, 0);
    const heads = gitIn(extracted, "bundle", "list-heads", path.join(extracted, "unpublished.bundle"));
    assert.match(heads, new RegExp(sha));
    assert.ok(journal().some((e) => e.event === "remote-unverified"));
  });

  it("bundles a commit on a detached HEAD", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20005");
    gitIn(clone, "checkout", "-q", "--detach");
    fs.writeFileSync(path.join(clone, "d.txt"), "detached work\n");
    gitIn(clone, "add", "d.txt");
    gitIn(clone, "commit", "-q", "-m", "detached");
    const sha = gitIn(clone, "rev-parse", "HEAD");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const { restored } = restore(onlyArchive(root), remote);
    assert.equal(gitIn(restored, "rev-parse", "HEAD"), sha);
  });

  it("bundles a branch that has no upstream", async () => {
    const root = path.join(tmpDir, "root");
    const { clone, remote } = makeTask(root, "OPE-20006");
    gitIn(clone, "checkout", "-q", "-b", "local-only");
    fs.writeFileSync(path.join(clone, "l.txt"), "local only\n");
    gitIn(clone, "add", "l.txt");
    gitIn(clone, "commit", "-q", "-m", "local only");
    const sha = gitIn(clone, "rev-parse", "HEAD");
    gitIn(clone, "checkout", "-q", "main");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const { restored, extracted } = restore(onlyArchive(root), remote);
    assert.match(gitIn(restored, "bundle", "list-heads", path.join(extracted, "unpublished.bundle")), new RegExp(`${sha} refs/heads/local-only`));
  });

  it("finds a nested repository deeper than 3 levels and inside node_modules (D2)", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20007");
    const makeNested = (dir, file) => {
      fs.mkdirSync(dir, { recursive: true });
      gitIn(dir, "init", "-q", "-b", "main");
      gitIn(dir, "config", "user.email", "t@t");
      gitIn(dir, "config", "user.name", "t");
      fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
      gitIn(dir, "add", "-A");
      gitIn(dir, "commit", "-q", "-m", "seed");
      fs.writeFileSync(path.join(dir, file), "unsaved nested work\n");
    };
    makeNested(path.join(clone, "deep", "a", "b", "c", "d", "inner"), "deep-wip.txt");
    makeNested(path.join(clone, "node_modules", "pkg"), "nm-wip.txt");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const extracted = path.join(tmpDir, "ex");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", onlyArchive(root), "-C", extracted]).status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(extracted, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.repos.map((x) => x.path).sort(), ["deep/a/b/c/d/inner", "node_modules/pkg"]);
    assert.match(spawnSync("tar", ["-tf", path.join(extracted, "repos", "deep/a/b/c/d/inner", "untracked.tar")], { encoding: "utf8" }).stdout, /deep-wip\.txt/);
    assert.match(spawnSync("tar", ["-tf", path.join(extracted, "repos", "node_modules/pkg", "untracked.tar")], { encoding: "utf8" }).stdout, /nm-wip\.txt/);
  });

  it("keeps the copy when a broken repository sits in a skipped directory (D2)", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20008");
    fs.mkdirSync(path.join(clone, "node_modules", "broken", ".git"), { recursive: true });
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone), "copy stays");
    assert.ok(journal().some((e) => e.event === "clone-archive-failed" && /skipped directory/.test(e.error)));
  });

  it("falls back to the full archive for a broken repository outside skipped directories", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20009");
    fs.mkdirSync(path.join(clone, "vendor", "x", ".git"), { recursive: true });
    fs.writeFileSync(path.join(clone, "vendor", "x", "keep.txt"), "kept by the full archive\n");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const fallback = journal().find((e) => e.event === "archive-full-fallback");
    assert.ok(fallback, "archive-full-fallback journaled");
    assert.match(fallback.reason, /unusable-repository/);
    assert.match(spawnSync("tar", ["-tf", onlyArchive(root)], { encoding: "utf8" }).stdout, /vendor\/x\/keep\.txt/);
  });

  it("a compact step that hangs past the timeout leaves the copy in place and no partial archive", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20010");
    gitIn(clone, "checkout", "-q", "-b", "work");
    fs.writeFileSync(path.join(clone, "w.txt"), "w\n");
    gitIn(clone, "add", "w.txt");
    gitIn(clone, "commit", "-q", "-m", "w");
    age(clone);

    const r = await gc(root, { ...gitShim("bundle", "exec sleep 60"), HOST_GC_ARCHIVE_TIMEOUT_SECONDS: "1" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone), "copy stays");
    const failed = journal().find((e) => e.event === "clone-archive-failed");
    assert.ok(failed && /timed out/.test(failed.error), JSON.stringify(failed));
    const dir = path.join(root, ".gc-archive");
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  it("a failing compact step (diff) leaves the copy in place", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20011");
    fs.writeFileSync(path.join(clone, "a.txt"), "changed\n");
    age(clone);

    const r = await gc(root, gitShim("diff", "exit 3"));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone), "copy stays");
    assert.ok(journal().some((e) => e.event === "clone-archive-failed" && /diff failed/.test(e.error)));
    assert.ok(!journal().some((e) => e.event === "clone-removed"));
  });

  it("keeps the copy when the full archive would leave out a repository with unpushed work in node_modules", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20013");
    // A broken repository outside skipped directories forces the full archive ...
    fs.mkdirSync(path.join(clone, "vendor", "x", ".git"), { recursive: true });
    // ... which leaves node_modules out, and a healthy repository with an unpushed commit lives there.
    const pkg = path.join(clone, "node_modules", "pkg");
    fs.mkdirSync(pkg, { recursive: true });
    gitIn(pkg, "init", "-q", "-b", "main");
    gitIn(pkg, "config", "user.email", "t@t");
    gitIn(pkg, "config", "user.name", "t");
    fs.writeFileSync(path.join(pkg, "work.txt"), "only here\n");
    gitIn(pkg, "add", "-A");
    gitIn(pkg, "commit", "-q", "-m", "unpushed in node_modules");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(pkg, "work.txt")), "copy and its work stay");
    assert.ok(journal().some((e) => e.event === "clone-archive-failed" && /skipped directory/.test(e.error)));
    assert.ok(!journal().some((e) => e.event === "clone-removed" || e.event === "clone-removed-after-archive"));
  });

  it("under --apply a local-path remote is no server even with the test hook set: the history is bundled", async () => {
    const root = path.join(tmpDir, "root");
    const { clone } = makeTask(root, "OPE-20014");
    const sha = gitIn(clone, "rev-parse", "HEAD");
    age(clone);

    const r = await gc(root, { GIT_CONFIG_COUNT: "0", HOST_GC_TEST_ALLOW_LOCAL_REMOTES: "1", NODE_TEST_CONTEXT: "child-v8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(clone), false);
    const extracted = path.join(tmpDir, "ex");
    fs.mkdirSync(extracted);
    assert.equal(spawnSync("tar", ["-xf", onlyArchive(root), "-C", extracted]).status, 0);
    assert.match(gitIn(extracted, "bundle", "list-heads", path.join(extracted, "unpublished.bundle")), new RegExp(sha));
    assert.ok(journal().some((e) => e.event === "remote-unverified" && /local path/.test(e.reason)));
    assert.ok(journal().some((e) => e.event === "test-hook-ignored" && e.level === "warn"), "warn journaled");
  });

  it("asks the server once for many copies of one origin", async () => {
    const root = path.join(tmpDir, "root");
    const first = makeTask(root, "OPE-20015");
    age(first.clone);
    for (const name of ["OPE-20016", "OPE-20017", "OPE-20018"]) {
      const dir = path.join(root, name);
      assert.equal(spawnSync("git", ["clone", "-q", first.remote, dir]).status, 0);
      age(dir);
    }
    const log = path.join(tmpDir, "lsremote.log");
    const r = await gc(root, gitShim("ls-remote", `echo hit >> ${log}`));
    assert.equal(r.status, 0, r.stderr);
    for (const name of ["OPE-20015", "OPE-20016", "OPE-20017", "OPE-20018"]) assert.equal(fs.existsSync(path.join(root, name)), false, `${name} removed`);
    assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "one ls-remote for four copies");
  });

  it("checks alternates in the real gitdir when .git is a file", async () => {
    const root = path.join(tmpDir, "root");
    fs.mkdirSync(root);
    const clone = path.join(root, "OPE-20012");
    const gitdir = path.join(tmpDir, "separate-gitdir");
    fs.mkdirSync(clone);
    gitIn(clone, "init", "-q", "-b", "main", `--separate-git-dir=${gitdir}`);
    gitIn(clone, "config", "user.email", "t@t");
    gitIn(clone, "config", "user.name", "t");
    fs.writeFileSync(path.join(clone, "a.txt"), "a\n");
    gitIn(clone, "add", "-A");
    gitIn(clone, "commit", "-q", "-m", "init");
    assert.ok(fs.statSync(path.join(clone, ".git")).isFile());
    fs.mkdirSync(path.join(gitdir, "objects", "info"), { recursive: true });
    fs.writeFileSync(path.join(gitdir, "objects", "info", "alternates"), "/nonexistent/objects\n");
    age(clone);

    const r = await gc(root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(clone), "borrowed objects: the copy stays");
  });
});
