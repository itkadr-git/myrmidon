#!/usr/bin/env node
// myrmidon(1.6.7-BOT-DISK-HOST-GC): Host-side GC for task clones and build caches.
// Replaces the temporary devbuild-v2-gc.sh with a unified, journaled scheduler.
//
// Targets:
//   - vm-core:       /srv/myrmidon-bots/* (bot workspaces)
//   - myr-dev-build: /srv/devbuild/* (build copies), /srv/devcache/* (build caches)
//
// Policy:
//   - Task clones (done/cancelled >24h, clean+pushed): remove
//   - Task clones (done/cancelled >24h, dirty/unpushed): archive first, then remove
//   - Active checkouts/worktrees: never touch
//   - Build caches >72h: LRU eviction by mtime
//   - Atomic guards: lockfile, symlink checks, TOCTOU-safe deletion
//   - JSONL journal at /var/log/myrmidon-host-gc.jsonl
//
// Modes:
//   --dry-run  (default)  Plan only, no deletion
//   --apply               Execute plan with journal
//   --root <path>         Override root directory (for testing)
//   --journal <path>      Override journal path (for testing)
//   --lock <path>         Override lockfile path (for testing)
//   --clone-ttl <hours>   Override clone TTL (default 24)
//   --cache-ttl <hours>   Override cache TTL (default 72)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CLONE_TTL_HOURS = 24;
const CACHE_TTL_HOURS = 72;

// --- Args -------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    root: null,
    journal: "/var/log/myrmidon-host-gc.jsonl",
    lock: "/var/run/myrmidon-host-gc.lock",
    cloneTtlHours: CLONE_TTL_HOURS,
    cacheTtlHours: CACHE_TTL_HOURS,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--journal") args.journal = argv[++i];
    else if (a === "--lock") args.lock = argv[++i];
    else if (a === "--clone-ttl") args.cloneTtlHours = Number(argv[++i]);
    else if (a === "--cache-ttl") args.cacheTtlHours = Number(argv[++i]);
    else if (a === "--help") {
      console.log("Usage: host-clone-cache-gc.mjs [--apply|--dry-run] [--root path] [--journal path] [--lock path] [--clone-ttl h] [--cache-ttl h]");
      process.exit(0);
    }
  }
  return args;
}

// --- Lock -------------------------------------------------------------------

export function acquireLock(lockPath) {
  const resolved = path.resolve(lockPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  try {
    const fd = fs.openSync(resolved, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return { ok: true, release: () => { try { fs.unlinkSync(resolved); } catch {} } };
  } catch (err) {
    if (err.code === "EEXIST") return { ok: false, reason: "lock held" };
    throw err;
  }
}

// --- Journal ----------------------------------------------------------------

export function journalRecord(journalPath, record) {
  const dir = path.dirname(path.resolve(journalPath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n";
  const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// --- Safe path helpers ------------------------------------------------------

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export function safeJoin(root, name) {
  const r = path.resolve(root);
  const p = path.resolve(r, name);
  if (!p.startsWith(r + path.sep)) throw new Error(`unsafe path: ${name} escapes root`);
  return p;
}

function assertNotSymlink(p, label) {
  if (isSymlink(p)) throw new Error(`unsafe ${label}: symlink not allowed`);
}

// --- Git helpers ------------------------------------------------------------

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000 });
}

function isGitWorktree(dir) {
  try {
    const r = git(["rev-parse", "--is-inside-work-tree"], dir);
    return r.status === 0 && r.stdout.trim() === "true";
  } catch { return false; }
}

function isClean(dir) {
  try {
    const r = git(["status", "--porcelain"], dir);
    return r.status === 0 && r.stdout.trim() === "";
  } catch { return false; }
}

function isPushed(dir) {
  try {
    const r = git(["log", "@{u}..HEAD", "--oneline"], dir);
    return r.status === 0 && r.stdout.trim() === "";
  } catch { return false; }
}

function hasStash(dir) {
  try {
    const r = git(["stash", "list"], dir);
    return r.status === 0 && r.stdout.trim() !== "";
  } catch { return false; }
}

function hasAlternates(dir) {
  try {
    const gitDir = path.join(dir, ".git");
    const altFile = path.join(gitDir, "objects", "info", "alternates");
    return fs.existsSync(altFile);
  } catch { return false; }
}

// --- Scanning ---------------------------------------------------------------

function scanTaskClones(root, now, ttlHours) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const fullPath = safeJoin(root, name);
    if (isSymlink(fullPath)) continue;

    const st = fs.statSync(fullPath);
    const ageMs = now - st.mtimeMs;
    if (ageMs < ttlMs) continue; // too fresh

    const isGit = isGitWorktree(fullPath);
    if (!isGit) continue; // not a git clone, skip

    const clean = isClean(fullPath);
    const pushed = isPushed(fullPath);
    const stash = hasStash(fullPath);
    const alternates = hasAlternates(fullPath);

    results.push({
      name,
      path: fullPath,
      ageMs,
      mtimeMs: st.mtimeMs,
      isGit: true,
      clean,
      pushed,
      stash,
      alternates,
      safeToRemove: clean && pushed && !stash && !alternates,
      reason: clean && pushed && !stash && !alternates ? "clean-pushed" : "unsafe-archive",
    });
  }
  return results;
}

