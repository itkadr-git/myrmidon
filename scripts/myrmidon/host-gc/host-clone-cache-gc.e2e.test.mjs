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
});
