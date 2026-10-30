import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  cleanCaches,
  cleanTargetDir,
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

  it("cleans all configured cache directories (npm _cacache, _npx, uv, terminal-output)", () => {
    const { tmp, cleanup } = createTempFixture();
    try {
      const now = Date.now();
      const hermesHome = path.join(tmp, "hermes");

      const cacacheDir = path.join(hermesHome, ".npm", "_cacache", "content-v2", "12");
      const npxDir = path.join(hermesHome, ".npm", "_npx", "pkg-abc");
      const uvDir = path.join(hermesHome, ".cache", "uv", "built-v0");
      const termDir = path.join(hermesHome, "cache", "terminal-output");

      fs.mkdirSync(cacacheDir, { recursive: true });
      fs.mkdirSync(npxDir, { recursive: true });
      fs.mkdirSync(uvDir, { recursive: true });
      fs.mkdirSync(termDir, { recursive: true });

      // Stale files:
      // npm: 50h old (default TTL 48h)
      const staleCacache = path.join(cacacheDir, "data.bin");
      const staleNpx = path.join(npxDir, "cli.js");
      fs.writeFileSync(staleCacache, "cacache-data");
      fs.writeFileSync(staleNpx, "npx-data");
      const npmStaleTime = new Date(now - 50 * HOUR);
      fs.utimesSync(staleCacache, npmStaleTime, npmStaleTime);
      fs.utimesSync(staleNpx, npmStaleTime, npmStaleTime);

      // uv: 8 days old (default TTL 168h = 7 days)
      const staleUv = path.join(uvDir, "wheel.whl");
      fs.writeFileSync(staleUv, "wheel-data");
      const uvStaleTime = new Date(now - 8 * 24 * HOUR);
      fs.utimesSync(staleUv, uvStaleTime, uvStaleTime);

      // terminal-output: 25h old (default TTL 24h)
      const staleTerm = path.join(termDir, "term.log");
      fs.writeFileSync(staleTerm, "term-output");
      const termStaleTime = new Date(now - 25 * HOUR);
      fs.utimesSync(staleTerm, termStaleTime, termStaleTime);

      // Fresh files:
      const freshCacache = path.join(cacacheDir, "fresh.bin");
      fs.writeFileSync(freshCacache, "fresh-cacache");
      const freshTime = new Date(now - 2 * HOUR);
      fs.utimesSync(freshCacache, freshTime, freshTime);

      const logs = [];
      const res = cleanCaches({
        hermesHome,
        now,
        openPaths: new Set(),
        log: (msg) => logs.push(msg),
      });

      assert.equal(res.cleanedFiles, 4);
      assert.equal(res.keptFresh, 1);
      assert.equal(fs.existsSync(staleCacache), false);
      assert.equal(fs.existsSync(staleNpx), false);
      assert.equal(fs.existsSync(staleUv), false);
      assert.equal(fs.existsSync(staleTerm), false);
      assert.equal(fs.existsSync(freshCacache), true);

      assert.ok(logs.length > 0);
      assert.ok(logs[0].includes("botd hygiene: cleaned 4 cache files"));
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
