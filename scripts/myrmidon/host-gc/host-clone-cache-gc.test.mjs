// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import subprocess from "node:child_process";
import { createServer } from "node:http";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { startGitDaemon } from "./git-daemon-fixture.mjs";

// Fixtures use bare repositories on disk as "servers": a git daemon makes them real git:// remotes.
const gitDaemon = await startGitDaemon();
Object.assign(process.env, gitDaemon.env);
after(() => gitDaemon.stop());
const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
// A bot container exports empty GIT_AUTHOR_*/GIT_COMMITTER_* variables; git honors an
// empty env var over config, which breaks commit fixtures. Strip them everywhere.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_AUTHOR_|GIT_COMMITTER_)/.test(k)));
const {
  parseArgs,
  acquireLock,
  consumeGcRequest,
  journalRecord,
  safeJoin,
  atomicDrop,
  fetchIssueStatus,
  filterClosedTaskClones,
  scanScratchDirectory,
  discoverBotScratchDirs,
  inspectPathTree,
  isTreeOpen,
  loadEnvConfig,
  listBotContainers,
  listOmpRunnerContainers,
  fetchAgentAdapter,
  planStaleOmpRunners,
  stopOmpRunner,
  fetchAgentDecommissionState,
  scanBotDataForUnpushedWork,
  clearBotDiskProject,
  planBotDataGc,
  scanSshRunCopies,
  pruneSshRunCopies,
  UsageError,
  scanRunnerTaskFolders,
  scanRunnerNpmCaches,
  scanRunnerTmp,
  pruneRunnerNpmCaches,
  issueIdentifierFromRunnerFolderName,
  scanRunnerUnrecognizedWorkspaceFolders,
  scanIdleOpenClones,
  pruneIdleOpenClones,
  scanTaskClones,
  assessClone,
  scanReviewerClones,
  pruneReviewerClones,
  isReviewerAgent,
  fetchBotAgent,
  fetchRunAgentId,
  fetchIssueOpenState,
  volumeFreePercent,
  runnerFolderKeepReason,
  scanBoardProjectWorkspaces,
  pruneBoardProjectWorkspaces,
  boardGitActive,
} = await import(
  path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs")
);

let tmpDir;

describe("board project workspace GC", () => {
  it("uses the real proc detector to retain packs when git is live or proc unavailable", async () => {
    const home = path.join(tmpDir, "home");
    const pack = path.join(home, "instances/default/projects/c/p/repo/.git/objects/pack");
    const proc = path.join(tmpDir, "proc");
    fs.mkdirSync(pack, { recursive: true });
    fs.mkdirSync(path.join(proc, "123"), { recursive: true });
    fs.writeFileSync(path.join(proc, "123/comm"), "git-fetch\n");
    const old = new Date(Date.now() - 30 * 3600000);
    for (const name of ["tmp_pack_old", "tmp_idx_old"]) {
      fs.writeFileSync(path.join(pack, name), "x");
      fs.utimesSync(path.join(pack, name), old, old);
    }
    for (const procDir of [proc, path.join(tmpDir, "missing")]) {
      const options = { gitActive: () => boardGitActive(procDir) };
      const plan = await scanBoardProjectWorkspaces(home, Date.now(), options);
      assert.equal(plan.length, 2);
      assert.ok(plan.every((item) => item.reason === "live-git"));
      await pruneBoardProjectWorkspaces(plan, path.join(tmpDir, "proc.jsonl"), options);
      assert.ok(fs.existsSync(path.join(pack, "tmp_pack_old")));
      assert.ok(fs.existsSync(path.join(pack, "tmp_idx_old")));
    }
  });

  it("rechecks only each candidate across multiple projects", async () => {
    const home = path.join(tmpDir, "home");
    const old = new Date(Date.now() - 30 * 3600000);
    for (const n of [100, 101, 102]) {
      const scratch = path.join(home, `instances/default/projects/c/p${n}/repo/.scratch/ope${n}`);
      fs.mkdirSync(scratch, { recursive: true });
      fs.utimesSync(scratch, old, old);
    }
    let calls = 0;
    const options = { fetchState: async () => { calls++; return { ok: true, status: "done", closedAt: old.toISOString() }; } };
    const plan = await scanBoardProjectWorkspaces(home, Date.now(), options);
    assert.equal(calls, 3);
    await pruneBoardProjectWorkspaces(plan, path.join(tmpDir, "linear.jsonl"), options);
    assert.equal(calls, 6);
  });
  it("keeps an old closed scratch containing unpublished non-git work", async () => {
    const home = path.join(tmpDir, "home");
    const scratch = path.join(home, "instances/default/projects/company/project/repo/.scratch/ope900");
    fs.mkdirSync(scratch, { recursive: true });
    const file = path.join(scratch, "unpublished.txt");
    fs.writeFileSync(file, "irreplaceable work");
    const old = new Date(Date.now() - 30 * 3600000);
    fs.utimesSync(file, old, old);
    fs.utimesSync(scratch, old, old);
    const options = { fetchState: async () => ({ ok: true, status: "done", closedAt: old.toISOString() }) };
    const plan = await scanBoardProjectWorkspaces(home, Date.now(), options);
    await pruneBoardProjectWorkspaces(plan, path.join(tmpDir, "safety.jsonl"), options);
    assert.equal(fs.readFileSync(file, "utf8"), "irreplaceable work");
  });
  it("runs the board pass from the host env file and journals removals", () => {
    const home = path.join(tmpDir, "board-home");
    const repo = path.join(home, "instances/default/projects/company/project/myrmidon");
    const pack = path.join(repo, ".git/objects/pack/tmp_pack_old");
    const store = path.join(repo, ".paperclip/pnpm-store");
    const root = path.join(tmpDir, "bots");
    const proc = path.join(tmpDir, "proc");
    const envFile = path.join(tmpDir, "gc.env");
    const journal = path.join(tmpDir, "gc.jsonl");
    for (const dir of [path.dirname(pack), store, root, proc]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pack, "old pack");
    const old = new Date(Date.now() - 30 * 3600000);
    for (const entry of [pack, store]) fs.utimesSync(entry, old, old);
    fs.writeFileSync(envFile, `MYRMIDON_HOME=${home}\n`);
    const env = { ...process.env, HOST_GC_RUNNER_ROOTS: "" };
    delete env.MYRMIDON_HOME;
    delete env.PAPERCLIP_HOME;
    const res = subprocess.spawnSync(process.execPath, [
      path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs"), "--apply", "--env", envFile,
      "--root", root, "--journal", journal, "--lock", path.join(tmpDir, "gc.lock"), "--proc-dir", proc,
    ], { encoding: "utf8", env, timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(pack), false);
    assert.equal(fs.existsSync(store), false);
    const removed = fs.readFileSync(journal, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.event === "board-project-removed");
    assert.deepEqual(new Set(removed.map((e) => e.path)), new Set([pack, store]));
  });

  it("removes old packs, closed scratch and pnpm cache; keeps open and live git", async () => {
    const home = path.join(tmpDir, "home");
    const repo = path.join(home, "instances/default/projects/company/project/myrmidon");
    const pack = path.join(repo, ".git/objects/pack");
    const scratch = path.join(repo, ".scratch");
    const store = path.join(repo, ".paperclip/pnpm-store");
    for (const p of [pack, path.join(scratch, "ope100"), path.join(scratch, "ope101-wt"), store]) fs.mkdirSync(p, { recursive: true });
    const old = new Date(Date.now() - 30 * 3600000);
    for (const name of ["tmp_pack_old", "tmp_idx_old"]) {
      fs.writeFileSync(path.join(pack, name), "x");
      fs.utimesSync(path.join(pack, name), old, old);
    }
    for (const p of [path.join(scratch, "ope100"), path.join(scratch, "ope101-wt"), store]) fs.utimesSync(p, old, old);
    const fetchState = async (id) => ({ ok: true, status: id === "OPE-100" ? "done" : "in_progress", closedAt: old.toISOString() });
    const options = { fetchState, gitActive: () => false };
    const plan = await scanBoardProjectWorkspaces(home, Date.now(), options);
    assert.equal(plan.filter((x) => x.action === "remove").length, 4);
    const journal = path.join(tmpDir, "board-gc.jsonl");
    await pruneBoardProjectWorkspaces(plan, journal, options);
    assert.equal(fs.existsSync(path.join(pack, "tmp_pack_old")), false);
    assert.equal(fs.existsSync(path.join(pack, "tmp_idx_old")), false);
    assert.equal(fs.existsSync(path.join(scratch, "ope100")), false);
    assert.equal(fs.existsSync(path.join(scratch, "ope101-wt")), true);
    assert.equal(fs.existsSync(store), false);
    assert.equal(fs.readFileSync(journal, "utf8").trim().split("\n").filter((line) => JSON.parse(line).event === "board-project-removed").length, 4);
    fs.writeFileSync(path.join(pack, "tmp_pack_busy"), "x");
    fs.utimesSync(path.join(pack, "tmp_pack_busy"), old, old);
    const busy = await scanBoardProjectWorkspaces(home, Date.now(), { ...options, gitActive: () => true });
    assert.equal(busy.find((x) => x.path.endsWith("tmp_pack_busy")).action, "keep");
  });

  it("keeps fresh nested files, recent closures, unknown issues and symlinked stores", async () => {
    const home = path.join(tmpDir, "home");
    const repo = path.join(home, "instances/default/projects/company/project/myrmidon");
    const scratch = path.join(repo, ".scratch");
    const outside = path.join(tmpDir, "outside");
    const old = new Date(Date.now() - 30 * 3600000);
    for (const name of ["ope100", "ope101", "ope102", "ope103"]) fs.mkdirSync(path.join(scratch, name), { recursive: true });
    fs.writeFileSync(path.join(scratch, "ope100", "fresh"), "active");
    for (const name of ["ope100", "ope101", "ope102", "ope103"]) fs.utimesSync(path.join(scratch, name), old, old);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(repo, ".paperclip"));
    fs.symlinkSync(outside, path.join(repo, ".paperclip", "pnpm-store"));
    const fetchState = async (id) => id === "OPE-102" ? { ok: false } : {
      ok: true, status: id === "OPE-103" ? "cancelled" : "done",
      closedAt: id === "OPE-101" ? new Date().toISOString() : old.toISOString(),
    };
    const plan = await scanBoardProjectWorkspaces(home, Date.now(), { fetchState, gitActive: () => false });
    const byName = Object.fromEntries(plan.map((item) => [path.basename(item.path), item]));
    assert.equal(byName.ope100.reason, "fresh");
    assert.equal(byName.ope101.reason, "issue-not-old-closed");
    assert.equal(byName.ope102.reason, "issue-not-old-closed");
    assert.equal(byName.ope103.action, "remove");
    assert.equal(byName["pnpm-store"], undefined);
  });

  it("rechecks issue status and git activity before deleting planned entries", async () => {
    const home = path.join(tmpDir, "home");
    const repo = path.join(home, "instances/default/projects/company/project/myrmidon");
    const scratch = path.join(repo, ".scratch/ope100");
    const pack = path.join(repo, ".git/objects/pack/tmp_pack_old");
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(pack, "x");
    const old = new Date(Date.now() - 30 * 3600000);
    fs.utimesSync(scratch, old, old);
    fs.utimesSync(pack, old, old);
    const options = { fetchState: async () => ({ ok: true, status: "done", closedAt: old.toISOString() }), gitActive: () => false };
    const plan = await scanBoardProjectWorkspaces(home, Date.now(), options);
    const journal = path.join(tmpDir, "race.jsonl");
    await pruneBoardProjectWorkspaces(plan, journal, { fetchState: async () => ({ ok: true, status: "in_progress" }), gitActive: () => true });
    assert.equal(fs.existsSync(scratch), true);
    assert.equal(fs.existsSync(pack), true);
    assert.equal(fs.readFileSync(journal, "utf8").trim().split("\n").filter((line) => JSON.parse(line).event === "board-project-kept").length, 2);
  });
});

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

