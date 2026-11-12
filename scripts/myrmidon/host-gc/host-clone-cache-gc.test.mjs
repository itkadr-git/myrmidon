// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import subprocess from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
// A bot container exports empty GIT_AUTHOR_*/GIT_COMMITTER_* variables; git honors an
// empty env var over config, which breaks commit fixtures. Strip them everywhere.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_AUTHOR_|GIT_COMMITTER_)/.test(k)));
const {
  parseArgs,
  acquireLock,
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
  fetchAgentDecommissionState,
  scanBotDataForUnpushedWork,
  clearBotDiskProject,
  planBotDataGc,
  scanSshRunCopies,
  pruneSshRunCopies,
  scanRunnerTaskFolders,
  issueIdentifierFromRunnerFolderName,
} = await import(
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

// myrmidon(1.6.8 OPE-12855): task folders of runner issues are GC'd when the issue is
// done/cancelled and the folder is older than the clone TTL; the board is fail-closed.
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

  const runGcTask = (flags, envOverrides = {}) => {
    const botsRoot = path.join(tmpDir, "bots");
    fs.mkdirSync(botsRoot, { recursive: true });
    const journal = path.join(tmpDir, "gc-task.jsonl");
    // A plain PATH: the GC subprocess makes ~a dozen read-only git calls per folder,
    // and a launcher-wrapper `git` on PATH multiplies each into a probe/broker walk
    // that together busts the 120 s spawn timeout. The host GC runs on a host whose
    // PATH git is the real binary, so this matches production.
    const env = { ...GIT_ENV, HOST_GC_RUNNER_ROOTS: "", PATH: "/usr/bin:/bin", PAPERCLIP_API_URL: "http://127.0.0.1:9", ...envOverrides };
    const res = subprocess.spawnSync(process.execPath, [
      GC_SCRIPT, "--env", "/nonexistent", "--root", botsRoot,
      "--journal", journal, "--lock", path.join(tmpDir, "gc-task.lock"), "--proc-dir", path.join(tmpDir, "proc"),
      ...flags,
    ], { encoding: "utf8", env, timeout: 120_000 });
    const events = fs.existsSync(journal)
      ? fs.readFileSync(journal, "utf8").trim().split("\n").map((l) => JSON.parse(l))
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
      const { res, events } = runGcTask(["--apply", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
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

  it("e2e: an unreachable board keeps every folder (fail-closed apply)", async () => {
    const runners = path.join(tmpDir, "runners");
    const clean = makeTaskFolder(runners, "eng21", "OPE-9101", { ageHours: 30 });
    const { res } = runGcTask(["--apply", "--runner-root", runners]);
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
      const { res, events } = runGcTask(["--dry-run", "--runner-root", runners], { PAPERCLIP_API_URL: `http://127.0.0.1:${port}` });
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
