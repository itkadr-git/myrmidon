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
  return [...openPaths].some((openPath) => {
    if (openPath === targetPath) return true;
    const relative = path.relative(targetPath, openPath);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
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
 * Removes stale whole cache entries from an entry-based cache root (npm `_npx/<hash>`,
 * `_cacache` content/index shard dirs). An entry is one immediate child directory of
 * `rootDir`: it is deleted as a unit or kept as a unit — never file-by-file, which
 * would corrupt a half-loaded npx package or an npm cache shard.
 *
 * An entry is stale when its NEWEST mtime across the entry and all descendants is older
 * than `ttlMs`: cache use does not update mtime, so the policy remains explicitly mtime-based.
 *
 * An entry is protected when any open fd or process cwd lies at or under it
 * (prefix check via `isPathOpen`): a running npx MCP server keeps its entry.
 */
export function cleanEntryCache(rootDir, ttlMs, nowMs, openPaths) {
  const result = { cleanedFiles: 0, cleanedBytes: 0, skippedOpen: 0, keptFresh: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name);
    try {
      // Newest mtime/atime across the entry dir and its immediate children: an entry
      // recently read (atime) or written (mtime) is fresh, one untouched past the
      // TTL is stale and goes as a whole.
      let newest = 0;
      const note = (st) => {
        newest = Math.max(newest, st.mtimeMs);
      };
      const noteTree = (dir) => {
        for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
          const childPath = path.join(dir, child.name);
          try {
            const st = fs.lstatSync(childPath);
            note(st);
            // Walk the full subtree: cacache content/index leaves are nested
            // several levels deep, and a recently accessed blob keeps its shard.
            if (st.isDirectory()) noteTree(childPath);
          } catch {}
        }
      };
      note(fs.statSync(candidate));
      noteTree(candidate);
      if (nowMs - newest < ttlMs) {
        result.keptFresh += 1;
        continue;
      }
      if (isPathOpen(candidate, openPaths)) {
        result.skippedOpen += 1;
        continue;
      }
      // measure before removing: the report shows how many files/bytes went away
      let size = 0;
      let files = 0;
      const walk = (dir) => {
        for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, item.name);
          let st;
          try {
            st = fs.lstatSync(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            walk(p);
          } else {
            size += st.size;
            files += 1;
          }
        }
      };
      walk(candidate);
      fs.rmSync(candidate, { recursive: true, force: true });
      result.cleanedFiles += files;
      result.cleanedBytes += size;
    } catch {
      // unreadable entry: leave it exactly where it is
    }
  }
  return result;
}

/**
 * Performs routine or pressure cache hygiene.
 */
