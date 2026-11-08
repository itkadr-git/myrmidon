import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CARGO_TARGET_SUBPATH,
  cargoTargetDir,
  cleanCaches,
  cleanCargoTarget,
  cleanEntryCache,
  cleanTargetDir,
  cleanUvCache,
  collectOpenPaths,
  enforceNpmCap,
  HYGIENE_DEFAULTS,
  isPathOpen,
} from "../../../docker/bot-runtime/botd/lib/hygiene.js";
import { RULE_DEFAULTS } from "../../../docker/bot-runtime/botd/lib/rules.js";

const HOUR = 60 * 60 * 1000;

function createTempFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botd-hygiene-test-"));
  return {
    tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    },
  };
}

describe("botd hygiene: cache cleanup by mtime", () => {
  it("deletes files older than TTL and preserves fresh files", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const targetDir = path.join(tmp, "target");
      fs.mkdirSync(targetDir, { recursive: true });

      const staleFile = path.join(targetDir, "stale.log");
      const freshFile = path.join(targetDir, "fresh.log");

      fs.writeFileSync(staleFile, "stale-content-12345");
      fs.writeFileSync(freshFile, "fresh-content-67890");

      // Stale: 49 hours ago (TTL is 48 hours)
      const staleTime = new Date(now - 49 * HOUR);
      fs.utimesSync(staleFile, staleTime, staleTime);

      // Fresh: 1 hour ago
      const freshTime = new Date(now - 1 * HOUR);
      fs.utimesSync(freshFile, freshTime, freshTime);

      const res = cleanTargetDir(targetDir, 48 * HOUR, now, new Set());

      assert.equal(res.cleanedFiles, 1);
      assert.equal(res.keptFresh, 1);
      assert.equal(res.skippedOpen, 0);
      assert.equal(fs.existsSync(staleFile), false);
      assert.equal(fs.existsSync(freshFile), true);
    } finally {
      cleanup();
    }
  });

  it("does not delete files that are currently open by a process even if stale", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const targetDir = path.join(tmp, "target");
      fs.mkdirSync(targetDir, { recursive: true });

      const openStaleFile = path.join(targetDir, "open-stale.log");
      const closedStaleFile = path.join(targetDir, "closed-stale.log");

      fs.writeFileSync(openStaleFile, "open-stale-data");
      fs.writeFileSync(closedStaleFile, "closed-stale-data");

      const staleTime = new Date(now - 30 * HOUR);
      fs.utimesSync(openStaleFile, staleTime, staleTime);
      fs.utimesSync(closedStaleFile, staleTime, staleTime);

      const openPaths = new Set([openStaleFile]);
      const res = cleanTargetDir(targetDir, 24 * HOUR, now, openPaths);

      assert.equal(res.cleanedFiles, 1);
      assert.equal(res.skippedOpen, 1);
      assert.equal(fs.existsSync(closedStaleFile), false);
      assert.equal(fs.existsSync(openStaleFile), true, "open stale file must remain untouched");
    } finally {
      cleanup();
    }
  });

  it("cleans configured npm whole entries and terminal-output, delegates uv to uv cache prune", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const hermesHome = path.join(tmp, "hermes");
      const cacacheDir = path.join(hermesHome, ".npm", "_cacache", "content-v2", "12");
      const npxDir = path.join(hermesHome, ".npm", "_npx", "pkg-abc");
      const uvDir = path.join(hermesHome, ".cache", "uv");
      const termDir = path.join(hermesHome, "cache", "terminal-output");
      fs.mkdirSync(cacacheDir, { recursive: true });
      fs.mkdirSync(npxDir, { recursive: true });
      fs.mkdirSync(path.join(uvDir, "archive-v0"), { recursive: true });
      fs.mkdirSync(termDir, { recursive: true });
      const staleCacache = path.join(cacacheDir, "data.bin");
      const staleNpx = path.join(npxDir, "cli.js");
      const staleUv = path.join(uvDir, "archive-v0", "wheel.whl");
      const staleTerm = path.join(termDir, "term.log");
      for (const file of [staleCacache, staleNpx, staleUv, staleTerm]) fs.writeFileSync(file, "old");
      const old = new Date(now - 50 * HOUR);
      for (const file of [staleCacache, staleNpx, staleUv, staleTerm]) fs.utimesSync(file, old, old);
      fs.utimesSync(cacacheDir, old, old);
      fs.utimesSync(npxDir, old, old);
      const freshCacache = path.join(hermesHome, ".npm", "_cacache", "content-v2", "34", "56", "fresh.bin");
      fs.mkdirSync(path.dirname(freshCacache), { recursive: true });
      fs.writeFileSync(freshCacache, "fresh");
      const fresh = new Date(now - 2 * HOUR);
      fs.utimesSync(freshCacache, fresh, fresh);
      const calls = [];
      const result = await cleanCaches({
        hermesHome, now, openPaths: new Set(), pressure: "soft",
        execFile: (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null, "", ""); },
      });
      assert.equal(fs.existsSync(staleCacache), false);
      assert.equal(fs.existsSync(staleNpx), false);
      assert.equal(fs.existsSync(staleUv), true, "uv files are never walked/deleted directly");
      assert.equal(fs.existsSync(staleTerm), false);
      assert.equal(fs.existsSync(freshCacache), true);
      assert.deepEqual(calls.map((call) => call.args), [["cache", "prune"]]);
      assert.equal(calls[0].opts.env.UV_CACHE_DIR, uvDir);
      assert.equal(result.targets["uv-cache"].pruned, true);
    } finally {
      cleanup();
    }
  });

  it("prunes stale empty subdirectories but preserves non-empty or fresh ones", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const targetDir = path.join(tmp, "target");
      const emptySub = path.join(targetDir, "old-empty-sub");
      const freshEmptySub = path.join(targetDir, "fresh-empty-sub");

      fs.mkdirSync(emptySub, { recursive: true });
      fs.mkdirSync(freshEmptySub, { recursive: true });

      const oldTime = new Date(now - 50 * HOUR);
      fs.utimesSync(emptySub, oldTime, oldTime);

      const freshTime = new Date(now - 1 * HOUR);
      fs.utimesSync(freshEmptySub, freshTime, freshTime);

      cleanTargetDir(targetDir, 48 * HOUR, now, new Set());

      assert.equal(fs.existsSync(emptySub), false, "stale empty directory pruned");
      assert.equal(fs.existsSync(freshEmptySub), true, "fresh empty directory preserved");
    } finally {
      cleanup();
    }
  });

  it("keeps an entire stale _npx entry when one descendant is open", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const entry = path.join(tmp, "_npx", "hash-a");
      const openFile = path.join(entry, "node_modules", "pkg", "loaded-later.js");
      const otherFile = path.join(entry, "node_modules", "pkg", "index.js");
      fs.mkdirSync(path.dirname(openFile), { recursive: true });
      fs.writeFileSync(openFile, "open");
      fs.writeFileSync(otherFile, "keep with entry");
      const old = new Date(now - 50 * HOUR);
      fs.utimesSync(openFile, old, old);
      fs.utimesSync(otherFile, old, old);
      fs.utimesSync(path.join(entry, "node_modules"), old, old);
      fs.utimesSync(path.join(entry, "node_modules", "pkg"), old, old);
      fs.utimesSync(entry, old, old);
      const result = cleanEntryCache(path.join(tmp, "_npx"), 48 * HOUR, now, new Set([openFile]));
      assert.equal(fs.existsSync(entry), true);
      assert.equal(fs.existsSync(openFile), true);
      assert.equal(fs.existsSync(otherFile), true);
      assert.equal(result.skippedOpen, 1);
    } finally {
      cleanup();
    }
  });

  it("removes a stale _npx cache entry as a whole when no descendant is open", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const root = path.join(tmp, "_npx");
      const entry = path.join(root, "hash-a");
      const first = path.join(entry, "node_modules", "pkg", "index.js");
      const second = path.join(entry, "node_modules", "pkg", "extra.js");
      fs.mkdirSync(path.dirname(first), { recursive: true });
      fs.writeFileSync(first, "one");
      fs.writeFileSync(second, "two");
      const old = new Date(now - 50 * HOUR);
      fs.utimesSync(first, old, old);
      fs.utimesSync(second, old, old);
      fs.utimesSync(path.join(entry, "node_modules"), old, old);
      fs.utimesSync(path.dirname(first), old, old);
      fs.utimesSync(entry, old, old);
      const result = cleanEntryCache(root, 48 * HOUR, now, new Set());
      assert.equal(fs.existsSync(entry), false);
      assert.equal(fs.readdirSync(root).length, 0);
      assert.equal(result.cleanedFiles, 2);
    } finally {
      cleanup();
    }
  });

  it("enforceNpmCap: below the cap does nothing", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npmDir = path.join(tmp, ".npm");
      const npxEntry = path.join(npmDir, "_npx", "hash-a", "cli.js");
      fs.mkdirSync(path.dirname(npxEntry), { recursive: true });
      fs.writeFileSync(npxEntry, "x".repeat(100));
      const result = enforceNpmCap(npmDir, { capBytes: 1024 * 1024, now, openPaths: new Set() });
      assert.equal(result.applied, false);
      assert.equal(result.cleanedFiles, 0);
      assert.equal(fs.existsSync(npxEntry), true);
    } finally {
      cleanup();
    }
  });

  it("enforceNpmCap: over the cap evicts the oldest _npx entry before any cacache shard", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npmDir = path.join(tmp, ".npm");
      const oldNpx = path.join(npmDir, "_npx", "old-hash", "cli.js");
      const newNpx = path.join(npmDir, "_npx", "new-hash", "cli.js");
      const shard = path.join(npmDir, "_cacache", "content-v2", "sha512", "00", "aa", "data.bin");
      fs.mkdirSync(path.dirname(oldNpx), { recursive: true });
      fs.mkdirSync(path.dirname(newNpx), { recursive: true });
      fs.mkdirSync(path.dirname(shard), { recursive: true });
      // Oversize by a wide margin so eviction need only drop the one oldest _npx entry.
      fs.writeFileSync(oldNpx, "a".repeat(2000));
      fs.writeFileSync(newNpx, "b".repeat(100));
      fs.writeFileSync(shard, "c".repeat(100));
      const old = new Date(now - 48 * HOUR);
      const recent = new Date(now - 1 * HOUR);
      fs.utimesSync(oldNpx, old, old);
      fs.utimesSync(path.join(npmDir, "_npx", "old-hash"), old, old);
      fs.utimesSync(newNpx, recent, recent);
      fs.utimesSync(path.join(npmDir, "_npx", "new-hash"), recent, recent);
      fs.utimesSync(shard, recent, recent);
      fs.utimesSync(path.dirname(shard), recent, recent);

      const result = enforceNpmCap(npmDir, { capBytes: 1000, now, openPaths: new Set() });

      assert.equal(result.applied, true);
      assert.equal(fs.existsSync(oldNpx), false, "oldest _npx entry evicted first");
      assert.equal(fs.existsSync(newNpx), true, "newer _npx entry kept");
      assert.equal(fs.existsSync(shard), true, "cacache shard kept while cap is satisfied by _npx alone");
      assert.equal(result.removed.length, 1);
      assert.equal(result.removed[0].kind, "npx");
    } finally {
      cleanup();
    }
  });

  it("enforceNpmCap: falls through to cacache shards, oldest first, once _npx entries are evicted or absent", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npmDir = path.join(tmp, ".npm");
      const npx = path.join(npmDir, "_npx", "hash-a", "cli.js");
      const oldShard = path.join(npmDir, "_cacache", "content-v2", "sha512", "00", "aa", "data.bin");
      const newShard = path.join(npmDir, "_cacache", "content-v2", "sha512", "11", "bb", "data.bin");
      fs.mkdirSync(path.dirname(npx), { recursive: true });
      fs.mkdirSync(path.dirname(oldShard), { recursive: true });
      fs.mkdirSync(path.dirname(newShard), { recursive: true });
      fs.writeFileSync(npx, "n".repeat(300));
      fs.writeFileSync(oldShard, "o".repeat(300));
      fs.writeFileSync(newShard, "x".repeat(300));
      const old = new Date(now - 50 * HOUR);
      const recentNpx = new Date(now - 1 * HOUR);
      const recentNewShard = new Date(now - 30 * 60 * 1000);
      fs.utimesSync(npx, recentNpx, recentNpx);
      fs.utimesSync(path.join(npmDir, "_npx", "hash-a"), recentNpx, recentNpx);
      fs.utimesSync(oldShard, old, old);
      fs.utimesSync(path.dirname(oldShard), old, old);
      fs.utimesSync(newShard, recentNewShard, recentNewShard);
      fs.utimesSync(path.dirname(newShard), recentNewShard, recentNewShard);

      // Total 900 bytes. Cap is 400: _npx (300) evicted first, still 600 > 400,
      // so it falls through to cacache shards: oldest shard (300) evicted,
      // leaving newShard (300 <= 400).
      const result = enforceNpmCap(npmDir, { capBytes: 400, now, openPaths: new Set() });

      assert.equal(fs.existsSync(npx), false, "_npx entry evicted first");
      assert.equal(fs.existsSync(oldShard), false, "oldest cacache shard evicted next");
      assert.equal(fs.existsSync(newShard), true, "newer cacache shard kept");
      assert.equal(result.removed.length, 2);
      assert.equal(result.removed[0].kind, "npx");
      assert.equal(result.removed[1].kind, "cacache-shard");
    } finally {
      cleanup();
    }
  });

  it("enforceNpmCap: skips an entry with an open fd, evicting the next oldest instead", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npmDir = path.join(tmp, ".npm");
      const openNpx = path.join(npmDir, "_npx", "open-hash", "cli.js");
      const closedNpx = path.join(npmDir, "_npx", "closed-hash", "cli.js");
      fs.mkdirSync(path.dirname(openNpx), { recursive: true });
      fs.mkdirSync(path.dirname(closedNpx), { recursive: true });
      fs.writeFileSync(openNpx, "o".repeat(2000));
      fs.writeFileSync(closedNpx, "c".repeat(2000));
      const olderTime = new Date(now - 50 * HOUR);
      const newerTime = new Date(now - 40 * HOUR);
      // The open entry is the OLDER one by mtime, so without the open-fd guard
      // it would be evicted first.
      fs.utimesSync(openNpx, olderTime, olderTime);
      fs.utimesSync(path.join(npmDir, "_npx", "open-hash"), olderTime, olderTime);
      fs.utimesSync(closedNpx, newerTime, newerTime);
      fs.utimesSync(path.join(npmDir, "_npx", "closed-hash"), newerTime, newerTime);

      const openPaths = new Set([openNpx]);
      const result = enforceNpmCap(npmDir, { capBytes: 1000, now, openPaths });

      assert.equal(fs.existsSync(openNpx), true, "open entry must survive even though it is oldest");
      assert.equal(fs.existsSync(closedNpx), false, "next-oldest closed entry evicted instead");
      assert.ok(result.skippedOpen >= 1);
    } finally {
      cleanup();
    }
  });

  it("cleanCaches: does not apply npm size cap during a live run", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const hermesHome = path.join(tmp, "hermes");
      const npxDir = path.join(hermesHome, ".npm", "_npx", "hash-live");
      fs.mkdirSync(npxDir, { recursive: true });
      const file = path.join(npxDir, "cli.js");
      fs.writeFileSync(file, "x".repeat(2000));
      // File is fresh (not stale by TTL)
      const fresh = new Date(now - 1 * HOUR);
      fs.utimesSync(file, fresh, fresh);
      fs.utimesSync(npxDir, fresh, fresh);

      // cleanCaches with live: true, cap = 500 bytes (file is 2000 bytes)
      const res = await cleanCaches({
        hermesHome,
        now,
        openPaths: new Set(),
        live: true,
        limits: { npmCacheCapBytes: 500, npxTtlHours: 24 },
      });

      assert.equal(fs.existsSync(file), true, "npm cap must not be enforced during live run");
      assert.equal(res.targets["npm-cap"], undefined);
    } finally {
      cleanup();
    }
  });

  it("uses uv cache clean under hard disk pressure", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const hermesHome = path.join(tmp, "hermes");
      const uvDir = path.join(hermesHome, ".cache", "uv");
      fs.mkdirSync(uvDir, { recursive: true });
      fs.writeFileSync(path.join(uvDir, "cache-entry"), "data");
      const calls = [];
      const result = await cleanUvCache({
        hermesHome,
        pressure: "hard",
        execFile: (bin, args, opts, cb) => { calls.push({ bin, args, opts }); cb(null, "", ""); },
      });
      assert.deepEqual(calls.map((call) => call.args), [["cache", "clean"]]);
      assert.equal(calls[0].opts.env.UV_CACHE_DIR, uvDir);
      assert.equal(result.pruned, true);
    } finally {
      cleanup();
    }
  });

  it("collectOpenPaths correctly scans /proc or mock procDir", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const mockProc = path.join(tmp, "proc");
      const pidDir = path.join(mockProc, "1234");
      const fdDir = path.join(pidDir, "fd");
      fs.mkdirSync(fdDir, { recursive: true });

      const openTarget = path.join(tmp, "open-file.txt");
      fs.writeFileSync(openTarget, "hello");
      fs.symlinkSync(openTarget, path.join(fdDir, "0"));

      const open = collectOpenPaths(mockProc);
      assert.ok(open.has(openTarget));
      assert.equal(isPathOpen(openTarget, open), true);
      assert.equal(isPathOpen(path.join(tmp, "unrelated.txt"), open), false);
    } finally {
      cleanup();
    }
  });
});

