// myrmidon(1.6.7-BOT-DISK-HOST-GC): tests for host-clone-cache-gc.mjs
// Run: node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import subprocess from "node:child_process";
import { describe, it, beforeEach, afterEach } from "node:test";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
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
