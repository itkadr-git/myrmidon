// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import subprocess from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const { parseArgs, acquireLock, journalRecord, safeJoin, atomicDrop, fetchIssueStatus, filterClosedTaskClones, scanSshRunCopies, pruneSshRunCopies, scanRunnerTaskFolders, scanRunnerTmp, issueIdentifierFromRunnerFolderName, UsageError, listBotContainers, fetchAgentDecommissionState, scanBotDataForUnpushedWork, clearBotDiskProject, planBotDataGc } = await import(
  path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs")
);

// myrmidon(1.6.8 OPE-12855): a PATH `git` that is a launcher wrapper may strip
// GIT_AUTHOR_*/GIT_COMMITTER_* from the environment handed to git; the fixtures below put
// identity on argv (`-c`) so they survive that.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_AUTHOR_|GIT_COMMITTER_)/.test(k)));

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
    assert.equal(args.cloneTtlHours, 3);
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

// myrmidon(1.6.8 OPE-12855, ported from #3004): task folders of runner issues under
// <runner root>/<runner>/{workspace,home}/ — removed when the issue is done/cancelled and
// every git repo inside is clean and pushed, archived first when the git state is unsafe or
// unreadable, kept for any other issue status and on an unreachable board (fail-closed).
describe("runner task folders", () => {
  const HOUR = 60 * 60 * 1000;
  const GC_SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

  const makeRepo = (dir, { dirty = false, ahead = false } = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    // Identity goes on argv (-c): a PATH `git` that is a launcher wrapper may strip
    // GIT_AUTHOR_*/GIT_COMMITTER_* from the environment, argv config survives.
    const git = (args, cwd2 = dir) => {
      const r = subprocess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: cwd2, encoding: "utf8", env: GIT_ENV });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r;
    };
    const upstream = `${dir}.upstream.git`;
    git(["init", "-q", "--bare", upstream]);
    git(["init", "-q"]);
    git(["remote", "add", "origin", upstream]);
    fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "one"]);
    git(["push", "-q", "-u", "origin", "HEAD:main"]);
    if (ahead) {
      fs.writeFileSync(path.join(dir, "f.txt"), "one\ntwo\n");
      git(["commit", "-qam", "two"]);
    }
    if (dirty) fs.writeFileSync(path.join(dir, "dirty.txt"), "wip\n");
    return dir;
  };

  const makeTaskFolder = (runnersRoot, runner, name, { ageHours = 48, repo = "clone", ahead = false, dirty = false, worktree = false } = {}) => {
    const base = name.startsWith("wt-") ? "home" : "workspace";
    const dir = path.join(runnersRoot, runner, base, name);
    fs.mkdirSync(dir, { recursive: true });
    if (worktree) {
      fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(tmpDir, "gone-runs", "r1", "repo", ".git")}\n`);
      fs.writeFileSync(path.join(dir, "f.txt"), "x\n");
    } else if (repo === "clone") {
      makeRepo(path.join(dir, "repo"), { ahead, dirty });
    }
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(dir, t, t);
    return dir;
  };

  const scanWith = (runnersRoot, statuses = {}) =>
    scanRunnerTaskFolders(runnersRoot, Date.now(), 24, {
      fetchStatus: async (identifier) => statuses[identifier] ?? { ok: true, status: "done" },
      onEvent: () => {},
    });

  it("parses OPE identifiers from folder names", () => {
    assert.equal(issueIdentifierFromRunnerFolderName("OPE-12855"), "OPE-12855");
    assert.equal(issueIdentifierFromRunnerFolderName("OPE-12551-wt"), "OPE-12551");
    assert.equal(issueIdentifierFromRunnerFolderName("wt-ope12613"), "OPE-12613");
    assert.equal(issueIdentifierFromRunnerFolderName("not-a-task"), null);
  });

  it("a clean pushed folder of a done issue is removed", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855");
    const items = await scanWith(runners, { "OPE-12855": { ok: true, status: "done" } });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "remove", "clean-pushed"]]);
  });

  it("a cancelled issue's folder is removed like a done one", async () => {
    const runners = path.join(tmpDir, "runners");
    makeTaskFolder(runners, "eng21", "OPE-12855");
    const items = await scanWith(runners, { "OPE-12855": { ok: true, status: "cancelled" } });
    assert.equal(items[0].action, "remove");
  });

  it("an active issue keeps its folder", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855");
    const items = await scanWith(runners, { "OPE-12855": { ok: true, status: "in_progress" } });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "issue-status:in_progress"]]);
  });

  it("an unreachable board keeps the folder (fail-closed)", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855");
    const items = await scanWith(runners, { "OPE-12855": { ok: false, reason: "board-unavailable" } });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "board-unavailable"]]);
  });

  it("a 403 from the board keeps the folder and names the status code", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855");
    const items = await scanWith(runners, { "OPE-12855": { ok: false, reason: "board-forbidden", statusCode: 403 } });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "board-unavailable-403"]]);
  });

  it("unpushed commits hold the folder as unsafe", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855", { ahead: true });
    const items = await scanWith(runners);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a dirty tree holds the folder as unsafe", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855", { dirty: true });
    const items = await scanWith(runners);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a worktree with a dead gitdir is archived, never silently deleted", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855", { worktree: true });
    const items = await scanWith(runners);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a home worktree folder (wt-ope...) is scanned like a workspace one", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "wt-ope12613", { worktree: true });
    const items = await scanWith(runners);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a folder with no git repo inside is removed outright", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-12855", { repo: "none" });
    const items = await scanWith(runners);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "remove", "no-git-repos"]]);
  });

  it("a fresh folder is not even asked to the board", async () => {
    const runners = path.join(tmpDir, "runners");
    makeTaskFolder(runners, "eng21", "OPE-12855", { ageHours: 1 });
    let calls = 0;
    const items = await scanRunnerTaskFolders(runners, Date.now(), 24, {
      fetchStatus: async () => { calls++; return { ok: true, status: "done" }; },
    });
    assert.equal(calls, 0);
    assert.equal(items[0].action, "keep");
    assert.equal(items[0].reason, "retention");
  });

  it("a symlinked runner is skipped", async () => {
    const runners = path.join(tmpDir, "runners");
    const outside = path.join(tmpDir, "outside");
    makeTaskFolder(outside, "victim", "OPE-12855");
    fs.mkdirSync(runners, { recursive: true });
    fs.symlinkSync(path.join(outside, "victim"), path.join(runners, "eng8"));
    const items = await scanWith(runners);
    assert.deepEqual(items, []);
  });

  it("a missing root and a file root are reported and yield nothing", async () => {
    const events = [];
    const missing = path.join(tmpDir, "nope");
    assert.deepEqual(await scanRunnerTaskFolders(missing, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    const notDir = path.join(tmpDir, "file-root");
    fs.writeFileSync(notDir, "x");
    assert.deepEqual(await scanRunnerTaskFolders(notDir, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    assert.deepEqual(events[0], { event: "runner-folder-root-missing", root: missing });
    assert.equal(events[1].event, "runner-folder-scan-failed");
    assert.equal(events[1].root, notDir);
    assert.match(events[1].error, /not a directory/);
  });

  it("a scan error of one folder keeps the other folder's verdict", async () => {
    const runners = path.join(tmpDir, "runners");
    makeTaskFolder(runners, "eng-bad", "OPE-1");
    const good = makeTaskFolder(runners, "eng-good", "OPE-2");
    const items = await scanRunnerTaskFolders(runners, Date.now(), 24, {
      fetchStatus: async (identifier) => {
        if (identifier === "OPE-1") throw new Error("boom");
        return { ok: true, status: "done" };
      },
      onEvent: () => {},
    });
    const byPath = Object.fromEntries(items.map((i) => [i.path, i.reason]));
    assert.equal(byPath[good], "clean-pushed");
    const bad = items.find((i) => i.identifier === "OPE-1");
    assert.equal(bad.reason, "scan-failed");
    assert.equal(bad.action, "keep");
  });

  // Async spawn: the fake-board e2e runs the HTTP server in this same process, and
  // spawnSync would block the event loop the server needs to answer the child.
  const runGcTask = async (flags, envOverrides = {}) => {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc-task.jsonl");
    // A plain PATH: the GC subprocess makes ~a dozen read-only git calls per folder,
    // and a launcher-wrapper `git` on PATH multiplies each into a probe/broker walk
    // that together busts the spawn timeout. The host GC runs on a host whose PATH
    // git is the real binary, so this matches production.
    const env = { ...GIT_ENV, HOST_GC_RUNNER_ROOTS: "", PATH: "/usr/bin:/bin", PAPERCLIP_API_URL: "http://127.0.0.1:9", ...envOverrides };
    const res = await new Promise((resolve, reject) => {
      const child = subprocess.spawn(process.execPath, [
        GC_SCRIPT, "--root", botsRoot,
        "--journal", journal, "--lock", path.join(tmpDir, "gc-task.lock"),
        ...flags,
      ], { encoding: "utf8", env, timeout: 120_000, killSignal: "SIGKILL" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ status: code === null ? (signal === "SIGKILL" ? 143 : code) : code, stdout, stderr }));
    });
    const events = fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { res, events };
  };

  it("e2e: --apply removes the clean done folder and archives the unpushed one, board via local fake", async () => {
    const runners = path.join(tmpDir, "runners");
    const clean = makeTaskFolder(runners, "eng21", "OPE-9001", { ageHours: 30 });
    const unpushed = makeTaskFolder(runners, "eng21", "OPE-9002", { ageHours: 30, ahead: true });
    const active = makeTaskFolder(runners, "eng21", "OPE-9003", { ageHours: 30 });
    const fresh = makeTaskFolder(runners, "eng21", "OPE-9004", { ageHours: 1 });
    const http = await import("node:http");
    const statuses = { "OPE-9001": "done", "OPE-9002": "done", "OPE-9003": "in_progress" };
    const fake = http.createServer((req, res) => {
      const m = /\/api\/issues\/([^/?]+)/.exec(req.url || "");
      const status = m && statuses[decodeURIComponent(m[1])];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: status || "todo" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = fake.address().port;
    try {
      const { res, events } = await runGcTask(["--apply", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(clean), false, "clean done folder must be removed");
      assert.equal(fs.existsSync(unpushed), false, "unpushed folder must be removed after archive");
      assert.equal(fs.existsSync(active), true, "active issue's folder must stay");
      assert.equal(fs.existsSync(fresh), true, "fresh folder must stay");
      assert.ok(fs.readdirSync(path.join(runners, ".gc-archive")).some((n) => n.startsWith("OPE-9002-")), "archive present");
      const removed = events.find((e) => e.event === "runner-task-folder-removed" && e.path === clean);
      assert.ok(removed, "clean removal journaled");
      assert.equal(removed.reason, "clean-pushed");
      assert.ok(events.some((e) => e.event === "runner-task-folder-archived" && e.path === unpushed));
      assert.ok(events.some((e) => e.event === "runner-task-folder-removed-after-archive" && e.path === unpushed));
      assert.ok(events.some((e) => e.event === "runner-task-folder-skipped" && e.path === active && e.reason === "issue-status:in_progress"));
      const done = events.find((e) => e.event === "apply-complete");
      assert.equal(done.runnerTaskFoldersRemoved, 2);
      assert.equal(JSON.parse(res.stdout).runnerTaskFoldersRemoved, 2);
    } finally {
      fake.close();
    }
  });

  it("e2e: a failed archive (tar exits 2) leaves no partial archive and is journaled with the exit code", async () => {
    const runners = path.join(tmpDir, "runners");
    const unpushed = makeTaskFolder(runners, "eng21", "OPE-9201", { ageHours: 30, ahead: true });
    const fakeBin = path.join(tmpDir, "fakebin");
    fs.mkdirSync(fakeBin, { recursive: true });
    // No zstd, so the script takes the tar.gz path; the fake tar writes a partial archive and fails with code 2.
    fs.writeFileSync(path.join(fakeBin, "zstd"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, "tar"), "#!/bin/sh\nhead -c 1024 /dev/zero > \"$2\"\nexit 2\n", { mode: 0o755 });
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = fake.address().port;
    try {
      const { res, events } = await runGcTask(["--apply", "--runner-root", runners], {
        PAPERCLIP_API_URL: `http://127.0.0.1:${port}`,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(unpushed), true, "folder must stay when the archive failed");
      const archiveDir = path.join(runners, ".gc-archive");
      const left = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((n) => n.startsWith("OPE-9201-")) : [];
      assert.deepEqual(left, [], "no partial archive may remain");
      const failed = events.find((e) => e.event === "runner-task-folder-archive-failed" && e.path === unpushed);
      assert.ok(failed, "failure journaled");
      assert.match(failed.error, /exit code 2/);
    } finally {
      fake.close();
    }
  });

  it("e2e: the archive skips git-ignored node_modules and build outputs but keeps .git and working files", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-9301", { ageHours: 30, ahead: true });
    fs.writeFileSync(path.join(folder, "repo", ".gitignore"), "node_modules\ndist\n");
    fs.mkdirSync(path.join(folder, "repo", "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    fs.mkdirSync(path.join(folder, "repo", "dist"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "dist", "out.js"), "built\n");
    fs.writeFileSync(path.join(folder, "repo", "notes.txt"), "keep me\n");
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = fake.address().port;
    try {
      const { res } = await runGcTask(["--apply", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
      assert.equal(res.status, 0, res.stderr);
      const archiveDir = path.join(runners, ".gc-archive");
      const names = fs.readdirSync(archiveDir).filter((n) => n.startsWith("OPE-9301-"));
      assert.equal(names.length, 1, "one archive");
      // GNU tar detects gzip and zstd by itself when listing a file.
      const list = subprocess.spawnSync("tar", ["-tf", path.join(archiveDir, names[0])], { encoding: "utf8" });
      assert.equal(list.status, 0, list.stderr);
      assert.ok(list.stdout.includes("OPE-9301/repo/.git/HEAD"), "a .git file is archived");
      assert.ok(list.stdout.includes("OPE-9301/repo/notes.txt"), "a working file is archived");
      assert.ok(!list.stdout.includes("node_modules"), "node_modules is not archived");
      assert.ok(!list.stdout.includes("dist/out.js"), "build output is not archived");
    } finally {
      fake.close();
    }
  });

  // Runs one archive pass over `folder` (already built by the caller) and returns the `tar -tf` listing.
  const archiveListing = async (runners, taskName) => {
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = fake.address().port;
    try {
      const { res } = await runGcTask(["--apply", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
      assert.equal(res.status, 0, res.stderr);
      const archiveDir = path.join(runners, ".gc-archive");
      const names = fs.readdirSync(archiveDir).filter((n) => n.startsWith(`${taskName}-`));
      assert.equal(names.length, 1, "one archive");
      const list = subprocess.spawnSync("tar", ["-tf", path.join(archiveDir, names[0])], { encoding: "utf8" });
      assert.equal(list.status, 0, list.stderr);
      return list.stdout;
    } finally {
      fake.close();
    }
  };

  it("e2e: an uncommitted file git does not ignore inside dist/ is archived, an ignored node_modules is not", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-9302", { ageHours: 30, dirty: true });
    fs.writeFileSync(path.join(folder, "repo", ".gitignore"), "node_modules\n");
    fs.mkdirSync(path.join(folder, "repo", "dist"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "dist", "keep.txt"), "my work\n");
    fs.mkdirSync(path.join(folder, "repo", "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "node_modules", "x", "y.js"), "1\n");
    const listing = await archiveListing(runners, "OPE-9302");
    assert.ok(listing.includes("OPE-9302/repo/dist/keep.txt"), "non-ignored file in dist/ is archived");
    assert.ok(!listing.includes("node_modules"), "ignored node_modules is not archived");
  });

  it("e2e: ignored dirs are excluded by exact path, a similar path with a space or glob char elsewhere stays", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-9304", { ageHours: 30, dirty: true });
    fs.writeFileSync(path.join(folder, "repo", ".gitignore"), "/dist\n/my app \\[1\\]/dist\n");
    fs.mkdirSync(path.join(folder, "repo", "dist"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "dist", "out.js"), "built\n");
    fs.mkdirSync(path.join(folder, "repo", "my app [1]", "dist"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "my app [1]", "dist", "out.js"), "built\n");
    fs.mkdirSync(path.join(folder, "repo", "pkg", "dist"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", "pkg", "dist", "mine.txt"), "not ignored\n");
    const listing = await archiveListing(runners, "OPE-9304");
    assert.ok(!listing.includes("repo/dist/out.js"), "ignored /dist is not archived");
    assert.ok(!listing.includes("my app [1]/dist"), "ignored path with space and brackets is not archived");
    assert.ok(listing.includes("OPE-9304/repo/pkg/dist/mine.txt"), "dist elsewhere, not ignored, is archived");
  });

  it("e2e: a subtree without a working git repo is archived whole (git cannot confirm anything ignored)", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng21", "OPE-9303", { ageHours: 30, dirty: true });
    // `plain` has no .git at all; `broken` has a .git that is not a repository, so git fails there.
    for (const sub of ["plain", "broken"]) {
      fs.mkdirSync(path.join(folder, sub, "node_modules", "x"), { recursive: true });
      fs.writeFileSync(path.join(folder, sub, "node_modules", "x", "y.js"), "1\n");
      fs.mkdirSync(path.join(folder, sub, "dist"), { recursive: true });
      fs.writeFileSync(path.join(folder, sub, "dist", "out.js"), "built\n");
    }
    fs.mkdirSync(path.join(folder, "broken", ".git"), { recursive: true });
    // New subdirs bumped the folder's mtime: age it again so the TTL applies.
    const aged = new Date(Date.now() - 30 * HOUR);
    fs.utimesSync(folder, aged, aged);
    const listing = await archiveListing(runners, "OPE-9303");
    for (const sub of ["plain", "broken"]) {
      assert.ok(listing.includes(`OPE-9303/${sub}/node_modules/x/y.js`), `${sub}: node_modules archived`);
      assert.ok(listing.includes(`OPE-9303/${sub}/dist/out.js`), `${sub}: dist archived`);
    }
  });

  // Shared by the two failing-archive tests: fake tar/zstd on PATH, a fake board that says "done".
  const runWithFakeArchiveTools = async (name, { tarBody, zstdBody }, envExtra = {}) => {
    const runners = path.join(tmpDir, "runners");
    const unpushed = makeTaskFolder(runners, "eng21", name, { ageHours: 30, ahead: true });
    const fakeBin = path.join(tmpDir, "fakebin2");
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "zstd"), zstdBody, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, "tar"), tarBody, { mode: 0o755 });
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      const out = await runGcTask(["--apply", "--runner-root", runners], {
        PAPERCLIP_API_URL: `http://127.0.0.1:${fake.address().port}`,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        ...envExtra,
      });
      const archiveDir = path.join(runners, ".gc-archive");
      const left = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).filter((n) => n.startsWith(`${name}-`)) : [];
      return { ...out, unpushed, left, failed: out.events.find((e) => e.event === "runner-task-folder-archive-failed" && e.path === unpushed) };
    } finally {
      fake.close();
    }
  };

  it("e2e: a hanging tar is killed by the archive timeout, no archive is left, the journal says timed out", async () => {
    const started = Date.now();
    // tar.gz branch (fake zstd refuses --version); the fake tar writes a partial file and then hangs.
    const { res, unpushed, left, failed } = await runWithFakeArchiveTools("OPE-9302", {
      zstdBody: "#!/bin/sh\nexit 1\n",
      tarBody: "#!/bin/sh\nhead -c 1024 /dev/zero > \"$2\"\nsleep 60\n",
    }, { HOST_GC_ARCHIVE_TIMEOUT_SECONDS: "2" });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(Date.now() - started < 40_000, "the hang was cut short by the timeout");
    assert.equal(fs.existsSync(unpushed), true, "folder stays");
    assert.deepEqual(left, [], "no partial archive remains");
    assert.ok(failed, "failure journaled");
    assert.match(failed.error, /timed out after 2 s/);
  });

  it("e2e: pipefail: tar fails (exit 2) while zstd succeeds, the failure is not masked", async () => {
    const { res, unpushed, left, failed } = await runWithFakeArchiveTools("OPE-9303", {
      zstdBody: "#!/bin/sh\n[ \"$1\" = \"--version\" ] && exit 0\ncat > \"$3\"\nexit 0\n",
      tarBody: "#!/bin/sh\nexit 2\n",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(unpushed), true, "folder stays");
    assert.deepEqual(left, [], "no archive remains");
    assert.ok(failed, "failure journaled");
    assert.match(failed.error, /exit code 2/);
  });

  it("e2e: an unreachable board keeps every folder (fail-closed apply)", async () => {
    const runners = path.join(tmpDir, "runners");
    const clean = makeTaskFolder(runners, "eng21", "OPE-9101", { ageHours: 30 });
    const { res } = await runGcTask(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(clean), true, "unreachable board must keep the folder");
  });

  it("e2e: dry-run removes nothing and lists the plan", async () => {
    const runners = path.join(tmpDir, "runners");
    const clean = makeTaskFolder(runners, "eng21", "OPE-9201", { ageHours: 30 });
    const http = await import("node:http");
    const fake = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const port = fake.address().port;
    try {
      const { res, events } = await runGcTask(["--dry-run", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(clean), true);
      assert.equal(events.find((e) => e.event === "dry-run").runnerTaskFolders, 1);
      const out = JSON.parse(res.stdout);
      assert.deepEqual(out.plan.runnerTaskFolders.map((i) => [i.path, i.action]), [[clean, "remove"]]);
    } finally {
      fake.close();
    }
  });
});


// --- Bot data GC of decommissioned bots (OPE-12654) ---

// myrmidon(OPE-12966): the omp runner's /tmp lives on the data volume (`<runner>/tmp`); the
// pass removes top-level entries nothing has changed in for the TTL.
describe("runner /tmp (OPE-12966)", () => {
  const HOUR = 60 * 60 * 1000;
  const GC_SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

  const setAge = (p, ageHours) => {
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(p, t, t);
  };
  // A file or a directory (with one file inside) in `<runners>/<runner>/tmp`, aged `ageHours`.
  const makeTmpEntry = (runners, runner, name, { ageHours = 48, dir = false, innerAgeHours } = {}) => {
    const base = path.join(runners, runner, "tmp");
    fs.mkdirSync(base, { recursive: true });
    const p = path.join(base, name);
    if (dir) {
      fs.mkdirSync(p);
      const inner = path.join(p, "data.bin");
      fs.writeFileSync(inner, "x".repeat(100));
      setAge(inner, innerAgeHours ?? ageHours);
    } else {
      fs.writeFileSync(p, "x".repeat(100));
    }
    setAge(p, ageHours);
    return p;
  };
  const plan = (runners, events = []) =>
    Object.fromEntries(scanRunnerTmp(runners, Date.now(), 24, { onEvent: (e) => events.push(e) }).map((i) => [i.name, i]));

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

  it("plans an old entry for removal and keeps a young one", () => {
    const runners = path.join(tmpDir, "runners");
    makeTmpEntry(runners, "eng17", "old-file", { ageHours: 30 });
    makeTmpEntry(runners, "eng17", "old-dir", { ageHours: 30, dir: true });
    makeTmpEntry(runners, "eng17", "young-file", { ageHours: 1 });
    const p = plan(runners);
    assert.equal(p["old-file"].reason, "ttl");
    assert.equal(p["old-dir"].reason, "ttl");
    assert.equal(p["old-dir"].runnersRoot, runners);
    assert.ok(p["old-dir"].sizeBytes > 0);
    assert.equal(p["young-file"].reason, "fresh");
  });

  it("an old directory with a fresh file inside stays", () => {
    const runners = path.join(tmpDir, "runners");
    makeTmpEntry(runners, "eng17", "busy", { ageHours: 48, dir: true, innerAgeHours: 1 });
    assert.equal(plan(runners).busy.reason, "fresh");
  });

  it("a symlink at the top level is never planned and its target is untouched", () => {
    const runners = path.join(tmpDir, "runners");
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "x");
    setAge(path.join(outside, "keep.txt"), 100);
    makeTmpEntry(runners, "eng17", "anchor", { ageHours: 1 });
    const link = path.join(runners, "eng17", "tmp", "link");
    fs.symlinkSync(outside, link);
    const p = plan(runners);
    assert.equal(p.link.reason, "symlink");
    const { res } = runGc(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  });

  it("a symlink inside an entry is not followed: its target does not make the entry fresh and is not deleted", () => {
    const runners = path.join(tmpDir, "runners");
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "young.txt"), "x");
    const entry = makeTmpEntry(runners, "eng17", "d", { ageHours: 48, dir: true });
    fs.symlinkSync(outside, path.join(entry, "ln"));
    const t = new Date(Date.now() - 48 * HOUR);
    fs.lutimesSync(path.join(entry, "ln"), t, t);
    fs.utimesSync(entry, t, t);
    assert.equal(plan(runners).d.reason, "ttl");
    const { res } = runGc(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(entry), false);
    assert.equal(fs.existsSync(path.join(outside, "young.txt")), true, "the link target must survive");
  });

  it("a runner whose tmp is a symlink is skipped", () => {
    const runners = path.join(tmpDir, "runners");
    const outside = path.join(tmpDir, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "old.txt"), "x");
    setAge(path.join(outside, "old.txt"), 100);
    fs.mkdirSync(path.join(runners, "eng8"), { recursive: true });
    fs.symlinkSync(outside, path.join(runners, "eng8", "tmp"));
    assert.deepEqual(scanRunnerTmp(runners, Date.now(), 24), []);
  });

  it("a missing root and a file root are reported and yield nothing", () => {
    const events = [];
    const missing = path.join(tmpDir, "nope");
    assert.deepEqual(scanRunnerTmp(missing, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    const notDir = path.join(tmpDir, "file-root");
    fs.writeFileSync(notDir, "x");
    assert.deepEqual(scanRunnerTmp(notDir, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    assert.deepEqual(events[0], { event: "runner-tmp-root-missing", root: missing });
    assert.equal(events[1].event, "runner-tmp-scan-failed");
    assert.match(events[1].error, /not a directory/);
  });

  it("--apply removes old entries, keeps young ones and tmp itself, and journals the counts", () => {
    const runners = path.join(tmpDir, "runners");
    const oldDir = makeTmpEntry(runners, "eng17", "old-dir", { ageHours: 30, dir: true });
    const oldFile = makeTmpEntry(runners, "eng21", "old-file", { ageHours: 30 });
    const young = makeTmpEntry(runners, "eng17", "young", { ageHours: 1 });
    const { res, events } = runGc(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(oldFile), false);
    assert.equal(fs.existsSync(young), true);
    assert.equal(fs.existsSync(path.join(runners, "eng21", "tmp")), true, "tmp itself stays");
    const removed = events.find((e) => e.event === "runner-tmp-removed" && e.path === oldDir && e.runner === "eng17");
    assert.ok(removed);
    assert.ok(removed.sizeBytes > 0);
    assert.equal(events.find((e) => e.event === "apply-complete").runnerTmpRemoved, 2);
    assert.equal(JSON.parse(res.stdout).runnerTmpRemoved, 2);
  });

  it("--dry-run removes nothing and lists the plan", () => {
    const runners = path.join(tmpDir, "runners");
    const old = makeTmpEntry(runners, "eng17", "old-dir", { ageHours: 30, dir: true });
    const { res, events } = runGc(["--dry-run", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(old), true);
    assert.ok(!events.some((e) => e.event === "runner-tmp-removed"));
    const out = JSON.parse(res.stdout);
    assert.equal(out.plan.runnerTmp.length, 1);
    assert.equal(out.plan.runnerTmp[0].path, old);
  });

  it("without a runner root the pass does not run", () => {
    const runners = path.join(tmpDir, "runners");
    const old = makeTmpEntry(runners, "eng17", "old-dir", { ageHours: 30, dir: true });
    const { res, events } = runGc(["--apply"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(old), true);
    assert.equal(JSON.parse(res.stdout).runnerTmpRemoved, 0);
    assert.ok(!events.some((e) => e.event.startsWith("runner-tmp-")));
  });

  it("parses --runner-tmp-ttl and refuses a value that is not finite or below 3 hours", () => {
    assert.equal(parseArgs(["node", "gc"]).runnerTmpTtlHours, 24);
    assert.equal(parseArgs(["node", "gc", "--runner-tmp-ttl", "12"]).runnerTmpTtlHours, 12);
    assert.throws(() => parseArgs(["node", "gc", "--runner-tmp-ttl", "1"]), UsageError);
    assert.throws(() => parseArgs(["node", "gc", "--runner-tmp-ttl", "abc"]), UsageError);
  });
});

describe("agent decommission guard", () => {
  const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const KEY = "e0d04e36-1111-4222-8333-444455556666";

  it("hermes_gateway card holds the directory", async () => {
    const result = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async (url) => {
        assert.equal(url, `http://board/api/agents/${KEY}`);
        return response(200, { adapterType: "hermes_gateway", status: "idle" });
      },
    });
    assert.deepEqual(result, { ok: true, state: "hermes_gateway" });
  });

  it("a card moved to another adapter reads left_hermes_gateway", async () => {
    const result = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => response(200, { adapterType: "omp_local", status: "idle" }),
    });
    assert.deepEqual(result, { ok: true, state: "left_hermes_gateway" });
  });

  it("terminated and hard-deleted agents read terminated/deleted", async () => {
    const terminated = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => response(200, { adapterType: "hermes_gateway", status: "terminated" }),
    });
    assert.deepEqual(terminated, { ok: true, state: "terminated" });

    const deleted = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => response(404, {}),
    });
    assert.deepEqual(deleted, { ok: true, state: "deleted" });
  });

  it("a running heartbeat run holds the directory", async () => {
    const result = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => response(200, { adapterType: "omp_local", status: "running" }),
    });
    assert.deepEqual(result, { ok: true, state: "running" });
  });

  it("fails closed on board errors", async () => {
    const unavailable = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => { throw new Error("offline"); },
    });
    assert.equal(unavailable.ok, false);
    assert.equal(unavailable.reason, "board-unavailable");

    const forbidden = await fetchAgentDecommissionState(KEY, {
      baseUrl: "http://board",
      fetchImpl: async () => response(403, {}),
    });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.reason, "board-forbidden");
  });

  it("rejects a non-UUID agent id without a call", async () => {
    const result = await fetchAgentDecommissionState("../etc", {
      baseUrl: "http://board",
      fetchImpl: async () => { throw new Error("must not be called"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "bad-agent-id");
  });
});

describe("unpushed-work scan", () => {
  const KEY = "0123abcd-1111-4222-8333-444455556666";

  const makeRepo = (dir, { dirty = false, ahead = false, stash = false } = {}) => {
    fs.mkdirSync(dir, { recursive: true });
    const git = (args, cwd2 = dir) => {
      const r = subprocess.spawnSync("git", args, { cwd: cwd2, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r;
    };
    // A bare upstream + a push of the base commit, so "clean" means really pushed.
    const upstream = `${dir}.upstream.git`;
    git(["init", "-q", "--bare", upstream]);
    git(["init", "-q"]);
    git(["remote", "add", "origin", upstream]);
    fs.writeFileSync(path.join(dir, "f.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "one"]);
    git(["push", "-q", "-u", "origin", "HEAD:main"]);
    if (ahead) {
      fs.writeFileSync(path.join(dir, "f.txt"), "one\ntwo\n");
      git(["commit", "-qam", "two"]);
    }
    if (dirty) fs.writeFileSync(path.join(dir, "dirty.txt"), "wip\n");
    if (stash) {
      // Stash only its own file so a dirty tree stays dirty.
      fs.writeFileSync(path.join(dir, "stash.txt"), "s\n");
      git(["add", "stash.txt"]);
      git(["stash", "-q", "--", "stash.txt"]);
    }
    return dir;
  };

  let gitWs;
  beforeEach(() => {
    gitWs = path.join(tmpDir, "bot", "workspace", "OPE-12654");
    fs.mkdirSync(gitWs, { recursive: true });
  });

  it("a repo with a commit ahead of upstream is held with a reason", () => {
    makeRepo(path.join(gitWs, "repo"), { ahead: true });
    const result = scanBotDataForUnpushedWork(path.join(tmpDir, "bot"));
    assert.equal(result.unpushed, true);
    assert.ok(result.reasons.some((r) => r.includes("commits ahead of upstream")));
  });

  it("dirty tree and stash are unpushed work", () => {
    makeRepo(path.join(gitWs, "repo"), { dirty: true, stash: true });
    const result = scanBotDataForUnpushedWork(path.join(tmpDir, "bot"));
    assert.equal(result.unpushed, true);
    assert.ok(result.reasons.some((r) => r.includes("uncommitted changes")));
    assert.ok(result.reasons.some((r) => r.includes("stash entries")));
  });

  it("a clean pushed repo is removable", () => {
    makeRepo(path.join(gitWs, "repo"));
    const result = scanBotDataForUnpushedWork(path.join(tmpDir, "bot"));
    assert.deepEqual(result, { unpushed: false, reasons: [] });
  });

  it(".next and .helper are not scanned", () => {
    for (const name of [".next", ".helper"]) {
      const d = path.join(tmpDir, "bot", name, "OPE-12654");
      makeRepo(d, { ahead: true });
    }
    const result = scanBotDataForUnpushedWork(path.join(tmpDir, "bot"));
    assert.deepEqual(result, { unpushed: false, reasons: [] });
  });
});

describe("bot-data gc plan (decommission sweep)", () => {
  const OLD_KEY = "aaaaaaaa-1111-4222-8333-444455556666";
  const NEW_KEY = "bbbbbbbb-1111-4222-8333-444455556666";
  const NOW = Date.parse("2026-11-11T12:00:00Z");

  const makeBotDir = (key, ageHours) => {
    const dir = path.join(tmpDir, key);
    fs.mkdirSync(dir, { recursive: true });
    const stale = new Date(NOW - (ageHours + 1) * 3600 * 1000);
    fs.utimesSync(dir, stale, stale);
    return dir;
  };
  const containers = (keys) => ({ ok: true, keys: new Set(keys) });
  const stateOf = (map) => async (agentId) => map[agentId] ?? { ok: false, reason: "board-unavailable" };

  it("old dir of an agent moved off hermes_gateway is removed after retention", async () => {
    makeBotDir(OLD_KEY, 25);
    const plan = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({ [OLD_KEY]: { ok: true, state: "left_hermes_gateway" } }),
      scan: () => ({ unpushed: false, reasons: [] }),
    });
    assert.deepEqual(plan, { ok: true, plan: [{ name: OLD_KEY, path: path.join(tmpDir, OLD_KEY), ageMs: 26 * 3600 * 1000, action: "remove", reason: "decommissioned-clean" }] });
  });

  it("hermes_gateway agent and fresh dirs are kept", async () => {
    makeBotDir(OLD_KEY, 25);
    makeBotDir(NEW_KEY, 1);
    const plan = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({ [OLD_KEY]: { ok: true, state: "hermes_gateway" } }),
      scan: () => { throw new Error("must not scan a hermes bot"); },
    });
    assert.equal(plan.ok, true);
    const byKey = Object.fromEntries(plan.plan.map((p) => [p.name, p]));
    assert.equal(byKey[OLD_KEY].action, "keep");
    assert.equal(byKey[OLD_KEY].reason, "agent-on-hermes-gateway");
    assert.equal(byKey[NEW_KEY].action, "keep");
    assert.equal(byKey[NEW_KEY].reason, "retention");
  });

  it("a directory with a commit ahead of upstream is kept and reported", async () => {
    makeBotDir(OLD_KEY, 25);
    const plan = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({ [OLD_KEY]: { ok: true, state: "left_hermes_gateway" } }),
      scan: () => ({ unpushed: true, reasons: ["OPE-12654/repo: commits ahead of upstream"] }),
    });
    const item = plan.plan[0];
    assert.equal(item.action, "keep");
    assert.equal(item.reason, "unpushed-work");
    assert.deepEqual(item.details, ["OPE-12654/repo: commits ahead of upstream"]);
  });

  it("an existing container of any state holds the directory", async () => {
    makeBotDir(OLD_KEY, 25);
    const plan = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([OLD_KEY]),
      agentState: stateOf({}),
      scan: () => { throw new Error("must not be called"); },
    });
    const item = plan.plan[0];
    assert.equal(item.action, "keep");
    assert.equal(item.reason, "container-exists");
  });

  it("a running run and a terminated agent decide differently", async () => {
    makeBotDir(OLD_KEY, 25);
    const held = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({ [OLD_KEY]: { ok: true, state: "running" } }),
      scan: () => { throw new Error("must not be called"); },
    });
    assert.equal(held.plan[0].reason, "agent-has-running-run");

    const gone = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({ [OLD_KEY]: { ok: true, state: "terminated" } }),
      scan: () => ({ unpushed: false, reasons: [] }),
    });
    assert.equal(gone.plan[0].action, "remove");
    assert.equal(gone.plan[0].reason, "agent-terminated-clean");
  });

  it("an unavailable board and unavailable docker fail closed", async () => {
    makeBotDir(OLD_KEY, 25);
    const boardDown = await planBotDataGc(tmpDir, {
      now: NOW,
      containers: containers([]),
      agentState: stateOf({}),
      scan: () => { throw new Error("must not be called"); },
    });
    assert.equal(boardDown.plan[0].action, "keep");
    assert.equal(boardDown.plan[0].reason, "board-unavailable");

    const dockerDown = await planBotDataGc(tmpDir, { now: NOW, containers: { ok: false, reason: "docker-unavailable" } });
    assert.equal(dockerDown.ok, false);
    assert.equal(dockerDown.reason, "docker-unavailable");
  });
});