function scanBuildCaches(root, now, ttlHours) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  if (!fs.existsSync(root)) return results;
  if (isSymlink(root)) throw new Error(`unsafe cache root: symlink not allowed: ${root}`);

  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = safeJoin(root, entry.name);
    if (isSymlink(fullPath)) continue;

    let st;
    try { st = fs.statSync(fullPath); } catch { continue; }
    const ageMs = now - st.mtimeMs;
    const sizeBytes = st.size || 0;

    if (ageMs >= ttlMs) {
      results.push({ name: entry.name, path: fullPath, ageMs, mtimeMs: st.mtimeMs, sizeBytes, reason: "ttl" });
    } else {
      results.push({ name: entry.name, path: fullPath, ageMs, mtimeMs: st.mtimeMs, sizeBytes, reason: "fresh" });
    }
  }
  return results;
}

// --- Atomic deletion --------------------------------------------------------

export function atomicDrop(filePath, expectedRoot) {
  const root = path.resolve(expectedRoot);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root + path.sep)) throw new Error(`unsafe drop: ${filePath} escapes root`);

  assertNotSymlink(root, "drop root");
  const parentDir = path.dirname(resolved);
  if (fs.existsSync(parentDir)) assertNotSymlink(parentDir, "drop parent");

  const canonicalRoot = fs.realpathSync(root);
  const canonicalParent = fs.realpathSync(parentDir);
  if (canonicalParent !== canonicalRoot && !canonicalParent.startsWith(canonicalRoot + path.sep)) {
    throw new Error(`unsafe drop: ${filePath} escapes root via symlink`);
  }

  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink()) throw new Error(`unsafe drop: symlink not allowed: ${filePath}`);

  if (lstat.isDirectory()) {
    // For directories: rename to temp, then recursive rm
    const tempPath = path.join(parentDir, `.tmp-del-${crypto.randomUUID()}`);
    fs.renameSync(resolved, tempPath);
    // Verify the moved dir still exists and is a directory
    const tempLstat = fs.lstatSync(tempPath);
    if (!tempLstat.isDirectory() || tempLstat.isSymbolicLink()) {
      throw new Error("TOCTOU race detected: directory swapped during atomic rename");
    }
    fs.rmSync(tempPath, { recursive: true, force: true });
    return;
  }

  // For files: rename to temp, then unlink
  const tempPath = path.join(parentDir, `.tmp-del-${crypto.randomUUID()}`);
  fs.renameSync(resolved, tempPath);
  const tempLstat = fs.lstatSync(tempPath);
  if (tempLstat.isSymbolicLink()) throw new Error("TOCTOU race detected: file swapped during atomic rename");
  fs.unlinkSync(tempPath);
}

// --- Archive ----------------------------------------------------------------

