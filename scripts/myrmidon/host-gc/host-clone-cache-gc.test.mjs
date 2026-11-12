// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import subprocess from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const { parseArgs, acquireLock, journalRecord, safeJoin, atomicDrop, fetchIssueStatus, filterClosedTaskClones, scanSshRunCopies, pruneSshRunCopies, UsageError } = await import(
  path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs")
);

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "host-gc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("board status guard", () => {
  const response = (status, body = { status }) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  for (const status of ["done", "cancelled"]) {
    it(`accepts ${status}`, async () => {
      const result = await fetchIssueStatus("OPE-1", {
        baseUrl: "http://board",
        fetchImpl: async (url) => {
          assert.equal(url, "http://board/api/issues/OPE-1");
          return response(200, { status });
        },
      });
      assert.deepEqual(result, { ok: true, status });
    });
  }

  for (const status of ["in_progress", "blocked", "todo"]) {
    it(`skips ${status} as issue-status`, async () => {
      const result = await filterClosedTaskClones([{ name: "OPE-1@agent", path: "/x" }], {
        baseUrl: "http://board",
        fetchImpl: async () => response(200, { status }),
      });
      assert.equal(result.candidates.length, 0);
      assert.equal(result.skipped[0].reason, "issue-status");
    });
  }

  it("fails closed when the board is unavailable", async () => {
    const result = await filterClosedTaskClones([{ name: "OPE-1", path: "/x" }], {
      baseUrl: "http://board",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.skipped[0].reason, "board-unavailable");
  });

  it("normalizes baseUrl with /api without duplication", async () => {
    await fetchIssueStatus("OPE-1", {
      baseUrl: "http://board/api",
      fetchImpl: async (url) => {
        assert.equal(url, "http://board/api/issues/OPE-1");
        return response(200, { status: "done" });
      },
    });
  });

  it("falls back to PAPERCLIP_API_URL or default when baseUrl is unset", async () => {
    const oldPaperclip = process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_API_URL = "http://paperclip-env";
    try {
      await fetchIssueStatus("OPE-1", {
        baseUrl: undefined,
        fetchImpl: async (url) => {
          assert.equal(url, "http://paperclip-env/api/issues/OPE-1");
          return response(200, { status: "done" });
        },
      });
    } finally {
      if (oldPaperclip !== undefined) process.env.PAPERCLIP_API_URL = oldPaperclip;
      else delete process.env.PAPERCLIP_API_URL;
    }
  });
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

// myrmidon(1.6.8 OPE-12722): SSH runner run copies older than the run timeout are pruned.
describe("SSH runner run copies", () => {
  const HOUR = 60 * 60 * 1000;
  function makeRun(runnersRoot, runner, runId, ageHours) {
    const dir = path.join(runnersRoot, runner, "workspace", ".paperclip-runtime", "runs", runId);
    fs.mkdirSync(path.join(dir, "workspace"), { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace", "file.txt"), "x");
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(dir, t, t);
    return dir;
  }

  it("marks copies older than the TTL and keeps fresh ones", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeRun(runners, "eng17", "run-old", 6);
    const fresh = makeRun(runners, "eng17", "run-fresh", 1);
    fs.mkdirSync(path.join(runners, "eng22", "workspace"), { recursive: true }); // no runs dir yet
    const items = scanSshRunCopies(runners, Date.now(), 4);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i.reason]));
    assert.equal(byPath[old], "ttl");
    assert.equal(byPath[fresh], "fresh");
    assert.equal(items.length, 2);
  });

  it("skips a runner whose path goes through a symlink", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const outside = path.join(tmpDir, "outside");
    makeRun(outside, "victim", "run-old", 6);
    fs.mkdirSync(runners, { recursive: true });
    fs.symlinkSync(path.join(outside, "victim"), path.join(runners, "eng8"));
    assert.deepEqual(scanSshRunCopies(runners, Date.now(), 4), []);
  });

  it("returns nothing for a missing root", () => {
    assert.deepEqual(scanSshRunCopies(path.join(tmpDir, "nope"), Date.now(), 4), []);
  });

  it("parses --runner-root (repeatable), HOST_GC_RUNNER_ROOTS and --run-copy-ttl", () => {
    const prev = process.env.HOST_GC_RUNNER_ROOTS;
    process.env.HOST_GC_RUNNER_ROOTS = "/a:/b";
    try {
      const args = parseArgs(["node", "gc", "--env", "/nonexistent", "--runner-root", "/c", "--run-copy-ttl", "6"]);
      assert.deepEqual(args.runnerRoots, ["/a", "/b", "/c"]);
      assert.equal(args.runCopyTtlHours, 6);
    } finally {
      if (prev === undefined) delete process.env.HOST_GC_RUNNER_ROOTS;
      else process.env.HOST_GC_RUNNER_ROOTS = prev;
    }
    const plain = parseArgs(["node", "gc", "--env", "/nonexistent"]);
    assert.deepEqual(plain.runnerRoots, []);
    assert.equal(plain.runCopyTtlHours, 4);
  });

  const GC_SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

  // Runs the CLI against an empty bots root; returns the process result and the parsed journal.
  function runGc(flags) {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc.jsonl");
    const env = { ...process.env, HOST_GC_RUNNER_ROOTS: "", PATH: process.env.PATH, PAPERCLIP_API_URL: "http://127.0.0.1:9" };
    const res = subprocess.spawnSync(process.execPath, [
      GC_SCRIPT, "--env", "/nonexistent", "--root", botsRoot,
      "--journal", journal, "--lock", path.join(tmpDir, "gc.lock"), "--proc-dir", path.join(tmpDir, "proc"),
      ...flags,
    ], { encoding: "utf8", env, timeout: 60_000 });
    const events = fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
    return { res, events };
  }

  it("--apply removes old run copies, keeps fresh ones and journals each removal", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeRun(runners, "eng17", "run-old", 6);
    const fresh = makeRun(runners, "eng21", "run-fresh", 1);
    const { res, events } = runGc(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(old), false, "old run copy must be removed");
    assert.equal(fs.existsSync(fresh), true, "fresh run copy must stay");
    const removed = events.find((e) => e.event === "run-copy-removed" && e.path === old && e.runner === "eng17");
    assert.ok(removed, "removal journaled");
    assert.equal(typeof removed.sizeBytes, "number", "size measured before the removal");
    assert.ok(removed.sizeBytes > 0);
    const done = events.find((e) => e.event === "apply-complete");
    assert.equal(done.runCopiesRemoved, 1);
    assert.equal(JSON.parse(res.stdout).runCopiesRemoved, 1);
  });

  it("dry-run removes nothing, journals no removal and lists fresh copies as kept", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeRun(runners, "eng17", "run-old", 6);
    const fresh = makeRun(runners, "eng21", "run-fresh", 1);
    const { res, events } = runGc(["--dry-run", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(old), true, "dry-run must not remove");
    assert.equal(fs.existsSync(fresh), true);
    assert.equal(events.some((e) => e.event === "run-copy-removed" || e.event === "run-copy-remove-failed"), false);
    assert.equal(events.find((e) => e.event === "dry-run").runCopies, 1);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.plan.runCopies.map((r) => [r.path, r.action]), [[old, "remove"]]);
    const keptFresh = out.plan.kept.filter((k) => k.path === fresh);
    assert.equal(keptFresh.length, 1);
    assert.equal(keptFresh[0].reason, "fresh");
    assert.equal(keptFresh[0].action, "keep");
  });

  it("a runner whose workspace is swapped for a symlink after the scan is not deleted through", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeRun(runners, "eng17", "run-old", 6);
    const items = scanSshRunCopies(runners, Date.now(), 4).filter((i) => i.reason === "ttl");
    assert.equal(items.length, 1);
    assert.equal(items[0].runnersRoot, runners, "the item carries the root the drop is guarded against");

    // A copy of the same layout outside the runner root, and the swap between scan and apply.
    const outsideCopy = makeRun(path.join(tmpDir, "outside"), "victim", "run-old", 6);
    fs.renameSync(path.join(runners, "eng17", "workspace"), path.join(tmpDir, "moved-workspace"));
    fs.symlinkSync(path.join(tmpDir, "outside", "victim", "workspace"), path.join(runners, "eng17", "workspace"));

    const journal = path.join(tmpDir, "gc.jsonl");
    const gone = pruneSshRunCopies(items, journal);
    assert.deepEqual(gone, [], "nothing counted as removed");
    assert.equal(fs.existsSync(path.join(outsideCopy, "workspace", "file.txt")), true, "the outside copy must survive");
    const events = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const failed = events.filter((e) => e.event === "run-copy-remove-failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].path, old);
    assert.match(failed[0].error, /escapes root/);
    assert.equal(events.some((e) => e.event === "run-copy-removed"), false);
  });

  it("reports a missing root and a root that is not a directory, and keeps scanning", () => {
    const events = [];
    const onEvent = (e) => events.push(e);
    const missing = path.join(tmpDir, "nope");
    assert.deepEqual(scanSshRunCopies(missing, Date.now(), 4, { onEvent }), []);
    const notDir = path.join(tmpDir, "file-root");
    fs.writeFileSync(notDir, "x");
    assert.deepEqual(scanSshRunCopies(notDir, Date.now(), 4, { onEvent }), []);
    assert.deepEqual(events[0], { event: "run-copy-root-missing", root: missing });
    assert.equal(events[1].event, "run-copy-scan-failed");
    assert.equal(events[1].root, notDir);
    assert.match(events[1].error, /not a directory/);
  });

  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it("an unreadable runs directory is journaled and does not abort --apply", { skip: isRoot && "root ignores chmod 000" }, () => {
    const runners = path.join(tmpDir, "omp-runners");
    const bad = makeRun(runners, "eng-bad", "run-old", 6);
    const badRuns = path.dirname(bad);
    const good = makeRun(runners, "eng-good", "run-old", 6);
    const missingRoot = path.join(tmpDir, "no-such-runners");
    fs.chmodSync(badRuns, 0o000);
    try {
      const events = [];
      const items = scanSshRunCopies(runners, Date.now(), 4, { onEvent: (e) => events.push(e) });
      assert.deepEqual(items.map((i) => i.runner), ["eng-good"], "scan keeps going past the unreadable runner");
      assert.equal(events.length, 1);
      assert.equal(events[0].event, "run-copy-scan-failed");
      assert.equal(events[0].runner, "eng-bad");
      assert.match(events[0].error, /EACCES/);

      const { res, events: journal } = runGc(["--apply", "--runner-root", missingRoot, "--runner-root", runners]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(good), false, "the readable runner is still pruned");
      const failed = journal.find((e) => e.event === "run-copy-scan-failed");
      assert.equal(failed.runner, "eng-bad");
      assert.equal(failed.root, runners);
      assert.match(failed.error, /EACCES/);
      assert.ok(journal.some((e) => e.event === "run-copy-root-missing" && e.root === missingRoot));
      assert.ok(journal.some((e) => e.event === "run-copy-removed" && e.path === good));
      assert.equal(journal.find((e) => e.event === "apply-complete").runCopiesRemoved, 1);
    } finally {
      fs.chmodSync(badRuns, 0o755);
    }
  });

  it("rejects a --run-copy-ttl that is not a finite number or is below 3 hours", () => {
    for (const bad of ["abc", "", "NaN", "Infinity", "-5", "0", "2.9"]) {
      assert.throws(
        () => parseArgs(["node", "gc", "--env", "/nonexistent", "--run-copy-ttl", bad]),
        (err) => err instanceof UsageError && /--run-copy-ttl must be/.test(err.message),
        `ttl ${JSON.stringify(bad)} must be refused`,
      );
    }
    assert.throws(() => parseArgs(["node", "gc", "--env", "/nonexistent", "--run-copy-ttl"]), UsageError, "a missing value");
    assert.equal(parseArgs(["node", "gc", "--env", "/nonexistent", "--run-copy-ttl", "3"]).runCopyTtlHours, 3);
    assert.equal(parseArgs(["node", "gc", "--env", "/nonexistent", "--run-copy-ttl", "3.5"]).runCopyTtlHours, 3.5);
  });

  it("the CLI exits non-zero with a message on a bad --run-copy-ttl and removes nothing", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeRun(runners, "eng17", "run-old", 6);
    for (const bad of ["1", "abc"]) {
      const { res, events } = runGc(["--apply", "--runner-root", runners, "--run-copy-ttl", bad]);
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /--run-copy-ttl must be/);
      assert.equal(fs.existsSync(old), true);
      assert.deepEqual(events, []);
    }
  });
});
