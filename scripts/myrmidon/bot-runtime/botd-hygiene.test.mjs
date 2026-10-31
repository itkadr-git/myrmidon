import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cleanCaches,
  cleanEntryCache,
  cleanTargetDir,
  cleanUvCache,
  collectOpenPaths,
  HYGIENE_DEFAULTS,
  isPathOpen,
} from "../../../docker/bot-runtime/botd/lib/hygiene.js";

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
      const freshCacache = path.join(hermesHome, ".npm", "_cacache", "content-v2", "12", "56", "fresh.bin");
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