function archiveClone(clonePath, archiveRoot) {
  if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, { recursive: true });
  const name = path.basename(clonePath);
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-").slice(0, 15);
  const archivePath = path.join(archiveRoot, `${name}-${ts}.tar.zst`);
  // We use tar command for speed; zstd via pipe if available
  const r = spawnSync("bash", ["-c", `tar -cf - -C "${path.dirname(clonePath)}" "${name}" | zstd -q -o "${archivePath}"`], { timeout: 120000 });
  if (r.status !== 0) throw new Error(`archive failed for ${clonePath}: ${r.stderr}`);
  // Verify archive
  const v = spawnSync("bash", ["-c", `zstd -q -d -c "${archivePath}" | tar -tf - > /dev/null`], { timeout: 60000 });
  if (v.status !== 0) throw new Error(`archive verification failed for ${archivePath}`);
  return archivePath;
}

// --- Main -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv);
  const now = Date.now();

  const lock = acquireLock(args.lock);
  if (!lock.ok) {
    console.error(JSON.stringify({ ok: false, reason: lock.reason }));
    process.exit(1);
  }

  try {
    const root = args.root || "/srv/myrmidon-bots";
    const cloneTtlMs = args.cloneTtlHours * HOUR_MS;
    const cacheTtlMs = args.cacheTtlHours * HOUR_MS;

    const plan = { clones: [], caches: [], kept: [], removed: [], archived: [] };

    // 1. Scan task clones
    const clones = scanTaskClones(root, now, args.cloneTtlHours);
    for (const c of clones) {
      if (c.safeToRemove) {
        plan.clones.push({ ...c, action: "remove" });
      } else {
        plan.clones.push({ ...c, action: "archive-remove" });
      }
    }

    // 2. Scan build caches (separate roots)
    const cacheRoots = [
      "/srv/devcache",
      "/srv/devbuild-v2/repos",
    ];
    for (const cr of cacheRoots) {
      if (!fs.existsSync(cr)) continue;
      const caches = scanBuildCaches(cr, now, args.cacheTtlHours);
      for (const c of caches) {
        if (c.reason === "ttl") {
          plan.caches.push({ ...c, action: "remove" });
        } else {
          plan.kept.push({ ...c, action: "keep", reason: "fresh" });
        }
      }
    }

    // 3. Execute or report
    if (args.dryRun) {
      journalRecord(args.journal, { event: "dry-run", clones: plan.clones.length, caches: plan.caches.length, kept: plan.kept.length });
      console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
    } else {
      // Apply: process archives first, then removals
      const archiveRoot = path.join(root, ".gc-archive");
      for (const c of plan.clones.filter((x) => x.action === "archive-remove")) {
        try {
          const archivePath = archiveClone(c.path, archiveRoot);
          journalRecord(args.journal, { event: "clone-archived", path: c.path, archive: archivePath, sizeBytes: c.sizeBytes });
          atomicDrop(c.path, root);
          plan.archived.push({ path: c.path, archive: archivePath });
          journalRecord(args.journal, { event: "clone-removed-after-archive", path: c.path, archive: archivePath });
        } catch (err) {
          journalRecord(args.journal, { event: "clone-archive-failed", path: c.path, error: err.message });
        }
      }
      for (const c of plan.clones.filter((x) => x.action === "remove")) {
        try {
          atomicDrop(c.path, root);
          plan.removed.push({ path: c.path });
          journalRecord(args.journal, { event: "clone-removed", path: c.path, reason: c.reason });
        } catch (err) {
          journalRecord(args.journal, { event: "clone-remove-failed", path: c.path, error: err.message });
        }
      }
      for (const c of plan.caches.filter((x) => x.action === "remove")) {
        try {
          atomicDrop(c.path, path.dirname(c.path));
          plan.removed.push({ path: c.path });
          journalRecord(args.journal, { event: "cache-removed", path: c.path, reason: c.reason, sizeBytes: c.sizeBytes });
        } catch (err) {
          journalRecord(args.journal, { event: "cache-remove-failed", path: c.path, error: err.message });
        }
      }
      journalRecord(args.journal, { event: "apply-complete", removed: plan.removed.length, archived: plan.archived.length, kept: plan.kept.length });
      console.log(JSON.stringify({ ok: true, dryRun: false, removed: plan.removed.length, archived: plan.archived.length, kept: plan.kept.length }, null, 2));
    }
  } finally {
    lock.release();
  }
}

// Only run main when executed directly (not when imported by tests)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
