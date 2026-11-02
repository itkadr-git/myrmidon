// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const { parseArgs, acquireLock, journalRecord, safeJoin, atomicDrop } = await import(
  path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs")
);

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-gc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("defaults to dry-run with standard paths", () => {
    const args = parseArgs(["node", "script.mjs"]);
    assert.equal(args.dryRun, true);
    assert.equal(args.journal, "/var/log/myrmidon-host-gc.jsonl");
    assert.equal(args.lock, "/var/run/myrmidon-host-gc.lock");
    assert.equal(args.cloneTtlHours, 24);
    assert.equal(args.cacheTtlHours, 72);
  });

  it("--apply switches to apply mode", () => {
    const args = parseArgs(["node", "script.mjs", "--apply"]);
    assert.equal(args.dryRun, false);
  });

  it("overrides root, journal, lock, and TTLs", () => {
    const args = parseArgs([
      "node", "script.mjs",
      "--root", "/tmp/test-root",
      "--journal", "/tmp/test-journal.jsonl",
      "--lock", "/tmp/test.lock",
      "--clone-ttl", "48",
      "--cache-ttl", "96",
    ]);
    assert.equal(args.root, "/tmp/test-root");
    assert.equal(args.journal, "/tmp/test-journal.jsonl");
    assert.equal(args.lock, "/tmp/test.lock");
    assert.equal(args.cloneTtlHours, 48);
    assert.equal(args.cacheTtlHours, 96);
  });
});

describe("acquireLock", () => {
  it("acquires and releases a lock", () => {
    const lockPath = path.join(tmpDir, "test.lock");
    const lock = acquireLock(lockPath);
    assert.equal(lock.ok, true);
    lock.release();
    assert.equal(fs.existsSync(lockPath), false);
  });

  it("fails when lock is already held", () => {
    const lockPath = path.join(tmpDir, "test.lock");
    const lock1 = acquireLock(lockPath);
    assert.equal(lock1.ok, true);
    const lock2 = acquireLock(lockPath);
    assert.equal(lock2.ok, false);
    assert.equal(lock2.reason, "lock held");
    lock1.release();
  });
});

describe("journalRecord", () => {
  it("appends JSONL records", () => {
    const journalPath = path.join(tmpDir, "journal.jsonl");
    journalRecord(journalPath, { event: "test-1", data: 123 });
    journalRecord(journalPath, { event: "test-2", data: 456 });
    const lines = fs.readFileSync(journalPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    assert.equal(r1.event, "test-1");
    assert.equal(r1.data, 123);
    assert.equal(r2.event, "test-2");
    assert.equal(r2.data, 456);
    assert.ok(r1.at); // ISO timestamp
  });
});

describe("safeJoin", () => {
  it("joins safely inside root", () => {
    const p = safeJoin("/tmp/root", "subdir");
    assert.equal(p, "/tmp/root/subdir");
  });

  it("rejects path traversal", () => {
    assert.throws(() => safeJoin("/tmp/root", "../escape"), /unsafe path/);
  });
});

describe("atomicDrop", () => {
  it("removes a file atomically", () => {
    const file = path.join(tmpDir, "test-file.txt");
    fs.writeFileSync(file, "hello");
    atomicDrop(file, tmpDir);
    assert.equal(fs.existsSync(file), false);
  });

  it("removes a directory atomically", () => {
    const dir = path.join(tmpDir, "test-dir");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "inner.txt"), "data");
    atomicDrop(dir, tmpDir);
    assert.equal(fs.existsSync(dir), false);
  });

  it("refuses to drop outside root", () => {
    const outside = path.join(os.tmpdir(), "outside-test.txt");
    fs.writeFileSync(outside, "x");
    assert.throws(() => atomicDrop(outside, tmpDir), /escapes root/);
    fs.unlinkSync(outside);
  });

  it("refuses to drop a symlink", () => {
    const target = path.join(tmpDir, "target.txt");
    const link = path.join(tmpDir, "link.txt");
    fs.writeFileSync(target, "x");
    fs.symlinkSync(target, link);
    assert.throws(() => atomicDrop(link, tmpDir), /symlink/);
  });
});