describe("consumeGcRequest (OPE-13419)", () => {
  it("reads and removes the board's request file", () => {
    const file = path.join(tmpDir, "request.json");
    fs.writeFileSync(file, JSON.stringify({ reason: "disk_budget", freePercent: 9.1, requestedAt: "2026-11-16T03:00:00.000Z" }));
    assert.deepEqual(consumeGcRequest(file), { reason: "disk_budget", freePercent: 9.1, requestedAt: "2026-11-16T03:00:00.000Z" });
    assert.equal(fs.existsSync(file), false);
    assert.equal(consumeGcRequest(file), null, "a second pass finds nothing");
  });

  it("an unreadable request is still a request; no file or no path is none", () => {
    const file = path.join(tmpDir, "request.json");
    fs.writeFileSync(file, "{not json");
    assert.equal(consumeGcRequest(file)?.reason, "unknown");
    assert.equal(fs.existsSync(file), false);
    assert.equal(consumeGcRequest(null), null);
  });

  it("--request-file is parsed", () => {
    assert.equal(parseArgs(["node", "gc", "--request-file", "/x/r.json"]).requestFile, "/x/r.json");
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

describe("scratch-gc (BOT-DISK-SCRATCH)", () => {
  it("loadEnvConfig parses env file and overrides process.env", () => {
    const envFile = path.join(tmpDir, "host-gc.env");
    fs.writeFileSync(envFile, "SCRATCH_TTL_HOURS=18\n# comment\nOTHER_VAR='hello'\n");
    const cfg = loadEnvConfig(envFile);
    assert.equal(cfg.SCRATCH_TTL_HOURS, "18");
    assert.equal(cfg.OTHER_VAR, "hello");
  });

  it("parseArgs reads --scratch-ttl and --scratch-root", () => {
    const args = parseArgs([
      "node", "script.mjs",
      "--scratch-ttl", "18",
      "--scratch-root", "/tmp/bot1/scratch",
      "--scratch-root", "/tmp/bot2/scratch",
    ]);
    assert.equal(args.scratchTtlHours, 18);
    assert.deepEqual(args.scratchRoots, ["/tmp/bot1/scratch", "/tmp/bot2/scratch"]);
  });

  it("discoverBotScratchDirs finds <bot>/hermes/cache/scratch", () => {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(path.join(botsRoot, "bot-1/hermes/cache/scratch"), { recursive: true });
    fs.mkdirSync(path.join(botsRoot, "bot-2/hermes/cache/scratch"), { recursive: true });
    fs.mkdirSync(path.join(botsRoot, "bot-3/no-scratch"), { recursive: true });
    fs.mkdirSync(path.join(botsRoot, ".hidden/hermes/cache/scratch"), { recursive: true });

    const discovered = discoverBotScratchDirs(botsRoot);
    assert.equal(discovered.length, 2);
    assert.ok(discovered.includes(path.join(botsRoot, "bot-1/hermes/cache/scratch")));
    assert.ok(discovered.includes(path.join(botsRoot, "bot-2/hermes/cache/scratch")));
  });

  it("inspectPathTree returns latest mtime inside recursive directory tree", () => {
    const dir = path.join(tmpDir, "test-tree");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    const f1 = path.join(dir, "a.txt");
    const f2 = path.join(dir, "sub/b.txt");
    fs.writeFileSync(f1, "123");
    fs.writeFileSync(f2, "45678");

    const tOld = new Date(Date.now() - 20 * 3600 * 1000);
    const tNew = new Date(Date.now() - 5 * 3600 * 1000);
    fs.utimesSync(f1, tOld, tOld);
    fs.utimesSync(f2, tNew, tNew);
    fs.utimesSync(path.join(dir, "sub"), tOld, tOld);
    fs.utimesSync(dir, tOld, tOld);

    const info = inspectPathTree(dir);
    assert.equal(info.maxMtimeMs, tNew.getTime());
    assert.ok(info.totalSizeBytes >= 8); // at least 8 bytes for file contents
  });

  it("scanScratchDirectory handles fresh, stale, gh-cli-cache, and open processes", () => {
    const scratch = path.join(tmpDir, "scratch");
    fs.mkdirSync(scratch);

    const now = Date.now();
    const staleTime = new Date(now - 14 * 3600 * 1000);
    const freshTime = new Date(now - 2 * 3600 * 1000);

    // 1. Stale directory (> 12h)
    const staleDir = path.join(scratch, "myrmidon-migrate-123");
    fs.mkdirSync(path.join(staleDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(staleDir, "sub/file.txt"), "data");
    fs.utimesSync(path.join(staleDir, "sub/file.txt"), staleTime, staleTime);
    fs.utimesSync(path.join(staleDir, "sub"), staleTime, staleTime);
    fs.utimesSync(staleDir, staleTime, staleTime);

    // 2. Fresh directory (has 1 fresh file)
    const freshDir = path.join(scratch, "fresh-run-456");
    fs.mkdirSync(freshDir);
    fs.writeFileSync(path.join(freshDir, "new.txt"), "recent");
    fs.utimesSync(path.join(freshDir, "new.txt"), freshTime, freshTime);
    fs.utimesSync(freshDir, staleTime, staleTime);

    // 3. gh-cli-cache (protected)
    const ghCache = path.join(scratch, "gh-cli-cache");
    fs.mkdirSync(ghCache);
    fs.writeFileSync(path.join(ghCache, "token"), "tok");
    fs.utimesSync(path.join(ghCache, "token"), staleTime, staleTime);
    fs.utimesSync(ghCache, staleTime, staleTime);

    // 4. Stale directory open by process
    const openDir = path.join(scratch, "open-task-789");
    fs.mkdirSync(openDir);
    fs.writeFileSync(path.join(openDir, "active.log"), "busy");
    fs.utimesSync(path.join(openDir, "active.log"), staleTime, staleTime);
    fs.utimesSync(openDir, staleTime, staleTime);

    const openInfo = {
      openPaths: new Set([path.join(openDir, "active.log")]),
      openInodes: new Set(),
    };

    const results = scanScratchDirectory(scratch, now, 12, openInfo);

    const staleResult = results.find((r) => r.name === "myrmidon-migrate-123");
    assert.equal(staleResult.reason, "ttl");
    assert.ok(staleResult.sizeBytes > 0);

    const freshResult = results.find((r) => r.name === "fresh-run-456");
    assert.equal(freshResult.reason, "fresh");

    const ghResult = results.find((r) => r.name === "gh-cli-cache");
    assert.equal(ghResult.reason, "protected-gh-cli-cache");

    const openResult = results.find((r) => r.name === "open-task-789");
    assert.equal(openResult.reason, "open-by-process");
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

  function runGc(flags, extraEnv = {}) {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc.jsonl");
    const env = { ...process.env, HOST_GC_RUNNER_ROOTS: "", PATH: process.env.PATH, PAPERCLIP_API_URL: "http://127.0.0.1:9", ...extraEnv };
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

  it("retains an old runner tmp checkout with unpublished work", () => {
    const runners = path.join(tmpDir, "runners");
    const checkout = makeTmpEntry(runners, "eng17", "checkout", { ageHours: 48, dir: true });
    fs.mkdirSync(path.join(checkout, ".git"));
    fs.writeFileSync(path.join(checkout, ".git", "HEAD"), "unpublished");
    setAge(path.join(checkout, ".git", "HEAD"), 48);
    setAge(path.join(checkout, ".git"), 48);
    setAge(checkout, 48);
    const { res } = runGc(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.readFileSync(path.join(checkout, ".git", "HEAD"), "utf8"), "unpublished");
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

describe("stale OMP runner collection", () => {
  function runGc(flags, extraEnv = {}) {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc.jsonl");
    const env = { ...process.env, HOST_GC_RUNNER_ROOTS: "", PATH: process.env.PATH, PAPERCLIP_API_URL: "http://127.0.0.1:9", ...extraEnv };
    const res = subprocess.spawnSync(process.execPath, [
      path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs"), "--env", "/nonexistent", "--root", botsRoot,
      "--journal", journal, "--lock", path.join(tmpDir, "gc.lock"), "--proc-dir", path.join(tmpDir, "proc"), ...flags,
    ], { encoding: "utf8", env, timeout: 60_000 });
    const events = fs.existsSync(journal) ? fs.readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    return { res, events };
  }

  it("keeps eng10 on omp_local and marks switched or removed agents for cleanup", async () => {
    const root = path.join(tmpDir, "omp-runners");
    const plan = await planStaleOmpRunners(root, { docker: "docker-that-does-not-exist" });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, "docker-unavailable");
  });

  it("marks an absent agent for stale-runner cleanup", async () => {
    const dir = path.join(tmpDir, "docker-mock");
    fs.mkdirSync(dir);
    const docker = path.join(dir, "docker");
    fs.writeFileSync(docker, "#!/bin/sh\nprintf '%s\\n' myrmidon-omp-runner-eng10 myrmidon-omp-runner-gone\n");
    fs.chmodSync(docker, 0o755);
    const plan = await planStaleOmpRunners(path.join(tmpDir, "root"), {
      docker,
      fetchAdapter: async (agent) => ({ ok: true, adapterType: agent === "eng10" ? "omp_local" : null }),
    });
    assert.deepEqual(plan.plan.map((item) => [item.agentKey, item.action, item.reason]), [
      ["eng10", "keep", "omp-local"],
      ["gone", "stop-remove", "agent-deleted"],
    ]);
  });

  it("removes stale runner homes even after their containers were already removed", async () => {
    const dir = path.join(tmpDir, "docker-mock");
    fs.mkdirSync(dir);
    const docker = path.join(dir, "docker");
    fs.writeFileSync(docker, "#!/bin/sh\nprintf ''\n");
    fs.chmodSync(docker, 0o755);
    const root = path.join(tmpDir, "omp-runners");
    fs.mkdirSync(path.join(root, "eng8", "home", "wt"), { recursive: true });
    const plan = await planStaleOmpRunners(root, {
      docker,
      fetchAdapter: async () => ({ ok: true, adapterType: "hermes_gateway" }),
    });
    assert.deepEqual(plan.plan.map((item) => [item.agentKey, item.action]), [["eng8", "remove-stale-home"]]);
    const boardScript = [
      "const http = require('node:http');",
      "const server = http.createServer((_req, res) => {",
      "  res.writeHead(200, { 'Content-Type': 'application/json' });",
      "  res.end(JSON.stringify([{ id: 'agent-uuid-8', name: 'adm-dev-eng-8', adapterType: 'hermes_gateway' }]));",
      "});",
      "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
    ].join("\n");
    const board = subprocess.spawn(process.execPath, ["-e", boardScript], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((resolve, reject) => {
      board.stdout.once("data", (chunk) => resolve(chunk.toString().trim()));
      board.once("error", reject);
      board.once("exit", (code) => reject(new Error(`board fixture exited: ${code}`)));
    });
    let result;
    try {
      result = runGc(["--apply", "--runner-root", root], {
        PATH: `${dir}:${process.env.PATH}`,
        MYRMIDON_HOST_GC_DOCKER: docker,
        MYRMIDON_HOST_GC_DOCKER_BOT: docker,
        MYRMIDON_COMPANY_ID: "company-uuid",
        BOARD_API_URL: `http://127.0.0.1:${port}`,
      });
    } finally {
      board.kill();
    }
    assert.equal(result.res.status, 0, result.res.stderr);
    assert.equal(fs.existsSync(path.join(root, "eng8")), false);
    assert.ok(result.events.some((event) => event.event === "stale-omp-runner-root-removed" && event.name === "myrmidon-omp-runner-eng8"));
  });

  it("parses runner keys and fails closed when board adapter lookup is unavailable", async () => {
    const dir = path.join(tmpDir, "docker-mock");
    fs.mkdirSync(dir);
    const docker = path.join(dir, "docker");
    fs.writeFileSync(docker, "#!/bin/sh\nprintf '%s\\n' myrmidon-omp-runner-eng10 myrmidon-omp-runner-eng8 not-a-runner myrmidon-omp-runner-../bad\n");
    fs.chmodSync(docker, 0o755);
    assert.deepEqual(listOmpRunnerContainers({ docker }), { ok: true, names: ["myrmidon-omp-runner-eng10", "myrmidon-omp-runner-eng8"] });
    const plan = await planStaleOmpRunners(path.join(tmpDir, "root"), {
      docker,
      fetchAdapter: async () => ({ ok: false, reason: "board-unavailable" }),
    });
    assert.ok(plan.plan.every((item) => item.action === "keep" && item.reason === "board-unavailable"));
  });

  it("recognizes the active omp_local agent without treating it as stale", async () => {
    const dir = path.join(tmpDir, "docker-mock");
    fs.mkdirSync(dir);
    const docker = path.join(dir, "docker");
    fs.writeFileSync(docker, "#!/bin/sh\nprintf '%s\\n' myrmidon-omp-runner-eng10 myrmidon-omp-runner-eng8\n");
    fs.chmodSync(docker, 0o755);
    const plan = await planStaleOmpRunners(path.join(tmpDir, "root"), {
      docker,
      fetchAdapter: async (agent) => ({ ok: true, adapterType: agent === "eng10" ? "omp_local" : "hermes_gateway" }),
    });
    assert.deepEqual(plan.plan.map((item) => [item.agentKey, item.action, item.reason]), [
      ["eng10", "keep", "omp-local"],
      ["eng8", "stop-remove", "adapter-changed"],
    ]);
  });

  it("fails closed on board errors", async () => {
    const previousCompanyId = process.env.MYRMIDON_COMPANY_ID;
    process.env.MYRMIDON_COMPANY_ID = "company-uuid";
    let unavailable;
    try {
      unavailable = await fetchAgentAdapter("eng8", { baseUrl: "http://board", fetchImpl: async () => { throw new Error("offline"); } });
    } finally {
      if (previousCompanyId === undefined) delete process.env.MYRMIDON_COMPANY_ID;
      else process.env.MYRMIDON_COMPANY_ID = previousCompanyId;
    }
    assert.deepEqual(unavailable, { ok: false, reason: "board-unavailable" });
  });

  it("does not query agents when the host GC company id is unset", async () => {
    const previousCompanyId = process.env.MYRMIDON_COMPANY_ID;
    delete process.env.MYRMIDON_COMPANY_ID;
    try {
      const result = await fetchAgentAdapter("eng8", {
        baseUrl: "http://board",
        fetchImpl: async () => { throw new Error("must not call board without company id"); },
      });
      assert.deepEqual(result, { ok: false, reason: "company-id-missing" });
    } finally {
      if (previousCompanyId !== undefined) process.env.MYRMIDON_COMPANY_ID = previousCompanyId;
    }
  });

  it("rejects unsafe agent ids without a board call", async () => {
    const result = await fetchAgentAdapter("../etc", { baseUrl: "http://board", fetchImpl: async () => { throw new Error("must not be called"); } });
    assert.deepEqual(result, { ok: false, reason: "bad-agent-id" });
  });

  it("--apply stops the stale runner, removes its workspace/home/tmp, preserves eng10 and reports count", async () => {
    const root = path.join(tmpDir, "omp-runners");
    const old = path.join(root, "eng8", "home", "wt", "OPE-12845");
    const active = path.join(root, "eng10", "home", "wt", "OPE-12900");
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(old, "ghcred.json"), "sensitive");
    const dir = path.join(tmpDir, "docker");
    fs.mkdirSync(dir);
    const docker = path.join(dir, "docker");
    const calls = path.join(dir, "calls");
    fs.writeFileSync(docker, `#!/bin/sh\nif [ "$1" = ps ]; then printf '%s\\n' myrmidon-omp-runner-eng8 myrmidon-omp-runner-eng10; else printf '%s\\n' "$@" >> '${calls}'; fi\n`);
    fs.chmodSync(docker, 0o755);
    const boardScript = [
      "const http = require('node:http');",
      "const server = http.createServer((req, res) => {",
      "  const agents = [{ id: 'agent-uuid-8', name: 'adm-dev-eng-8', adapterType: 'hermes_gateway' }, { id: 'agent-uuid-10', name: 'adm-dev-eng-10', adapterType: 'omp_local' }];",
      "  res.writeHead(200, { 'Content-Type': 'application/json' });",
      "  res.end(JSON.stringify(agents.filter((agent) => req.url.includes(agent.name))));",
      "});",
      "server.listen(0, '127.0.0.1', () => console.log(server.address().port));",
    ].join("\n");
    const board = subprocess.spawn(process.execPath, ["-e", boardScript], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((resolve, reject) => {
      board.stdout.once("data", (chunk) => resolve(chunk.toString().trim()));
      board.once("error", reject);
      board.once("exit", (code) => reject(new Error(`board fixture exited: ${code}`)));
    });
    const envOverrides = { PATH: `${dir}:${process.env.PATH}`, MYRMIDON_HOST_GC_DOCKER: docker, BOARD_API_URL: `http://127.0.0.1:${port}`, MYRMIDON_HOST_GC_DOCKER_BOT: docker, MYRMIDON_COMPANY_ID: "company-uuid" };
    let result;
    try {
      result = runGc(["--apply", "--runner-root", root], envOverrides);
    } finally {
      board.kill();
    }
    const { res, events } = result;
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(path.join(root, "eng8", "home")), false);
    assert.equal(fs.existsSync(active), true);
    assert.equal(fs.existsSync(path.join(old, "ghcred.json")), false);
    const complete = events.find((event) => event.event === "apply-complete");
    assert.equal(complete.staleOmpRunnersStopped, 1);
  });

  it("resolves engN through the slim company list and plans only non-omp_local runners for removal", async () => {
    const previousCompanyId = process.env.MYRMIDON_COMPANY_ID;
    process.env.MYRMIDON_COMPANY_ID = "company-uuid";
    const requests = [];
    try {
      const adapter = await fetchAgentAdapter("eng8", {
        baseUrl: "http://board",
        apiKey: "test-key",
        fetchImpl: async (url, options) => {
          requests.push({ url, options });
          if (url === "http://board/api/agents/eng8") return { ok: false, status: 422 };
          assert.equal(url, "http://board/api/companies/company-uuid/agents?q=adm-dev-eng-8");
          return { ok: true, status: 200, json: async () => [{ id: "agent-uuid-8", name: "adm-dev-eng-8", adapterType: "hermes_gateway" }] };
        },
      });
      assert.deepEqual(adapter, { ok: true, adapterType: "hermes_gateway" });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].options.headers.Authorization, "Bearer test-key");

      const dir = path.join(tmpDir, "docker-mock");
      fs.mkdirSync(dir);
      const docker = path.join(dir, "docker");
      fs.writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' myrmidon-omp-runner-eng8 myrmidon-omp-runner-eng10\n`);
      fs.chmodSync(docker, 0o755);
      const plan = await planStaleOmpRunners(path.join(tmpDir, "runners"), {
        docker,
        fetchAdapter: async (agentKey) => ({ ok: true, adapterType: agentKey === "eng10" ? "omp_local" : adapter.adapterType }),
      });
      assert.deepEqual(plan.plan.map(({ agentKey, action, reason }) => [agentKey, action, reason]), [
        ["eng8", "stop-remove", "adapter-changed"],
        ["eng10", "keep", "omp-local"],
      ]);
    } finally {
      if (previousCompanyId === undefined) delete process.env.MYRMIDON_COMPANY_ID;
      else process.env.MYRMIDON_COMPANY_ID = previousCompanyId;
    }
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
    // Identity goes on argv (-c): a PATH `git` that is a launcher wrapper may strip
    // GIT_AUTHOR_*/GIT_COMMITTER_* from the environment, argv config survives.
    const git = (args, cwd2 = dir) => {
      const r = subprocess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: cwd2, encoding: "utf8", env: GIT_ENV });
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
  function runGc(flags, extraEnv = {}) {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc.jsonl");
    const env = { ...process.env, HOST_GC_RUNNER_ROOTS: "", PATH: process.env.PATH, PAPERCLIP_API_URL: "http://127.0.0.1:9", ...extraEnv };
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

// myrmidon(1.6.8 OPE-12855): task folders of runner issues are GC'd when the issue is
// done/cancelled and the folder is older than the clone TTL; the board is fail-closed.
// myrmidon(1.6.8 OPE-12855): npm/npx caches of runner agents are pruned under the same
// runner root gate as the run copies and the task folders.
describe("runner npm caches", () => {
  const HOUR = 60 * 60 * 1000;
  const GC_SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");

  // The TTL is judged by the newest mtime in the cache tree, so every mtime is backdated
  // first and `freshMarker` writes a new file afterwards: a cache still being written by a
  // live npm/npx call is `fresh` regardless of how old the cache root itself is.
  const backdate = (dir, ageHours) => {
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(dir, t, t);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) backdate(p, ageHours);
      else fs.utimesSync(p, t, t);
    }
  };
  const makeNpmCache = (runnersRoot, runner, name, { ageHours = 5, freshMarker = false } = {}) => {
    const cacheDir = path.join(runnersRoot, runner, "home", ".npm", name);
    if (name === "_npx") {
      const pkg = path.join(cacheDir, "hash123", "node_modules", "pkg");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, "index.js"), "module");
    } else {
      fs.mkdirSync(path.join(cacheDir, "content-v2"), { recursive: true });
      fs.writeFileSync(path.join(cacheDir, "content-v2", "blob"), "x");
    }
    backdate(cacheDir, ageHours);
    if (freshMarker) {
      const marker = path.join(cacheDir, "index-v5", "recent");
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, "wip");
    }
    return cacheDir;
  };

  it("marks caches whose newest tree mtime is older than the TTL", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeNpmCache(runners, "eng24", "_cacache", { ageHours: 5 });
    const fresh = makeNpmCache(runners, "eng24", "_npx", { ageHours: 5, freshMarker: true });
    const items = scanRunnerNpmCaches(runners, Date.now(), 4);
    const byPath = Object.fromEntries(items.map((i) => [i.path, i.reason]));
    assert.equal(byPath[old], "ttl");
    assert.equal(byPath[fresh], "fresh");
    assert.equal(items.length, 2);
  });

  it("walks both _cacache and _npx and carries the cache kind", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const cacache = makeNpmCache(runners, "eng24", "_cacache", { ageHours: 5 });
    const npx = makeNpmCache(runners, "eng24", "_npx", { ageHours: 5 });
    const items = scanRunnerNpmCaches(runners, Date.now(), 4);
    assert.deepEqual(items.map((i) => [i.path, i.kind]), [
      [cacache, "_cacache"],
      [npx, "_npx"],
    ]);
  });

  it("a runner without npm caches yields nothing", () => {
    const runners = path.join(tmpDir, "omp-runners");
    fs.mkdirSync(path.join(runners, "eng24", "home"), { recursive: true });
    fs.mkdirSync(path.join(runners, "eng24", "workspace"), { recursive: true });
    assert.deepEqual(scanRunnerNpmCaches(runners, Date.now(), 4), []);
  });

  it("a symlinked cache directory is skipped, not followed", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const outside = path.join(tmpDir, "outside");
    const victimCache = makeNpmCache(outside, "victim", "_cacache", { ageHours: 5 });
    fs.mkdirSync(path.join(runners, "eng24", "home", ".npm"), { recursive: true });
    fs.symlinkSync(victimCache, path.join(runners, "eng24", "home", ".npm", "_cacache"));
    assert.deepEqual(scanRunnerNpmCaches(runners, Date.now(), 4), []);
    assert.equal(fs.existsSync(path.join(victimCache, "content-v2", "blob")), true);
  });

  it("a missing root and a file root are reported and yield nothing", () => {
    const events = [];
    const missing = path.join(tmpDir, "nope");
    assert.deepEqual(scanRunnerNpmCaches(missing, Date.now(), 4, { onEvent: (e) => events.push(e) }), []);
    const notDir = path.join(tmpDir, "file-root");
    fs.writeFileSync(notDir, "x");
    assert.deepEqual(scanRunnerNpmCaches(notDir, Date.now(), 4, { onEvent: (e) => events.push(e) }), []);
    assert.deepEqual(events[0], { event: "runner-npm-cache-root-missing", root: missing });
    assert.equal(events[1].event, "runner-npm-cache-scan-failed");
    assert.equal(events[1].root, notDir);
    assert.match(events[1].error, /not a directory/);
  });

  it("parseArgs reads --npm-cache-ttl, MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS and defaults to 4", () => {
    const prev = process.env.MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS;
    process.env.MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS = "6";
    try {
      const fromEnv = parseArgs(["node", "gc", "--env", "/nonexistent"]);
      assert.equal(fromEnv.npmCacheTtlHours, 6);
    } finally {
      if (prev === undefined) delete process.env.MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS;
      else process.env.MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS = prev;
    }
    const fromFlag = parseArgs(["node", "gc", "--env", "/nonexistent", "--npm-cache-ttl", "8"]);
    assert.equal(fromFlag.npmCacheTtlHours, 8);
    assert.equal(parseArgs(["node", "gc", "--env", "/nonexistent"]).npmCacheTtlHours, 4);
  });

  it("rejects an --npm-cache-ttl that is not a finite number or is below 1 hour", () => {
    for (const bad of ["abc", "", "NaN", "Infinity", "-5", "0", "0.9"]) {
      assert.throws(
        () => parseArgs(["node", "gc", "--env", "/nonexistent", "--npm-cache-ttl", bad]),
        (err) => err instanceof UsageError && /--npm-cache-ttl must be/.test(err.message),
        `ttl ${JSON.stringify(bad)} must be refused`,
      );
    }
    assert.throws(() => parseArgs(["node", "gc", "--env", "/nonexistent", "--npm-cache-ttl"]), UsageError, "a missing value");
    assert.equal(parseArgs(["node", "gc", "--env", "/nonexistent", "--npm-cache-ttl", "1"]).npmCacheTtlHours, 1);
    assert.equal(parseArgs(["node", "gc", "--env", "/nonexistent", "--npm-cache-ttl", "1.5"]).npmCacheTtlHours, 1.5);
  });

  // Async spawn: the task-folder suite of this file runs a fake-board HTTP server in this
  // same process, and a sync spawn would block the event loop the server needs.
  const runGcNpm = async (flags) => {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc-npm.jsonl");
    const env = { ...GIT_ENV, HOST_GC_RUNNER_ROOTS: "", PATH: "/usr/bin:/bin", PAPERCLIP_API_URL: "http://127.0.0.1:9" };
    const res = await new Promise((resolve, reject) => {
      const child = subprocess.spawn(process.execPath, [
        GC_SCRIPT, "--env", "/nonexistent", "--root", botsRoot,
        "--journal", journal, "--lock", path.join(tmpDir, "gc-npm.lock"), "--proc-dir", path.join(tmpDir, "proc"),
        ...flags,
      ], { env, timeout: 120_000, killSignal: "SIGKILL" });
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

  it("e2e: --apply removes old caches, keeps a cache being written, journals sizeBytes", async () => {
    const runners = path.join(tmpDir, "omp-runners");
    const oldCacache = makeNpmCache(runners, "eng24", "_cacache", { ageHours: 5 });
    const oldNpx = makeNpmCache(runners, "eng24", "_npx", { ageHours: 5 });
    const freshCacache = makeNpmCache(runners, "eng25", "_cacache", { ageHours: 5, freshMarker: true });
    const { res, events } = await runGcNpm(["--apply", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(oldCacache), false, "old _cacache must be removed");
    assert.equal(fs.existsSync(oldNpx), false, "old _npx must be removed");
    assert.equal(fs.existsSync(freshCacache), true, "a cache being written must stay");
    const removed = events.find((e) => e.event === "runner-npm-cache-removed" && e.path === oldCacache);
    assert.ok(removed, "removal journaled");
    assert.equal(removed.kind, "_cacache");
    assert.equal(typeof removed.sizeBytes, "number", "size measured before the removal");
    assert.ok(removed.sizeBytes > 0);
    assert.ok(events.some((e) => e.event === "runner-npm-cache-removed" && e.kind === "_npx"));
    assert.equal(events.find((e) => e.event === "apply-complete").runnerNpmCachesRemoved, 2);
    assert.equal(JSON.parse(res.stdout).runnerNpmCachesRemoved, 2);
  });

  it("e2e: dry-run removes nothing and lists the plan", async () => {
    const runners = path.join(tmpDir, "omp-runners");
    const oldCacache = makeNpmCache(runners, "eng24", "_cacache", { ageHours: 5 });
    const { res, events } = await runGcNpm(["--dry-run", "--runner-root", runners]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(fs.existsSync(oldCacache), true, "dry-run must not remove");
    assert.equal(events.find((e) => e.event === "dry-run").runnerNpmCaches, 1);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(out.plan.runnerNpmCaches.map((i) => [i.path, i.action]), [[oldCacache, "remove"]]);
  });

  it("e2e: --apply without a runner root leaves the npm pass off", async () => {
    const { res } = await runGcNpm(["--apply"]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).runnerNpmCachesRemoved, 0);
  });

  it("a .npm swapped for a symlink after the scan is not deleted through", () => {
    const runners = path.join(tmpDir, "omp-runners");
    const old = makeNpmCache(runners, "eng24", "_cacache", { ageHours: 5 });
    const items = scanRunnerNpmCaches(runners, Date.now(), 4).filter((i) => i.reason === "ttl");
    assert.equal(items.length, 1);
    assert.equal(items[0].runnersRoot, runners, "the item carries the root the drop is guarded against");

    const outsideCache = makeNpmCache(path.join(tmpDir, "outside"), "victim", "_cacache", { ageHours: 5 });
    fs.renameSync(path.join(runners, "eng24", "home", ".npm"), path.join(tmpDir, "moved-npm"));
    fs.symlinkSync(path.join(outsideCache, "..", ".."), path.join(runners, "eng24", "home", ".npm"));

    const journal = path.join(tmpDir, "gc-npm.jsonl");
    const gone = pruneRunnerNpmCaches(items, journal);
    assert.deepEqual(gone, [], "nothing counted as removed");
    assert.equal(fs.existsSync(path.join(outsideCache, "content-v2", "blob")), true, "the outside cache must survive");
    const events = fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const failed = events.filter((e) => e.event === "runner-npm-cache-remove-failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].path, old);
    assert.match(failed[0].error, /symlink not allowed/);
  });
});

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

  it("a folder younger than the idle gate is not even asked to the board", async () => {
    const runners = path.join(tmpDir, "runners");
    makeTaskFolder(runners, "eng21", "OPE-12855", { ageHours: 0.1 });
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

  // --- Folders of tasks under review (idle-open rule) ---------------------------
  const MIN = 60 * 1000;
  // Ages a folder as the idle rule sees it: the folder, its top-level entries, those of `repo/`
  // and the HEAD files of the git directory (`.git` itself is not looked at).
  const ageFolder = (dir, hours) => {
    const t = new Date(Date.now() - hours * HOUR);
    const touch = (p) => { try { fs.utimesSync(p, t, t); } catch { /* absent */ } };
    for (const d of [dir, path.join(dir, "repo")]) {
      touch(d);
      try { for (const e of fs.readdirSync(d)) if (e !== ".git") touch(path.join(d, e)); } catch { /* none */ }
      touch(path.join(d, ".git", "HEAD"));
      touch(path.join(d, ".git", "logs", "HEAD"));
    }
    touch(dir);
  };
  const scanOpen = (runnersRoot, state) =>
    scanRunnerTaskFolders(runnersRoot, Date.now(), 24, { fetchStatus: async () => state, onEvent: () => {} });
  const idleFolder = (runners, name = "OPE-5001", opts = {}) => {
    const folder = makeTaskFolder(runners, "eng10", name, { ageHours: 1, ...opts });
    ageFolder(folder, 1);
    return folder;
  };

  for (const status of ["in_review", "blocked", "backlog"]) {
    it(`a clean pushed ${status} folder, idle for an hour and with no live run, is removed before the clone TTL`, async () => {
      const runners = path.join(tmpDir, "runners");
      const folder = idleFolder(runners);
      const items = await scanOpen(runners, { ok: true, status, liveRunIds: [] });
      assert.deepEqual(items.map((i) => [i.path, i.action, i.reason, i.idleOpen]), [[folder, "remove", "clean-pushed", true]]);
    });
  }

  it("a folder of a task under review with a live run is kept", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = idleFolder(runners);
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: ["run-1"] });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "live-run"]]);
  });

  it("a folder of a task under review younger than 30 minutes is kept", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeTaskFolder(runners, "eng10", "OPE-5001", { ageHours: 0.25 });
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    assert.deepEqual(items.map((i) => [i.path, i.action]), [[folder, "keep"]]);
  });

  it("a folder whose own mtime is old but whose files changed a minute ago is kept as fresh", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = idleFolder(runners);
    const t = new Date(Date.now() - MIN);
    fs.utimesSync(path.join(folder, "repo", "f.txt"), t, t);
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "fresh"]]);
  });

  for (const status of ["in_progress", "todo"]) {
    it(`a ${status} folder is never touched, old or not`, async () => {
      const runners = path.join(tmpDir, "runners");
      const folder = idleFolder(runners);
      const young = await scanOpen(runners, { ok: true, status, liveRunIds: [] });
      assert.deepEqual(young.map((i) => [i.path, i.action]), [[folder, "keep"]]);
      ageFolder(folder, 48);
      const old = await scanOpen(runners, { ok: true, status, liveRunIds: [] });
      assert.deepEqual(old.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", `issue-status:${status}`]]);
    });
  }

  it("an unreachable board keeps a young folder and does not fail the scan", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = idleFolder(runners);
    const items = await scanOpen(runners, { ok: false, reason: "board-unavailable" });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "keep", "retention"]]);
  });

  it("unpushed or dirty work of a task under review goes to the archive, not away", async () => {
    const runners = path.join(tmpDir, "runners");
    const unpushed = idleFolder(runners, "OPE-5001", { ahead: true });
    const dirty = idleFolder(runners, "OPE-5002", { dirty: true });
    ageFolder(dirty, 1);
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    const byPath = Object.fromEntries(items.map((i) => [i.path, [i.action, i.reason]]));
    assert.deepEqual(byPath[unpushed], ["archive-remove", "unsafe-archive"]);
    assert.deepEqual(byPath[dirty], ["archive-remove", "unsafe-archive"]);
  });

  // A worktree of a run copy: `.git` says `gitdir: /workspace/...`, a path inside the runner container.
  const makeContainerWorktree = (runners, name, { ahead = false, dropRun = false } = {}) => {
    const ws = path.join(runners, "eng10", "workspace");
    const run = path.join(ws, ".paperclip-runtime", "runs", "r1", "workspace");
    makeRepo(run);
    const folder = path.join(ws, name);
    const g = (args, cwd2) => {
      const r = subprocess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: cwd2, encoding: "utf8", env: GIT_ENV });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    g(["worktree", "add", "-q", "--detach", folder], run);
    if (ahead) {
      fs.writeFileSync(path.join(folder, "f.txt"), "one\ntwo\n");
      g(["commit", "-qam", "two"], folder);
    }
    fs.writeFileSync(path.join(folder, ".git"), `gitdir: /workspace/.paperclip-runtime/runs/r1/workspace/.git/worktrees/${path.basename(folder)}\n`);
    const admin = path.join(run, ".git", "worktrees", path.basename(folder));
    const old = new Date(Date.now() - HOUR);
    for (const f of ["HEAD", path.join("logs", "HEAD")]) { try { fs.utimesSync(path.join(admin, f), old, old); } catch { /* none */ } }
    if (dropRun) fs.rmSync(path.join(ws, ".paperclip-runtime"), { recursive: true, force: true });
    ageFolder(folder, 1);
    return folder;
  };

  it("a worktree whose .git names a container path is mapped to the runner root and checked for real", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeContainerWorktree(runners, "OPE-5001");
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "remove", "clean-pushed"]]);
  });

  it("a mapped worktree with an unpushed commit is archived, not removed", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeContainerWorktree(runners, "OPE-5001", { ahead: true });
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a worktree whose container path no longer exists on the host is archived", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeContainerWorktree(runners, "OPE-5001", { dropRun: true });
    const items = await scanOpen(runners, { ok: true, status: "in_review", liveRunIds: [] });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "archive-remove", "unsafe-archive"]]);
  });

  it("a done task's container worktree is mapped too", async () => {
    const runners = path.join(tmpDir, "runners");
    const folder = makeContainerWorktree(runners, "OPE-5001");
    ageFolder(folder, 48);
    const items = await scanRunnerTaskFolders(runners, Date.now(), 24, { fetchStatus: async () => ({ ok: true, status: "done" }), onEvent: () => {} });
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[folder, "remove", "clean-pushed"]]);
  });

  describe("runnerFolderKeepReason (the check just before a removal)", () => {
    const item = (runners, folder) => ({ idleOpen: true, identifier: "OPE-5001", path: folder, runnerWorkspace: path.join(runners, "eng10", "workspace") });
    it("lets an idle folder go and keeps it once the task moved on, a run started or a file changed", async () => {
      const runners = path.join(tmpDir, "runners");
      const folder = idleFolder(runners);
      const it1 = item(runners, folder);
      const ask = (state) => runnerFolderKeepReason(it1, Date.now(), { fetchStatus: async () => state });
      assert.equal(await ask({ ok: true, status: "in_review", liveRunIds: [] }), null);
      assert.equal(await ask({ ok: true, status: "in_progress", liveRunIds: [] }), "issue-status:in_progress");
      assert.equal(await ask({ ok: true, status: "in_review", liveRunIds: ["r"] }), "live-run");
      assert.equal(await ask({ ok: false, reason: "board-unavailable" }), "board-unavailable");
      fs.writeFileSync(path.join(folder, "repo", "new.txt"), "x\n");
      assert.equal(await ask({ ok: true, status: "in_review", liveRunIds: [] }), "fresh");
    });
    it("does not ask about a closed-task item", async () => {
      assert.equal(await runnerFolderKeepReason({ identifier: "OPE-1", path: "/x" }, Date.now(), { fetchStatus: async () => { throw new Error("no"); } }), null);
    });
  });

  it("e2e: --apply removes the idle folder of a task under review and keeps the one with a live run", async () => {
    const runners = path.join(tmpDir, "runners");
    const idle = idleFolder(runners, "OPE-9101");
    const live = idleFolder(runners, "OPE-9102");
    const working = idleFolder(runners, "OPE-9103");
    const http = await import("node:http");
    const issues = {
      "OPE-9101": { status: "in_review" },
      "OPE-9102": { status: "in_review", executionRunId: "run-live" },
      "OPE-9103": { status: "in_progress" },
    };
    const fake = http.createServer((req, res) => {
      const m = /\/api\/issues\/([^/?]+)/.exec(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify((m && issues[decodeURIComponent(m[1])]) || { status: "todo" }));
    });
    await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
    try {
      const { res, events } = await runGcTask(["--apply", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${fake.address().port}` });
      assert.equal(res.status, 0, res.stderr);
      assert.equal(fs.existsSync(idle), false, "idle folder of a task under review must be removed");
      assert.equal(fs.existsSync(live), true, "a live run keeps the folder");
      assert.equal(fs.existsSync(working), true, "in_progress keeps the folder");
      const removed = events.find((e) => e.event === "runner-task-folder-removed" && e.path === idle);
      assert.equal(removed?.idleOpenStatus, "in_review");
      assert.ok(events.some((e) => e.event === "runner-task-folder-skipped" && e.path === live && e.reason === "live-run"));
    } finally {
      await new Promise((resolve) => fake.close(resolve));
    }
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
        GC_SCRIPT, "--env", "/nonexistent", "--root", botsRoot,
        "--journal", journal, "--lock", path.join(tmpDir, "gc-task.lock"), "--proc-dir", path.join(tmpDir, "proc"),
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
    const typoDir = path.join(runners, "eng21", "workspace", "OPR-9001");
    fs.mkdirSync(typoDir, { recursive: true });
    const typoT = new Date(Date.now() - 30 * 60 * 60 * 1000);
    fs.utimesSync(typoDir, typoT, typoT);
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
      assert.equal(done.runnerUnrecognized, 1);
      assert.ok(events.some((e) => e.event === "runner-unrecognized-workspace-folder" && e.name === "OPR-9001"));
      assert.ok(fs.existsSync(typoDir), "typo folder must survive --apply (report-only)");
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
    const gcJournal = fs.readFileSync(path.join(tmpDir, "gc-task.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(gcJournal.some((e) => e.event === "archive-full-fallback" && e.path === folder), "the compact-archive blocker is journaled");
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
        MYRMIDON_COMPANY_ID: "company-uuid",
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
    const typoDir = path.join(runners, "eng21", "workspace", "OPR-9201");
    fs.mkdirSync(typoDir, { recursive: true });
    const t = new Date(Date.now() - 30 * 60 * 60 * 1000);
    fs.utimesSync(typoDir, t, t);
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
      assert.equal(out.plan.runnerUnrecognized.length, 1);
      assert.equal(out.plan.runnerUnrecognized[0].name, "OPR-9201");
      assert.equal(out.plan.runnerUnrecognized[0].action, "report");
      assert.ok(events.some((e) => e.event === "runner-unrecognized-workspace-folder" && e.name === "OPR-9201"));
      assert.ok(fs.existsSync(typoDir), "typo folder must survive the dry-run");
    } finally {
      fake.close();
    }
  });
});

describe("runner unrecognized workspace folders (OPE-13018)", () => {
  const HOUR = 60 * 60 * 1000;

  const makeWorkspaceFolder = (runnersRoot, runner, name, { ageHours = 48 } = {}) => {
    const dir = path.join(runnersRoot, runner, "workspace", name);
    fs.mkdirSync(dir, { recursive: true });
    const t = new Date(Date.now() - ageHours * HOUR);
    fs.utimesSync(dir, t, t);
    return dir;
  };

  it("reports an old folder with a typo'd name and never deletes it", () => {
    const runners = path.join(tmpDir, "runners");
    const typo = makeWorkspaceFolder(runners, "eng21", "OPR-12962", { ageHours: 48 });
    const items = scanRunnerUnrecognizedWorkspaceFolders(runners, Date.now(), 24);
    assert.deepEqual(items.map((i) => [i.path, i.action, i.reason]), [[typo, "report", "unrecognized-ttl"]]);
    assert.ok(fs.existsSync(typo), "report-only: the folder must stay on disk");
  });

  it("does not report recognized task folders or the runtime directory", () => {
    const runners = path.join(tmpDir, "runners");
    makeWorkspaceFolder(runners, "eng21", "OPE-12962", { ageHours: 48 });
    makeWorkspaceFolder(runners, "eng21", "OPE-12962-wt", { ageHours: 48 });
    fs.mkdirSync(path.join(runners, "eng21", "workspace", ".paperclip-runtime"), { recursive: true });
    const items = scanRunnerUnrecognizedWorkspaceFolders(runners, Date.now(), 24);
    assert.deepEqual(items, []);
  });

  it("does not report a fresh unrecognized folder (the agent may still be in it)", () => {
    const runners = path.join(tmpDir, "runners");
    makeWorkspaceFolder(runners, "eng21", "scratch-pad", { ageHours: 1 });
    const items = scanRunnerUnrecognizedWorkspaceFolders(runners, Date.now(), 24);
    assert.deepEqual(items.map((i) => i.reason), ["unrecognized-fresh"]);
  });

  it("skips dot-directories and files", () => {
    const runners = path.join(tmpDir, "runners");
    fs.mkdirSync(path.join(runners, "eng21", "workspace", ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(runners, "eng21", "workspace", "notes.txt"), "x");
    const items = scanRunnerUnrecognizedWorkspaceFolders(runners, Date.now(), 24);
    assert.deepEqual(items, []);
  });

  it("a missing root and a file root are reported and yield nothing", () => {
    const events = [];
    const missing = path.join(tmpDir, "nope");
    assert.deepEqual(scanRunnerUnrecognizedWorkspaceFolders(missing, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    const notDir = path.join(tmpDir, "file-root");
    fs.writeFileSync(notDir, "x");
    assert.deepEqual(scanRunnerUnrecognizedWorkspaceFolders(notDir, Date.now(), 24, { onEvent: (e) => events.push(e) }), []);
    assert.deepEqual(events[0], { event: "runner-folder-root-missing", root: missing });
    assert.equal(events[1].event, "runner-unrecognized-scan-failed");
    assert.equal(events[1].root, notDir);
    assert.match(events[1].error, /not a directory/);
  });

  it("a symlinked runner is skipped", () => {
    const runners = path.join(tmpDir, "runners");
    const outside = path.join(tmpDir, "outside");
    makeWorkspaceFolder(outside, "victim", "OPR-1");
    fs.mkdirSync(runners, { recursive: true });
    fs.symlinkSync(path.join(outside, "victim"), path.join(runners, "eng8"));
    const items = scanRunnerUnrecognizedWorkspaceFolders(runners, Date.now(), 24);
    assert.deepEqual(items, []);
  });
});

describe("idle clones of open tasks (OPE-13411)", () => {
  const HOUR = 60 * 60 * 1000;
  const SCRIPT = path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs");
  const git = (args, cwd) => {
    const r = subprocess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  const plenty = () => ({ blocks: 1000, bavail: 500 });
  const low = () => ({ blocks: 1000, bavail: 50 });

  // A bot: <tmp>/agent/{workspace, hermes/.myrmidon/git-base/o/r.git} and a bare "server" the git-base
  // fetches from (served over git:// by the test daemon, so it counts as a server and not a local path).
  const makeBot = () => {
    const server = path.join(tmpDir, "server.git");
    git(["init", "-q", "--bare", "-b", "main", server]);
    const seed = path.join(tmpDir, "seed");
    git(["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "one"], seed);
    git(["push", "-q", server, "main"], seed);
    const agent = path.join(tmpDir, "agent");
    const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    git(["clone", "-q", "--bare", server, base]);
    const workspace = path.join(agent, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    return { server, agent, base, workspace };
  };

  // A linked worktree of the git-base on its own branch, one commit ahead of main; pushed or not.
  const addClone = (bot, name, { pushed = true, dirty = false, untracked = null, ageHours = 10 } = {}) => {
    const dir = path.join(bot.workspace, name);
    const branch = `task-${name}`;
    git(["--git-dir", bot.base, "worktree", "add", "-q", "-b", branch, dir, "main"]);
    fs.writeFileSync(path.join(dir, `${name}.txt`), "work\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", `work ${name}`], dir);
    if (pushed) git(["push", "-q", "origin", `${branch}:${branch}`], dir);
    if (dirty) fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
    if (untracked) {
      fs.mkdirSync(path.join(dir, untracked), { recursive: true });
      fs.writeFileSync(path.join(dir, untracked, "x"), "x\n");
    }
    age(bot, name, ageHours);
    return dir;
  };

  // The clone looks untouched for `hours`: directory, its entries and the worktree's own HEAD and reflog.
  const age = (bot, name, hours) => {
    const dir = path.join(bot.workspace, name);
    const admin = path.join(bot.base, "worktrees", name);
    const t = new Date(Date.now() - hours * HOUR);
    for (const f of [...fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e)), path.join(admin, "HEAD"), path.join(admin, "index"), path.join(admin, "logs", "HEAD")]) {
      try { fs.utimesSync(f, t, t); } catch { /* absent */ }
    }
    fs.utimesSync(dir, t, t);
  };

  const states = (map) => async (id) => map[id] ?? { ok: true, status: "in_review", liveRunId: null };
  const scan = (bot, map = {}, opts = {}) =>
    scanIdleOpenClones(bot.workspace, Date.now(), { fetchState: states(map), statfs: plenty, ...opts });
  const verdicts = (r) => Object.fromEntries(r.items.map((i) => [i.name, `${i.action}:${i.reason}`]));

  it("removes a clean pushed in_review clone idle for more than 6 hours, and only it", async () => {
    const bot = makeBot();
    const clone = addClone(bot, "OPE-1");
    const other = addClone(bot, "OPE-2", { ageHours: 10 });
    const r = await scan(bot, { "OPE-2": { ok: true, status: "in_progress", liveRunId: null } });
    assert.deepEqual(verdicts(r), { "OPE-1": "remove:idle-clean-pushed", "OPE-2": "keep:status-in_progress" });
    assert.ok(r.items[0].sizeBytes > 0);
    const journal = path.join(tmpDir, "j.jsonl");
    const gone = await pruneIdleOpenClones(r.items, bot.workspace, journal, { fetchState: states({}) });
    assert.deepEqual(gone, [clone]);
    assert.equal(fs.existsSync(clone), false);
    assert.equal(fs.existsSync(other), true);
    assert.doesNotMatch(git(["--git-dir", bot.base, "worktree", "list"]), /OPE-1\b/);
    assert.match(git(["--git-dir", bot.base, "worktree", "list"]), /OPE-2\b/);
    const rec = fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rec.length, 1);
    assert.equal(rec[0].event, "idle-open-clone-removed");
    assert.equal(rec[0].identifier, "OPE-1");
    assert.equal(rec[0].status, "in_review");
    assert.equal(rec[0].ageHours, 10);
    assert.ok(rec[0].sizeBytes > 0);
    assert.equal(rec[0].via, "git-worktree-remove");
  });

  for (const status of ["blocked", "backlog"]) {
    it(`handles ${status} like in_review`, async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1");
      const r = await scan(bot, { "OPE-1": { ok: true, status, liveRunId: null } });
      assert.deepEqual(verdicts(r), { "OPE-1": "remove:idle-clean-pushed" });
    });
  }

  it("keeps clones that are dirty, unpushed, young, running, or of a todo or in_progress task", async () => {
    const bot = makeBot();
    addClone(bot, "OPE-10", { dirty: true });
    addClone(bot, "OPE-11", { pushed: false });
    addClone(bot, "OPE-12", { ageHours: 2 });
    addClone(bot, "OPE-13");
    addClone(bot, "OPE-14");
    addClone(bot, "OPE-15");
    addClone(bot, "OPE-16", { untracked: "notes" });
    addClone(bot, "OPE-17");
    const r = await scan(bot, {
      "OPE-13": { ok: true, status: "in_review", liveRunId: "run-1" },
      "OPE-14": { ok: true, status: "todo", liveRunId: null },
      "OPE-15": { ok: true, status: "in_progress", liveRunId: null },
      "OPE-17": { ok: false, reason: "board-unavailable" },
    });
    assert.deepEqual(verdicts(r), {
      "OPE-10": "keep:dirty",
      "OPE-11": "keep:not-pushed",
      "OPE-12": "keep:fresh",
      "OPE-13": "keep:live-run",
      "OPE-14": "keep:status-todo",
      "OPE-15": "keep:status-in_progress",
      "OPE-16": "keep:dirty",
      "OPE-17": "keep:board-unavailable",
    });
    assert.equal(await pruneIdleOpenClones(r.items, bot.workspace, path.join(tmpDir, "j.jsonl"), { fetchState: states({}) }).then((g) => g.length), 0);
    for (const n of [10, 11, 12, 13, 14, 15, 16, 17]) assert.equal(fs.existsSync(path.join(bot.workspace, `OPE-${n}`)), true);
  });

  it("an untracked service directory (node_modules) does not keep a clone", async () => {
    const bot = makeBot();
    addClone(bot, "OPE-1", { untracked: "node_modules" });
    assert.deepEqual(verdicts(await scan(bot)), { "OPE-1": "remove:idle-clean-pushed" });
  });

  it("leaves closed tasks to the closed-task rule and ignores non-task folders", async () => {
    const bot = makeBot();
    addClone(bot, "OPE-1");
    fs.mkdirSync(path.join(bot.workspace, ".gc-archive"));
    fs.mkdirSync(path.join(bot.workspace, "scratch"));
    const r = await scan(bot, { "OPE-1": { ok: true, status: "done", liveRunId: null } });
    assert.deepEqual(r.items, []);
  });

  it("keeps a clone when a run starts between the scan and the removal", async () => {
    const bot = makeBot();
    const clone = addClone(bot, "OPE-1");
    const r = await scan(bot);
    const journal = path.join(tmpDir, "j.jsonl");
    const gone = await pruneIdleOpenClones(r.items, bot.workspace, journal, { fetchState: states({ "OPE-1": { ok: true, status: "in_review", liveRunId: "run-9" } }) });
    assert.deepEqual(gone, []);
    assert.equal(fs.existsSync(clone), true);
    assert.equal(JSON.parse(fs.readFileSync(journal, "utf8").trim()).reason, "live-run");
  });

  it("with under 10% of the volume free the idle time is 1 hour", async () => {
    const bot = makeBot();
    addClone(bot, "OPE-1", { ageHours: 2 });
    addClone(bot, "OPE-2", { ageHours: 0.5 });
    const normal = await scan(bot);
    assert.equal(normal.thresholdHours, 6);
    assert.deepEqual(verdicts(normal), { "OPE-1": "keep:fresh", "OPE-2": "keep:fresh" });
    const tight = await scan(bot, {}, { statfs: low });
    assert.equal(tight.thresholdHours, 1);
    assert.deepEqual(verdicts(tight), { "OPE-1": "remove:idle-clean-pushed", "OPE-2": "keep:fresh" });
    assert.equal(tight.items[0].lowSpace, true);
  });

  it("volumeFreePercent reads bavail and survives a failing statfs", () => {
    assert.equal(volumeFreePercent("/x", () => ({ blocks: 200, bavail: 10 })), 5);
    assert.equal(volumeFreePercent("/x", () => { throw new Error("no"); }), null);
  });

  it("maps a container gitdir (/bot/...) to the host and removes only its own admin dir", async () => {
    const bot = makeBot();
    const clone = addClone(bot, "OPE-1");
    const sibling = addClone(bot, "OPE-2", { ageHours: 1 });
    // Both worktrees record container paths, as on the bots volume.
    for (const name of ["OPE-1", "OPE-2"]) {
      fs.writeFileSync(path.join(bot.workspace, name, ".git"), `gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/${name}\n`);
      fs.writeFileSync(path.join(bot.base, "worktrees", name, "gitdir"), `/bot/workspace/${name}/.git\n`);
    }
    const r = await scan(bot);
    assert.deepEqual(verdicts(r), { "OPE-1": "remove:idle-clean-pushed", "OPE-2": "keep:fresh" });
    const gone = await pruneIdleOpenClones(r.items, bot.workspace, path.join(tmpDir, "j.jsonl"), { fetchState: states({}) });
    assert.deepEqual(gone, [clone]);
    assert.equal(fs.existsSync(clone), false);
    assert.equal(fs.existsSync(path.join(bot.base, "worktrees", "OPE-1")), false);
    assert.equal(fs.existsSync(sibling), true);
    assert.equal(fs.existsSync(path.join(bot.base, "worktrees", "OPE-2")), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmpDir, "j.jsonl"), "utf8").trim()).via, "rm-and-admin-dir");
  });

  it("keeps a clone whose gitdir cannot be mapped or whose push cannot be proven", async () => {
    const bot = makeBot();
    addClone(bot, "OPE-1");
    addClone(bot, "OPE-2");
    fs.writeFileSync(path.join(bot.workspace, "OPE-1", ".git"), "gitdir: /nonexistent/elsewhere\n");
    // A remote that is a local path is no server: nothing is proven pushed.
    git(["--git-dir", bot.base, "remote", "set-url", "origin", bot.server]);
    const savedCount = process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_COUNT;
    try {
      const r = await scan(bot);
      assert.equal(r.items.find((i) => i.name === "OPE-1").reason, "gitdir-missing");
      assert.match(r.items.find((i) => i.name === "OPE-2").reason, /^push-unverified/);
    } finally {
      process.env.GIT_CONFIG_COUNT = savedCount;
    }
  });

  describe("copies of agents that are not the task assignee (reviewers, leads)", () => {
    const REVIEWER = { ok: true, id: "agent-rev", name: "adm-dev-review-10", role: "qa" };
    const ENGINEER = { ok: true, id: "agent-eng", name: "adm-dev-eng-3", role: "engineer" };
    const LEAD = { ok: true, id: "agent-lead", name: "adm-dev-lead", role: "engineer" };
    const todo = (extra = {}) => ({ ok: true, status: "todo", liveRunId: null, assigneeAgentId: "agent-eng", ...extra });
    const reviewScan = (bot, map = {}, { agent = REVIEWER, runs = {}, ...opts } = {}) =>
      scanReviewerClones(bot.workspace, Date.now(), {
        fetchState: async (id) => map[id] ?? todo(),
        fetchAgent: async () => agent,
        fetchRun: async (id) => runs[id] ?? { ok: false, reason: "board-http-404" },
        ...opts,
      });

    it("removes a reviewer's copy of a todo task idle for more than 10 minutes, with the journal", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 15 / 60 });
      const r = await reviewScan(bot);
      assert.deepEqual(verdicts(r), { "OPE-1": "remove:nonassignee-copy-idle" });
      assert.equal(r.items[0].status, "todo");
      const journal = path.join(tmpDir, "j.jsonl");
      const gone = await pruneReviewerClones(r.items, bot.workspace, journal, { fetchState: async () => todo(), fetchRun: async () => ({ ok: false }) });
      assert.deepEqual(gone, [clone]);
      assert.equal(fs.existsSync(clone), false);
      assert.doesNotMatch(git(["--git-dir", bot.base, "worktree", "list"]), /OPE-1\b/);
      const rec = JSON.parse(fs.readFileSync(journal, "utf8").trim());
      assert.equal(rec.event, "review-clone-removed");
      assert.equal(rec.status, "todo");
      assert.equal(rec.thresholdMinutes, 10);
    });

    it("keeps a copy younger than 10 minutes", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 3 / 60 });
      const events = [];
      const r = await reviewScan(bot, {}, { onEvent: (e) => events.push(e) });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:fresh" });
      assert.equal(events[0].event, "review-clone-kept");
      assert.equal(await pruneReviewerClones(r.items, bot.workspace, path.join(tmpDir, "j.jsonl"), {}).then((g) => g.length), 0);
      assert.equal(fs.existsSync(clone), true);
    });

    it("keeps a copy while the reviewer has a run of its own, also when the engineer's run is on the task", async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1", { ageHours: 1 });
      addClone(bot, "OPE-2", { ageHours: 1 });
      addClone(bot, "OPE-3", { ageHours: 1 });
      const r = await reviewScan(bot, {
        "OPE-1": todo({ liveRunId: "run-rev", liveRunIds: ["run-rev"] }),
        "OPE-2": todo({ liveRunId: "run-eng", liveRunIds: ["run-eng"] }),
        "OPE-3": todo({ liveRunId: "run-x", liveRunIds: ["run-x"] }),
      }, { runs: { "run-rev": { ok: true, agentId: "agent-rev" }, "run-eng": { ok: true, agentId: "agent-eng" } } });
      assert.deepEqual(verdicts(r), {
        "OPE-1": "keep:live-run",
        "OPE-2": "remove:nonassignee-copy-idle", // the engineer's run does not use the reviewer's copy
        "OPE-3": "keep:live-run", // owner of the run unknown: no guess
      });
    });

    it("keeps a copy when a run of the reviewer starts between the scan and the removal", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 1 });
      const r = await reviewScan(bot);
      const journal = path.join(tmpDir, "j.jsonl");
      const gone = await pruneReviewerClones(r.items, bot.workspace, journal, {
        fetchState: async () => todo({ liveRunId: "run-rev", liveRunIds: ["run-rev"] }),
        fetchRun: async () => ({ ok: true, agentId: "agent-rev" }),
      });
      assert.deepEqual(gone, []);
      assert.equal(fs.existsSync(clone), true);
      const rec = JSON.parse(fs.readFileSync(journal, "utf8").trim());
      assert.equal(rec.event, "review-clone-kept");
      assert.equal(rec.reason, "live-run");
    });

    it("frees a lead's copy of a task whose assignee is another agent, idle for more than 10 minutes", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 15 / 60 });
      const r = await reviewScan(bot, {}, { agent: LEAD });
      assert.deepEqual(verdicts(r), { "OPE-1": "remove:nonassignee-copy-idle" });
      assert.equal(r.items[0].reviewer, false);
      const journal = path.join(tmpDir, "j.jsonl");
      const gone = await pruneReviewerClones(r.items, bot.workspace, journal, { fetchState: async () => todo(), fetchRun: async () => ({ ok: false }) });
      assert.deepEqual(gone, [clone]);
      assert.equal(fs.existsSync(clone), false);
      const rec = JSON.parse(fs.readFileSync(journal, "utf8").trim());
      assert.equal(rec.event, "review-clone-removed");
      assert.equal(rec.reason, "nonassignee-copy-idle");
    });

    it("frees a reviewer's copy in_review older than 10 minutes even while the reviewer is the assignee", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 15 / 60 });
      const inReview = () => todo({ status: "in_review", assigneeAgentId: "agent-rev" });
      const r = await reviewScan(bot, { "OPE-1": inReview() });
      assert.deepEqual(verdicts(r), { "OPE-1": "remove:nonassignee-copy-idle" });
      const gone = await pruneReviewerClones(r.items, bot.workspace, path.join(tmpDir, "j.jsonl"), { fetchState: async () => inReview(), fetchRun: async () => ({ ok: false }) });
      assert.deepEqual(gone, [clone]);
      assert.equal(fs.existsSync(clone), false);
    });

    it("keeps a reviewer-assignee's copy while its own run is live", async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1", { ageHours: 15 / 60 });
      const live = todo({ status: "in_review", assigneeAgentId: "agent-rev", liveRunIds: ["run-1"] });
      const r = await reviewScan(bot, { "OPE-1": live }, { runs: { "run-1": { ok: true, agentId: "agent-rev" } } });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:live-run" });
    });

    it("keeps a lead-assignee's copy", async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1", { ageHours: 15 / 60 });
      const r = await reviewScan(bot, { "OPE-1": todo({ assigneeAgentId: "agent-lead" }) }, { agent: LEAD });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:assignee" });
    });

    it("does not touch the assignee's own copy", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 24 });
      const r = await reviewScan(bot, {}, { agent: ENGINEER });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:assignee" });
      const gone = await pruneReviewerClones([{ ...r.items[0], action: "remove" }], bot.workspace, path.join(tmpDir, "j.jsonl"), { fetchState: async () => todo(), fetchRun: async () => ({ ok: false }) });
      assert.deepEqual(gone, []);
      assert.equal(fs.existsSync(clone), true);
    });

    it("keeps a lead's copy while the lead has a run of its own", async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1", { ageHours: 1 });
      const r = await reviewScan(bot, { "OPE-1": todo({ liveRunId: "run-lead", liveRunIds: ["run-lead"] }) }, { agent: LEAD, runs: { "run-lead": { ok: true, agentId: "agent-lead" } } });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:live-run" });
    });

    it("keeps a copy of a task without an assignee (conservative)", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 24 });
      const r = await reviewScan(bot, { "OPE-1": todo({ assigneeAgentId: null }) }, { agent: LEAD });
      assert.deepEqual(verdicts(r), { "OPE-1": "keep:no-assignee" });
      const gone = await pruneReviewerClones([{ ...r.items[0], action: "remove" }], bot.workspace, path.join(tmpDir, "j.jsonl"), { fetchState: async () => todo({ assigneeAgentId: null }), fetchRun: async () => ({ ok: false }) });
      assert.deepEqual(gone, []);
      assert.equal(fs.existsSync(clone), true);
    });

    it("does not touch the copies of an unknown agent", async () => {
      const bot = makeBot();
      const clone = addClone(bot, "OPE-1", { ageHours: 24 });
      for (const agent of [{ ok: true, id: null }, { ok: false, reason: "board-unavailable" }]) {
        const r = await reviewScan(bot, {}, { agent });
        assert.deepEqual(r.items, []);
      }
      assert.equal(fs.existsSync(clone), true);
    });

    it("keeps dirty and unpushed copies of a reviewer", async () => {
      const bot = makeBot();
      addClone(bot, "OPE-1", { ageHours: 1, dirty: true });
      addClone(bot, "OPE-2", { ageHours: 1, pushed: false });
      assert.deepEqual(verdicts(await reviewScan(bot)), { "OPE-1": "keep:dirty", "OPE-2": "keep:not-pushed" });
    });

    it("tells a reviewer by role or by the -review- name part", () => {
      assert.equal(isReviewerAgent(REVIEWER), true);
      assert.equal(isReviewerAgent({ ok: true, id: "x", name: "other", role: "reviewer" }), true);
      assert.equal(isReviewerAgent(ENGINEER), false);
      assert.equal(isReviewerAgent({ ok: true, id: null }), false);
    });

    it("fetchBotAgent reads an agent by id or by name; fetchRunAgentId reads the run owner", async () => {
      const urls = [];
      const respond = (body, status = 200) => async (url) => { urls.push(url); return { ok: status < 400, status, json: async () => body }; };
      const uuid = "07555686-1111-4222-8333-444455556666";
      assert.deepEqual(await fetchBotAgent(uuid, { baseUrl: "http://b", fetchImpl: respond({ id: uuid, name: "adm-dev-review-11", role: "qa" }) }), { ok: true, id: uuid, name: "adm-dev-review-11", role: "qa" });
      assert.equal(urls[0], `http://b/api/agents/${uuid}`);
      assert.deepEqual(await fetchBotAgent(uuid, { baseUrl: "http://b", fetchImpl: respond({}, 404) }), { ok: true, id: null });
      process.env.MYRMIDON_COMPANY_ID = "co-1";
      try {
        const list = [{ id: "a1", name: "adm-dev-review-100", role: "qa" }, { id: "a2", name: "adm-dev-review-10", role: "qa" }];
        assert.equal((await fetchBotAgent("adm-dev-review-10", { baseUrl: "http://b", fetchImpl: respond(list) })).id, "a2");
        assert.equal((await fetchBotAgent("nobody", { baseUrl: "http://b", fetchImpl: respond(list) })).id, null);
      } finally { delete process.env.MYRMIDON_COMPANY_ID; }
      assert.equal((await fetchBotAgent("x", { baseUrl: "http://b", fetchImpl: async () => { throw new Error("x"); } })).ok, false);
      assert.deepEqual(await fetchRunAgentId("run-1", { baseUrl: "http://b", fetchImpl: respond({ agentId: "a1" }) }), { ok: true, agentId: "a1" });
      assert.equal((await fetchRunAgentId("run-1", { baseUrl: "http://b", fetchImpl: respond({}, 404) })).ok, false);
    });
  });

  describe("board and CLI", () => {
    let board;
    let boardUrl;
    let issueState;
    before(async () => {
      board = createServer((req, res) => {
        const id = decodeURIComponent(req.url.split("/").pop());
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");
        if (!issueState[id]) { res.writeHead(404); res.end(); return; }
        res.end(JSON.stringify(issueState[id]));
      });
      await new Promise((resolve) => board.listen(0, "127.0.0.1", resolve));
      boardUrl = `http://127.0.0.1:${board.address().port}`;
    });
    after(async () => { await new Promise((resolve) => board.close(resolve)); });

    it("fetchIssueOpenState reports a live run from executionRunId or checkoutRunId", async () => {
      const respond = (body) => async () => ({ ok: true, status: 200, json: async () => body });
      assert.deepEqual(await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: respond({ status: "in_review", executionRunId: null, checkoutRunId: null }) }), { ok: true, status: "in_review", assigneeAgentId: null, liveRunId: null, liveRunIds: [] });
      assert.equal((await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: respond({ status: "todo", assigneeAgentId: "a1" }) })).assigneeAgentId, "a1");
      assert.deepEqual((await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: respond({ status: "in_review", executionRunId: "r1", checkoutRunId: "r3" }) })).liveRunIds, ["r1", "r3"]);
      assert.equal((await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: respond({ status: "in_review", executionRunId: "r1" }) })).liveRunId, "r1");
      assert.equal((await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: respond({ status: "blocked", checkoutRunId: "r2" }) })).liveRunId, "r2");
      assert.equal((await fetchIssueOpenState("OPE-1", { baseUrl: "http://b", fetchImpl: async () => { throw new Error("x"); } })).reason, "board-unavailable");
    });

    const run = (args) => new Promise((resolve, reject) => {
      const child = subprocess.spawn("node", [SCRIPT, ...args, "--lock", path.join(tmpDir, "gc.lock"), "--journal", path.join(tmpDir, "gc.jsonl"), "--env", path.join(tmpDir, "none.env")], {
        env: { ...process.env, BOARD_API_URL: boardUrl, PAPERCLIP_API_KEY: "", MYRMIDON_HOST_GC_DOCKER: "/nonexistent-docker" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c) => { stdout += c; });
      child.stderr.setEncoding("utf8").on("data", (c) => { stderr += c; });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    const journalEvents = () => fs.readFileSync(path.join(tmpDir, "gc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

    it("--dry-run lists what would be removed and removes nothing; --apply removes it", async () => {
      const bot = makeBot();
      const idle = addClone(bot, "OPE-1");
      const busy = addClone(bot, "OPE-2");
      issueState = {
        "OPE-1": { status: "blocked" },
        "OPE-2": { status: "in_review", executionRunId: "run-1" },
      };
      const dry = await run(["--dry-run", "--root", bot.workspace]);
      assert.equal(dry.status, 0, dry.stderr);
      const plan = JSON.parse(dry.stdout).plan;
      assert.deepEqual(plan.idleOpenClones.map((i) => i.path), [idle]);
      assert.equal(fs.existsSync(idle), true);
      const dryEvents = journalEvents().map((e) => [e.event, e.identifier]);
      assert.ok(dryEvents.some(([e, id]) => e === "idle-open-clone-would-remove" && id === "OPE-1"));
      assert.ok(dryEvents.some(([e, id]) => e === "idle-open-clone-kept" && id === "OPE-2"));
      assert.ok(!dryEvents.some(([e]) => e === "idle-open-clone-removed"));

      const apply = await run(["--apply", "--root", bot.workspace]);
      assert.equal(apply.status, 0, apply.stderr);
      assert.equal(fs.existsSync(idle), false);
      assert.equal(fs.existsSync(busy), true);
      const removed = journalEvents().find((e) => e.event === "idle-open-clone-removed");
      assert.equal(removed.identifier, "OPE-1");
      assert.equal(removed.status, "blocked");
      assert.ok(removed.sizeBytes > 0);
      assert.ok(removed.ageHours >= 10);
    });

    it("--idle-open-hours must be a positive number", async () => {
      const r = await run(["--dry-run", "--root", path.join(tmpDir, "ws"), "--idle-open-hours", "0"]);
      assert.equal(r.status, 2);
    });
  });
});
describe("closed-task scan: bot linked worktrees with container gitdirs (OPE-14907)", () => {
  const HOUR = 60 * 60 * 1000;
  const git = (args, cwd) => {
    const r = subprocess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  // <tmp>/agent/{workspace, hermes/.myrmidon/git-base/o/r.git}; the git-base's origin is the
  // git:// "server" (the daemon rewrite), so a pushed branch proves against the server.
  const makeBot = () => {
    const server = path.join(tmpDir, "server.git");
    git(["init", "-q", "--bare", "-b", "main", server]);
    const seed = path.join(tmpDir, "seed");
    git(["init", "-q", "-b", "main", seed]);
    fs.writeFileSync(path.join(seed, "f.txt"), "one\n");
    git(["add", "."], seed);
    git(["commit", "-q", "-m", "one"], seed);
    git(["push", "-q", server, "main"], seed);
    const agent = path.join(tmpDir, "agent");
    const base = path.join(agent, "hermes/.myrmidon/git-base/o/r.git");
    fs.mkdirSync(path.dirname(base), { recursive: true });
    git(["clone", "-q", "--bare", server, base]);
    const workspace = path.join(agent, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    return { server, agent, base, workspace };
  };

  // A linked worktree of the git-base on its own pushed-or-not branch; then the `.git` file and
  // the admin dir's `gitdir` record the CONTAINER paths, as on the bots volume: the host cannot
  // read the clone without the /bot -> agent-root mapping (direct `git status` dies with
  // "not a git repository", and the old closed scan returned clones=[] for it).
  const addLinkedClone = (bot, name, { pushed = true, dirty = false, ageHours = 10 } = {}) => {
    const dir = path.join(bot.workspace, name);
    const branch = `task-${name}`;
    git(["--git-dir", bot.base, "worktree", "add", "-q", "-b", branch, dir, "main"]);
    fs.writeFileSync(path.join(dir, `${name}.txt`), "work\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", `work ${name}`], dir);
    if (pushed) git(["push", "-q", "origin", `${branch}:${branch}`], dir);
    if (dirty) fs.writeFileSync(path.join(dir, "f.txt"), "changed\n");
    fs.writeFileSync(path.join(dir, ".git"), `gitdir: /bot/hermes/.myrmidon/git-base/o/r.git/worktrees/${name}\n`);
    fs.writeFileSync(path.join(bot.base, "worktrees", name, "gitdir"), `/bot/workspace/${name}/.git\n`);
    age(bot, name, ageHours);
    return dir;
  };

  // The clone looks untouched for `hours`: directory, its top-level entries and the worktree's
  // own HEAD and reflog (the same clock the idle rule ages).
  const age = (bot, name, hours) => {
    const dir = path.join(bot.workspace, name);
    const admin = path.join(bot.base, "worktrees", name);
    const t = new Date(Date.now() - hours * HOUR);
    for (const f of [...fs.readdirSync(dir).filter((e) => e !== ".git").map((e) => path.join(dir, e)), path.join(admin, "HEAD"), path.join(admin, "index"), path.join(admin, "logs", "HEAD")]) {
      try { fs.utimesSync(f, t, t); } catch { /* absent */ }
    }
    fs.utimesSync(dir, t, t);
  };

  const scanClosed = (bot, ttlHours = 6) => scanTaskClones(bot.workspace, Date.now(), ttlHours);

  it("scan and assess a clean pushed linked worktree whose gitdir is a container path", () => {
    const bot = makeBot();
    const dir = addLinkedClone(bot, "OPE-1");
    const clones = scanClosed(bot);
    assert.equal(clones.length, 1);
    assert.equal(clones[0].path, dir);
    const c = assessClone(clones[0]);
    assert.equal(c.clean, true);
    assert.equal(c.stash, false);
    assert.equal(c.alternates, false);
    assert.equal(c.pushed, true);
    assert.equal(c.safeToRemove, true);
    assert.equal(c.reason, "clean-pushed");
    // Mapped: the removal can free the clone and exactly its own admin dir (removeWorktreeClone).
    assert.equal(c.adminDir, path.join(bot.base, "worktrees", "OPE-1"));
    assert.equal(c.commonDir, bot.base);
  });

  it("still scans an ordinary .git-directory clone, unchanged", () => {
    const bot = makeBot();
    const dir = path.join(bot.workspace, "OPE-2");
    git(["clone", "-q", bot.server, dir]);
    const t = new Date(Date.now() - 10 * HOUR);
    fs.utimesSync(dir, t, t);
    const clones = scanClosed(bot);
    assert.equal(clones.length, 1);
    assert.equal(clones[0].path, dir);
    assert.equal(clones[0].adminDir, undefined);
    const c = assessClone(clones[0]);
    assert.equal(c.safeToRemove, true);
    assert.equal(c.reason, "clean-pushed");
  });

  it("a dirty linked worktree is scanned but held for archive, not removal", () => {
    const bot = makeBot();
    addLinkedClone(bot, "OPE-3", { dirty: true });
    const clones = scanClosed(bot);
    assert.equal(clones.length, 1);
    const c = assessClone(clones[0]);
    assert.equal(c.clean, false);
    assert.equal(c.pushed, false);
    assert.equal(c.safeToRemove, false);
    assert.equal(c.reason, "unsafe-archive");
  });

  it("an unpushed linked worktree is scanned but held for archive, not removal", () => {
    const bot = makeBot();
    addLinkedClone(bot, "OPE-4", { pushed: false });
    const clones = scanClosed(bot);
    assert.equal(clones.length, 1);
    const c = assessClone(clones[0]);
    assert.equal(c.clean, true);
    assert.equal(c.pushed, false);
    assert.equal(c.safeToRemove, false);
    assert.equal(c.reason, "unsafe-archive");
  });

  it("keeps mapped paths through the production-like git wrapper, plan, archive and removal", async () => {
    const bot = makeBot();
    const clean = addLinkedClone(bot, "OPE-1");
    const dirty = addLinkedClone(bot, "OPE-2", { dirty: true });
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin);
    // Like the deployed launcher, map the cwd's container gitfile even without caller env.
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ -z "$GIT_DIR" ] && [ -f "$PWD/.git" ]; then\n  IFS= read -r pointer < "$PWD/.git"\n  case "$pointer" in 'gitdir: /bot/'*) export GIT_DIR="$TEST_AGENT_ROOT/\${pointer#gitdir: /bot/}" GIT_WORK_TREE="$PWD";; esac\nfi\nexec /usr/bin/git "$@"\n`, { mode: 0o755 });
    const board = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "done" }));
    });
    await new Promise((resolve) => board.listen(0, "127.0.0.1", resolve));
    const run = (mode) => new Promise((resolve, reject) => {
      const child = subprocess.spawn(process.execPath, [path.join(ROOT, "scripts/myrmidon/host-gc/host-clone-cache-gc.mjs"), mode, "--root", bot.workspace, "--lock", path.join(tmpDir, "lock"), "--journal", path.join(tmpDir, "journal"), "--env", path.join(tmpDir, "none"), "--archive-root", path.join(tmpDir, "archives")], {
        env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, TEST_AGENT_ROOT: bot.agent, BOARD_API_URL: `http://127.0.0.1:${board.address().port}`, PAPERCLIP_API_KEY: "", MYRMIDON_HOST_GC_DOCKER: "/nonexistent-docker" },
      });
      let stdout = "", stderr = "";
      child.stdout.on("data", (s) => { stdout += s; });
      child.stderr.on("data", (s) => { stderr += s; });
      child.on("error", reject);
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    try {
      const dry = await run("--dry-run");
      assert.equal(dry.status, 0, dry.stderr);
      const clones = JSON.parse(dry.stdout).plan.clones;
      for (const [name, action] of [["OPE-1", "remove"], ["OPE-2", "archive-remove"]]) {
        const item = clones.find((c) => c.name === name);
        assert.ok(item, `missing ${name}`);
        assert.equal(item.adminDir, path.join(bot.base, "worktrees", name));
        assert.equal(item.commonDir, bot.base);
        assert.equal(item.action, action);
      }
      assert.ok(fs.existsSync(clean) && fs.existsSync(dirty));
      const apply = await run("--apply");
      assert.equal(apply.status, 0, apply.stderr);
      const events = fs.readFileSync(path.join(tmpDir, "journal"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(events.some((item) => item.event === "clone-archived" && item.path === dirty), JSON.stringify(events));
      assert.equal(fs.existsSync(clean), false);
      assert.equal(fs.existsSync(dirty), false);
      assert.equal(fs.existsSync(path.join(bot.base, "worktrees", "OPE-1")), false);
      assert.equal(fs.existsSync(path.join(bot.base, "worktrees", "OPE-2")), false);
    } finally {
      await new Promise((resolve) => board.close(resolve));
    }
  });

  it("enters the closed-task pipeline for done and cancelled issues", async () => {
    const bot = makeBot();
    addLinkedClone(bot, "OPE-1");
    for (const status of ["done", "cancelled"]) {
      const { candidates } = await filterClosedTaskClones(scanClosed(bot), {
        baseUrl: "http://board",
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status }) }),
      });
      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].identifier, "OPE-1");
      assert.equal(candidates[0].issueStatus, status);
    }
  });
});