// myrmidon(OPE-12110): byte quotas for `hermes/.npm/_npx` and the per-bot cargo
// target dir. Fixtures use real files and utimes, no mocks of the filesystem.
const MINUTE = 60 * 1000;
const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

/** `<root>/<name>/blob` of `bytes` bytes; the file and its directory get mtime = now - ageMs. */
function makeEntry(root, name, bytes, ageMs, now) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const blob = path.join(dir, "blob");
  fs.writeFileSync(blob, Buffer.alloc(bytes, 1));
  const when = new Date(now - ageMs);
  fs.utimesSync(blob, when, when);
  fs.utimesSync(dir, when, when);
  return dir;
}

describe("botd hygiene: _npx age and quota (OPE-12110)", () => {
  it("ships the documented defaults: 24 h age, 512 MiB _npx quota, 2 GiB cargo quota", () => {
    assert.equal(HYGIENE_DEFAULTS.npxTtlHours, 24);
    assert.equal(HYGIENE_DEFAULTS.npmNpxQuotaBytes, 512 * MIB);
    assert.equal(HYGIENE_DEFAULTS.cargoTargetQuotaBytes, 2 * GIB);
    assert.equal(RULE_DEFAULTS.npmNpxQuotaBytes, HYGIENE_DEFAULTS.npmNpxQuotaBytes);
    assert.equal(RULE_DEFAULTS.cargoTargetQuotaBytes, HYGIENE_DEFAULTS.cargoTargetQuotaBytes);
  });

  it("evicts _npx entries older than 24 h and keeps younger ones (cleanCaches defaults)", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npx = path.join(tmp, ".npm", "_npx");
      const stale = makeEntry(npx, "stale", 100, 25 * HOUR, now);
      const young = makeEntry(npx, "young", 100, 23 * HOUR, now);
      const lines = [];
      const result = await cleanCaches({ hermesHome: tmp, now, openPaths: new Set(), log: (l) => lines.push(l) });
      assert.equal(fs.existsSync(stale), false);
      assert.equal(fs.existsSync(young), true);
      assert.equal(result.targets["npm-npx"].cleanedFiles, 1);
      assert.equal(result.targets["npm-npx"].quotaEvicted, 0);
    } finally {
      cleanup();
    }
  });

  it("over the quota evicts the oldest entries first, by mtime, until the total fits", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npx = path.join(tmp, ".npm", "_npx");
      // all younger than the 24 h age rule and older than the fresh-grace window
      const oldest = makeEntry(npx, "h-oldest", 200 * KIB, 10 * HOUR, now);
      const middle = makeEntry(npx, "h-middle", 200 * KIB, 5 * HOUR, now);
      const newest = makeEntry(npx, "h-newest", 200 * KIB, 1 * HOUR, now);
      // LRU is by mtime: a fresh atime on the oldest entry does not save it
      const touched = new Date(now);
      fs.utimesSync(path.join(oldest, "blob"), touched, new Date(now - 10 * HOUR));

      const lines = [];
      const result = await cleanCaches({
        hermesHome: tmp,
        now,
        openPaths: new Set(),
        limits: { npmNpxQuotaBytes: 450 * KIB },
        log: (l) => lines.push(l),
      });
      assert.equal(fs.existsSync(oldest), false, "the oldest entry goes first");
      assert.equal(fs.existsSync(middle), true);
      assert.equal(fs.existsSync(newest), true);
      const r = result.targets["npm-npx"];
      assert.equal(r.quotaEvicted, 1);
      assert.equal(r.keptBytes, 400 * KIB);
      assert.ok(lines.some((l) => /npx quota 460800 bytes exceeded, evicted 1 entries/.test(l)), lines.join("\n"));

      // a tighter quota takes the next oldest too, and stops as soon as the total fits
      const again = cleanEntryCache(npx, 24 * HOUR, now, new Set(), 250 * KIB, 15 * MINUTE);
      assert.equal(fs.existsSync(middle), false);
      assert.equal(fs.existsSync(newest), true);
      assert.equal(again.quotaEvicted, 1);
      assert.equal(again.keptBytes, 200 * KIB);
    } finally {
      cleanup();
    }
  });

  it("the quota spares an entry a process holds open and one written inside the fresh-grace window", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npx = path.join(tmp, "_npx");
      const heldDir = makeEntry(npx, "held", 300 * KIB, 8 * HOUR, now);
      const writing = makeEntry(npx, "writing", 300 * KIB, 2 * MINUTE, now);
      const idle = makeEntry(npx, "idle", 300 * KIB, 4 * HOUR, now);
      const open = new Set([path.join(heldDir, "blob")]);
      const result = cleanEntryCache(npx, 24 * HOUR, now, open, 100 * KIB, 15 * MINUTE);
      assert.equal(fs.existsSync(heldDir), true, "open entry stays");
      assert.equal(fs.existsSync(writing), true, "entry written 2 minutes ago stays");
      assert.equal(fs.existsSync(idle), false, "the idle entry is the only one evictable");
      assert.equal(result.quotaEvicted, 1);
      assert.equal(result.quotaSkippedFresh, 1);
      assert.equal(result.keptBytes, 600 * KIB, "kept bytes still count what could not be evicted");
    } finally {
      cleanup();
    }
  });

  it("without a quota nothing is evicted for size, only for age", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const npx = path.join(tmp, "_npx");
      makeEntry(npx, "a", 300 * KIB, 3 * HOUR, now);
      makeEntry(npx, "b", 300 * KIB, 2 * HOUR, now);
      const result = cleanEntryCache(npx, 24 * HOUR, now, new Set());
      assert.equal(fs.readdirSync(npx).length, 2);
      assert.equal(result.quotaEvicted, 0);
    } finally {
      cleanup();
    }
  });
});