export async function cleanCaches(options = {}) {
  const hermesHome = options.hermesHome || process.env.HERMES_HOME || "/data/hermes";
  const nowMs = typeof options.now === "number" ? options.now : (options.now instanceof Date ? options.now.getTime() : Date.now());
  const openPaths = options.openPaths || collectOpenPaths(options.procDir);

  const limits = {
    npmCacheTtlMs: (options.limits?.npmCacheTtlHours ?? options.npmCacheTtlHours ?? HYGIENE_DEFAULTS.npmCacheTtlHours) * HOUR,
    uvCacheTtlMs: (options.limits?.uvCacheTtlHours ?? options.uvCacheTtlHours ?? HYGIENE_DEFAULTS.uvCacheTtlHours) * HOUR,
    terminalOutputTtlMs: (options.limits?.terminalOutputTtlHours ?? options.terminalOutputTtlHours ?? HYGIENE_DEFAULTS.terminalOutputTtlHours) * HOUR,
  };

  const uvCacheDir = options.uvCacheDir || path.join(hermesHome, ".cache", "uv");

  // Whole-entry targets (review 31.10): `_npx/<hash>` installs and `_cacache`
  // content/index shard dirs must be deleted as a unit or kept as a unit — a
  // per-file walk leaves half-loaded packages ("Cannot find module") and broken
  // cacache shards behind. uv is NOT walked at all: `uv cache prune`/`clean`
  // own the layout (archive-v0 hardlinks, .lock files).
  const targets = [
    { name: "npm-cacache", dir: path.join(hermesHome, ".npm", "_cacache", "content-v2"), mode: "tree-entry" },
    { name: "npm-cacache-index", dir: path.join(hermesHome, ".npm", "_cacache", "index-v5"), mode: "tree-entry" },
    { name: "npm-npx", dir: path.join(hermesHome, ".npm", "_npx"), mode: "entry" },
    { name: "terminal-output", dir: path.join(hermesHome, "cache", "terminal-output"), mode: "walk" },
  ];

  let totalFiles = 0;
  let totalBytes = 0;
  let totalSkippedOpen = 0;
  let totalKept = 0;
  const targetResults = {};

  for (const t of targets) {
    const ttlMs = t.name === "npm-cacache" || t.name === "npm-cacache-index" || t.name === "npm-npx"
      ? limits.npmCacheTtlMs
      : limits.terminalOutputTtlMs;
    const res = t.mode === "walk" ? cleanTargetDir(t.dir, ttlMs, nowMs, openPaths) : cleanEntryCache(t.dir, ttlMs, nowMs, openPaths);
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

  if (typeof options.execFile === "function" && fs.existsSync(uvCacheDir)) {
    const uv = await cleanUvCache({
      hermesHome,
      uvCacheDir,
      pressure: options.pressure,
      execFile: options.execFile,
      log: options.log,
    });
    targetResults["uv-cache"] = uv;
  }

  if (typeof options.log === "function" && (totalFiles > 0 || totalSkippedOpen > 0)) {
    options.log(`botd hygiene: cleaned ${totalFiles} cache files (${totalBytes} bytes), skipped ${totalSkippedOpen} open`);
  }

  return result;
}

/**
 * uv cache hygiene (review 31.10): the uv cache layout (archive-v0, wheels,
 * .lock files) is owned by uv itself — never walked file-by-file.
 * Routine pass: `uv cache prune` (drops unused archives).
 * Hard disk pressure: `uv cache clean` (empties the whole cache).
 * Returns { pruned: boolean, cleanedBytes: number|null, error?: string }.
 */
export async function cleanUvCache(options = {}) {
  const hermesHome = options.hermesHome || process.env.HERMES_HOME || "/data/hermes";
  const uvCacheDir = options.uvCacheDir || path.join(hermesHome, ".cache", "uv");
  const level = options.pressure || "none";
  const execFile = options.execFile || null;
  const log = options.log ?? (() => {});

  if (!fs.existsSync(uvCacheDir)) {
    return { pruned: false, cleanedBytes: null };
  }
  if (typeof execFile !== "function") {
    return { pruned: false, cleanedBytes: null, error: "no execFile" };
  }

  const sizeBefore = dirSize(uvCacheDir);
  const cmd = level === "hard" ? "clean" : "prune";
  try {
    const run = execFile.length >= 4
      ? await import("node:util").then(({ promisify }) => promisify(execFile))
      : execFile;
    // UV_CACHE_DIR scopes the command to this bot's uv cache; home stays untouched
    await run("uv", ["cache", cmd], { env: { ...process.env, UV_CACHE_DIR: uvCacheDir } });
    const sizeAfter = dirSize(uvCacheDir);
    const freed = sizeBefore - sizeAfter;
    log(`botd hygiene: uv cache ${cmd} freed ${freed} bytes`);
    return { pruned: true, cleanedBytes: freed };
  } catch (err) {
    return { pruned: false, cleanedBytes: null, error: String(err && err.message ? err.message : err) };
  }
}

/** Best-effort recursive directory size in bytes (0 when unreadable). */
function dirSize(dir) {
  let total = 0;
  const walk = (current) => {
    let items = [];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const p = path.join(current, item.name);
      if (item.isDirectory()) {
        walk(p);
      } else {
        try {
          total += fs.lstatSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}
