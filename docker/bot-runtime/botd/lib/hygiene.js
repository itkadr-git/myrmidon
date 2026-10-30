// myrmidon(1.6.6 OPE-10039): Periodic bot runtime cache hygiene.
// Removes stale npm (_cacache, _npx), uv, and terminal-output files older
// than their configured mtime TTLs.
// Protects any file or directory currently open by a process.

import fs from "node:fs";
import path from "node:path";

const HOUR = 60 * 60 * 1000;

export const HYGIENE_DEFAULTS = Object.freeze({
  npmCacheTtlHours: 48, // 2 days
  uvCacheTtlHours: 168, // 7 days
  terminalOutputTtlHours: 24, // 24 hours
});

/**
 * Collect all open file targets and working directories from /proc/<pid>/fd and /proc/<pid>/cwd.
 * Returns a Set of canonical/resolved string paths.
 */
export function collectOpenPaths(procDir = "/proc") {
  const open = new Set();
  let pids = [];
  try {
    pids = fs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
  } catch {
    return open;
  }
  for (const pid of pids) {
    const fdDir = path.join(procDir, pid, "fd");
    let fds = [];
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(path.join(fdDir, fd));
        open.add(link);
        try {
          open.add(fs.realpathSync(link));
        } catch {}
      } catch {}
    }
    try {
      const cwd = fs.readlinkSync(path.join(procDir, pid, "cwd"));
      open.add(cwd);
      try {
        open.add(fs.realpathSync(cwd));
      } catch {}
    } catch {}
  }
  return open;
}

/**
 * Checks if a target file or directory is considered open.
 */
export function isPathOpen(targetPath, openPaths) {
  if (!openPaths || openPaths.size === 0) return false;
  if (openPaths.has(targetPath)) return true;
  try {
    const real = fs.realpathSync(targetPath);
    if (openPaths.has(real)) return true;
  } catch {}
  return false;
}

/**
 * Recursively cleans files older than ttlMs in rootDir, skipping any file open by a process.
 * Prunes empty directories bottom-up (except rootDir itself) if they are stale and not open.
 */
export function cleanTargetDir(rootDir, ttlMs, nowMs, openPaths) {
  let cleanedFiles = 0;
  let cleanedBytes = 0;
  let skippedOpen = 0;
  let keptFresh = 0;

  if (!fs.existsSync(rootDir)) {
    return { cleanedFiles, cleanedBytes, skippedOpen, keptFresh };
  }

  function walk(currentDir) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        // After cleaning children, if directory is empty, stale, and not open, prune it
        try {
          const remaining = fs.readdirSync(fullPath);
          if (remaining.length === 0 && !isPathOpen(fullPath, openPaths)) {
            let dirSt;
            try {
              dirSt = fs.statSync(fullPath);
            } catch {}
            if (!dirSt || nowMs - dirSt.mtimeMs >= ttlMs) {
              fs.rmdirSync(fullPath);
            }
          }
        } catch {}
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        let st;
        try {
          st = fs.lstatSync(fullPath);
        } catch {
          continue;
        }

        const ageMs = nowMs - st.mtimeMs;
        if (ageMs < ttlMs) {
          keptFresh++;
          continue;
        }

        // Stale: older than TTL by mtime
        if (isPathOpen(fullPath, openPaths)) {
          skippedOpen++;
          continue;
        }

        try {
          fs.unlinkSync(fullPath);
          cleanedFiles++;
          cleanedBytes += st.size;
        } catch {
          // If deletion failed (e.g. permission/busy), leave it
        }
      }
    }
  }

  walk(rootDir);
  return { cleanedFiles, cleanedBytes, skippedOpen, keptFresh };
}

/**
 * Performs routine or pressure cache hygiene.
 */
export function cleanCaches(options = {}) {
  const hermesHome = options.hermesHome || process.env.HERMES_HOME || "/data/hermes";
  const nowMs = typeof options.now === "number" ? options.now : (options.now instanceof Date ? options.now.getTime() : Date.now());
  const openPaths = options.openPaths || collectOpenPaths(options.procDir);

  const limits = {
    npmCacheTtlMs: (options.limits?.npmCacheTtlHours ?? options.npmCacheTtlHours ?? HYGIENE_DEFAULTS.npmCacheTtlHours) * HOUR,
    uvCacheTtlMs: (options.limits?.uvCacheTtlHours ?? options.uvCacheTtlHours ?? HYGIENE_DEFAULTS.uvCacheTtlHours) * HOUR,
    terminalOutputTtlMs: (options.limits?.terminalOutputTtlHours ?? options.terminalOutputTtlHours ?? HYGIENE_DEFAULTS.terminalOutputTtlHours) * HOUR,
  };

  const uvCacheDir = options.uvCacheDir || (options.hermesHome ? path.join(hermesHome, ".cache", "uv") : (process.env.UV_CACHE_DIR || path.join(hermesHome, ".cache", "uv")));

  const targets = [
    { name: "npm-cacache", dir: path.join(hermesHome, ".npm", "_cacache"), ttlMs: limits.npmCacheTtlMs },
    { name: "npm-npx", dir: path.join(hermesHome, ".npm", "_npx"), ttlMs: limits.npmCacheTtlMs },
    { name: "uv-cache", dir: uvCacheDir, ttlMs: limits.uvCacheTtlMs },
    { name: "terminal-output", dir: path.join(hermesHome, "cache", "terminal-output"), ttlMs: limits.terminalOutputTtlMs },
  ];

  let totalFiles = 0;
  let totalBytes = 0;
  let totalSkippedOpen = 0;
  let totalKept = 0;
  const targetResults = {};

  for (const t of targets) {
    const res = cleanTargetDir(t.dir, t.ttlMs, nowMs, openPaths);
    targetResults[t.name] = res;
    totalFiles += res.cleanedFiles;
    totalBytes += res.cleanedBytes;
    totalSkippedOpen += res.skippedOpen;
    totalKept += res.keptFresh;
  }

  const result = {
    cleanedFiles: totalFiles,
    cleanedBytes: totalBytes,
    skippedOpen: totalSkippedOpen,
    keptFresh: totalKept,
    targets: targetResults,
  };

  if (typeof options.log === "function" && (totalFiles > 0 || totalSkippedOpen > 0)) {
    options.log(`botd hygiene: cleaned ${totalFiles} cache files (${totalBytes} bytes), skipped ${totalSkippedOpen} open`);
  }

  return result;
}