describe("botd hygiene: cargo target quota (OPE-12110)", () => {
  it("over the quota evicts whole profile dirs, oldest mtime first, until the total fits", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const target = cargoTargetDir(tmp);
      const triple = makeEntry(target, "x86_64-unknown-linux-gnu", 300 * KIB, 9 * HOUR, now);
      const debug = makeEntry(target, "debug", 300 * KIB, 5 * HOUR, now);
      const release = makeEntry(target, "release", 300 * KIB, 1 * HOUR, now);
      fs.writeFileSync(path.join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");

      const first = cleanCargoTarget(target, { nowMs: now, quotaBytes: 700 * KIB, openPaths: new Set(), freshGraceMs: 15 * MINUTE, root: tmp });
      assert.equal(fs.existsSync(triple), false, "the oldest profile dir goes first");
      assert.equal(fs.existsSync(debug), true);
      assert.equal(fs.existsSync(release), true);
      assert.equal(first.quotaEvicted, 1);
      assert.equal(first.keptBytes, 600 * KIB);
      assert.equal(first.cleanedBytes, 300 * KIB);

      const second = cleanCargoTarget(target, { nowMs: now, quotaBytes: 400 * KIB, openPaths: new Set(), freshGraceMs: 15 * MINUTE, root: tmp });
      assert.equal(fs.existsSync(debug), false);
      assert.equal(fs.existsSync(release), true, "the newest survives");
      assert.equal(second.quotaEvicted, 1);
      assert.equal(second.keptBytes, 300 * KIB);
      assert.equal(fs.existsSync(path.join(target, "CACHEDIR.TAG")), true, "top-level files are not evictable units");
    } finally {
      cleanup();
    }
  });

  it("under the quota, or with an open or just-written profile dir, nothing needed is removed", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const target = cargoTargetDir(tmp);
      const debug = makeEntry(target, "debug", 300 * KIB, 5 * HOUR, now);
      const release = makeEntry(target, "release", 300 * KIB, 3 * MINUTE, now);
      const under = cleanCargoTarget(target, { nowMs: now, quotaBytes: 1 * MIB, openPaths: new Set(), freshGraceMs: 15 * MINUTE, root: tmp });
      assert.equal(under.quotaEvicted, 0);
      assert.equal(fs.existsSync(debug) && fs.existsSync(release), true);

      // over the quota: the build in flight (debug holds an open fd, release was written 3 minutes ago) stays
      const busy = cleanCargoTarget(target, {
        nowMs: now,
        quotaBytes: 100 * KIB,
        openPaths: new Set([path.join(debug, "blob")]),
        freshGraceMs: 15 * MINUTE,
        root: tmp,
      });
      assert.equal(busy.quotaEvicted, 0);
      assert.equal(busy.skippedOpen, 1);
      assert.equal(busy.quotaSkippedFresh, 1);
      assert.equal(fs.existsSync(debug) && fs.existsSync(release), true);
    } finally {
      cleanup();
    }
  });

  it("a bot without a cargo target dir is a no-op and the dir is not created", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const result = await cleanCaches({ hermesHome: tmp, now: Date.now(), openPaths: new Set() });
      assert.equal(fs.existsSync(cargoTargetDir(tmp)), false);
      assert.equal(fs.existsSync(path.join(tmp, ".cache")), false);
      assert.equal(result.targets["cargo-target"].quotaEvicted, 0);
    } finally {
      cleanup();
    }
  });

  it("cleanCaches applies cargoTargetQuotaBytes from limits and journals the eviction", async () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const target = cargoTargetDir(tmp);
      const old = makeEntry(target, "debug", 300 * KIB, 6 * HOUR, now);
      const recent = makeEntry(target, "release", 300 * KIB, 2 * HOUR, now);
      const lines = [];
      const result = await cleanCaches({
        hermesHome: tmp,
        now,
        openPaths: new Set(),
        limits: { cargoTargetQuotaBytes: 400 * KIB },
        log: (l) => lines.push(l),
      });
      assert.equal(fs.existsSync(old), false);
      assert.equal(fs.existsSync(recent), true);
      assert.equal(result.targets["cargo-target"].quotaEvicted, 1);
      assert.equal(result.cleanedBytes, 300 * KIB);
      assert.ok(lines.some((l) => /cargo target quota 409600 bytes exceeded, evicted 1 entries/.test(l)), lines.join("\n"));
    } finally {
      cleanup();
    }
  });

  it("never deletes through a cargo target dir that is a symlink out of HERMES_HOME", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const home = path.join(tmp, "home");
      const elsewhere = path.join(tmp, "elsewhere");
      const victim = makeEntry(elsewhere, "debug", 300 * KIB, 9 * HOUR, now);
      fs.mkdirSync(path.join(home, ".cache"), { recursive: true });
      fs.symlinkSync(elsewhere, cargoTargetDir(home));
      const result = cleanCargoTarget(cargoTargetDir(home), { nowMs: now, quotaBytes: 1 * KIB, openPaths: new Set(), freshGraceMs: 0, root: home });
      assert.equal(result.refused, "outside-home");
      assert.equal(fs.existsSync(victim), true);
    } finally {
      cleanup();
    }
  });
});

