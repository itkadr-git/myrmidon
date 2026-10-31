// myrmidon(1.6.6-BOT-DISK-CACHE): Cache retention lifecycle (OPE-9330 / OPE-9714).
// Cache files >3d are pruned based strictly on mtime (not atime).
// Under quota pressure, LRU eviction orders by oldest mtime first.
// Never delete state.db or session/auth files.
// TOCTOU race safety and durable audit.

import fs from "node:fs";
import path from "node:path";

export const CACHE_MAX_AGE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function safeDropCacheFile(file, cacheRoot) {
  const root = path.resolve(cacheRoot);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("unsafe cache file path: outside cache root");
  }
  if (/(^|[/\\])(state\.db|session|auth|credential|\.git)/i.test(path.basename(file))) {
    throw new Error("never delete protected file: " + file);
  }
  const lstat = fs.lstatSync(file);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.nlink !== 1) {
    throw new Error("unsafe file type or symlink: " + file);
  }
  // TOCTOU race check: open with O_NOFOLLOW and verify inode & dev match
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const fstat = fs.fstatSync(fd);
    if (fstat.ino !== lstat.ino || fstat.dev !== lstat.dev || !fstat.isFile() || fstat.nlink !== 1) {
      throw new Error("TOCTOU race detected: file changed between stat and open");
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
}

function cacheAudit(cacheRoot, record) {
  const journalPath = path.join(cacheRoot, "cache-retention-journal.jsonl");
  const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error("unsafe cache retention journal");
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function cacheRetentionPass(cacheRoot, opts = {}) {
  const now = opts.now || new Date();
  const maxAgeMs = (opts.maxAgeDays ?? CACHE_MAX_AGE_DAYS) * DAY_MS;
  const capBytes = opts.capBytes ?? Infinity;

  if (!fs.existsSync(cacheRoot)) {
    return { ok: true, removed: [], kept: [], remainingBytes: 0 };
  }

  const rootSt = fs.lstatSync(cacheRoot);
  if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) {
    throw new Error("unsafe cache root directory");
  }

  const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  const candidates = [];
  const kept = [];
  let totalBytes = 0;

  for (const entry of entries) {
    const fullPath = path.join(cacheRoot, entry.name);
    // Never touch symlinks or directories or journals
    if (entry.isSymbolicLink() || entry.isDirectory()) continue;
    if (entry.name.endsWith("-journal.jsonl")) continue;

    // Never delete protected files
    if (/(^|[/\\])(state\.db|session|auth|credential|\.git)/i.test(entry.name)) {
      kept.push({ name: entry.name, reason: "protected" });
      continue;
    }

    const st = fs.lstatSync(fullPath);
    if (!st.isFile()) continue;

    totalBytes += st.size;
    // Strict mtime evaluation (atime is ignored)
    const ageMs = now.getTime() - st.mtimeMs;

    if (ageMs > maxAgeMs) {
      candidates.push({ name: entry.name, fullPath, sizeBytes: st.size, mtimeMs: st.mtimeMs, ageMs, reason: "age" });
    } else {
      kept.push({ name: entry.name, sizeBytes: st.size, mtimeMs: st.mtimeMs, reason: "fresh" });
    }
  }

  // LRU sorting: oldest mtime first
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

  const removed = [];

  for (const item of candidates) {
    if (opts.dryRun) {
      removed.push({ name: item.name, sizeBytes: item.sizeBytes, reason: item.reason });
      totalBytes -= item.sizeBytes;
      continue;
    }

    cacheAudit(cacheRoot, {
      at: now.toISOString(),
      action: "cache-delete-intent",
      file: item.name,
      sizeBytes: item.sizeBytes,
      mtime: new Date(item.mtimeMs).toISOString(),
      reason: item.reason,
    });

    try {
      safeDropCacheFile(item.fullPath, cacheRoot);
      totalBytes -= item.sizeBytes;
      removed.push({ name: item.name, sizeBytes: item.sizeBytes, reason: item.reason });
      cacheAudit(cacheRoot, {
        at: now.toISOString(),
        action: "cache-deleted",
        file: item.name,
        sizeBytes: item.sizeBytes,
        mtime: new Date(item.mtimeMs).toISOString(),
        reason: item.reason,
      });
    } catch (err) {
      cacheAudit(cacheRoot, {
        at: now.toISOString(),
        action: "cache-delete-failed",
        file: item.name,
        reason: err.message,
      });
      kept.push({ name: item.name, sizeBytes: item.sizeBytes, reason: "delete_failed" });
    }
  }

  // If still over capBytes under quota pressure, evict from kept if allowed, ordered by LRU (oldest mtime)
  if (totalBytes > capBytes) {
    const evictable = kept.filter((x) => x.reason === "fresh" && x.fullPath);
    evictable.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const item of evictable) {
      if (totalBytes <= capBytes) break;
      if (opts.dryRun) {
        removed.push({ name: item.name, sizeBytes: item.sizeBytes, reason: "lru_cap" });
        totalBytes -= item.sizeBytes;
        continue;
      }
      cacheAudit(cacheRoot, {
        at: now.toISOString(),
        action: "cache-delete-intent",
        file: item.name,
        sizeBytes: item.sizeBytes,
        mtime: new Date(item.mtimeMs).toISOString(),
        reason: "lru_cap",
      });
      try {
        safeDropCacheFile(item.fullPath, cacheRoot);
        totalBytes -= item.sizeBytes;
        removed.push({ name: item.name, sizeBytes: item.sizeBytes, reason: "lru_cap" });
        cacheAudit(cacheRoot, {
          at: now.toISOString(),
          action: "cache-deleted",
          file: item.name,
          sizeBytes: item.sizeBytes,
          mtime: new Date(item.mtimeMs).toISOString(),
          reason: "lru_cap",
        });
      } catch (err) {
        cacheAudit(cacheRoot, { at: now.toISOString(), action: "cache-delete-failed", file: item.name, reason: err.message });
      }
    }
  }

  return { ok: true, removed, kept, remainingBytes: Math.max(0, totalBytes) };
}