describe("botd hygiene: CARGO_TARGET_DIR points outside the working trees (OPE-12110)", () => {
  const dockerfile = fs.readFileSync(new URL("../../../docker/bot-runtime/Dockerfile", import.meta.url), "utf8");
  const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM python:3.13-slim AS runtime"));
  const envValue = /^\s*CARGO_TARGET_DIR=(\S+)/m.exec(runtimeStage)?.[1];

  it("the runtime image sets CARGO_TARGET_DIR, so cargo never creates target/ in a checkout", () => {
    assert.ok(envValue, "the runtime stage must set CARGO_TARGET_DIR");
    assert.ok(path.isAbsolute(envValue));
    for (const workTree of ["/workspace", "/scratch", "/workspace/OPE-12110", "/scratch/OPE-12110/repo"]) {
      const rel = path.relative(workTree, envValue);
      assert.ok(rel.startsWith(".."), `${envValue} must not be inside ${workTree}`);
    }
  });

  it("is exactly the directory botd keeps under its quota, inside the bot's home", () => {
    assert.equal(envValue, cargoTargetDir("/data/hermes"));
    assert.equal(CARGO_TARGET_SUBPATH, path.join(".cache", "cargo-target"));
  });

  it("botd reads both quotas from the grace and from env, in the routine and the pressure pass", () => {
    const botd = fs.readFileSync(new URL("../../../docker/bot-runtime/botd/botd", import.meta.url), "utf8");
    for (const name of ["MYRMIDON_BOTD_NPM_NPX_QUOTA_BYTES", "MYRMIDON_BOTD_CARGO_TARGET_QUOTA_BYTES"]) {
      assert.equal(botd.split(name).length - 1, 2, `${name} must feed both cleanCaches calls`);
    }
    assert.match(botd, /pick\(g\.npmNpxQuotaBytes,/);
    assert.match(botd, /pick\(g\.cargoTargetQuotaBytes,/);
  });
});
