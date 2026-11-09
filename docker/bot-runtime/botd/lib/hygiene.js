// myrmidon(1.6.6 OPE-10039): Periodic bot runtime cache hygiene.
// Removes stale npm (_cacache, _npx), uv, and terminal-output files older
// than their configured mtime TTLs.
// myrmidon(OPE-12110): two byte quotas on top of the age rules, both evicting
// whole entries, oldest mtime first (LRU by mtime), never an open path:
//   * `hermes/.npm/_npx`            - `npmNpxQuotaBytes`, 512 MiB per bot;
//   * `hermes/.cache/cargo-target`  - `cargoTargetQuotaBytes`, 2 GiB per bot
//     (the per-bot `CARGO_TARGET_DIR` the image sets, outside every task tree).
// Protects any file or directory currently open by a process.

import fs from "node:fs";
import path from "node:path";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const HYGIENE_DEFAULTS = Object.freeze({
  npmCacheTtlHours: 48, // 2 days
  npxTtlHours: 24, // 24 hours
  npmCacheCapBytes: 1024 * 1024 * 1024, // 1 GiB
  npmCacacheQuotaBytes: 512 * 1024 * 1024, // OPE-12497: per-bot _cacache ceiling
  uvCacheTtlHours: 168, // 7 days
  terminalOutputTtlHours: 24, // 24 hours
  // myrmidon(OPE-12110): total ceiling for `hermes/.npm/_npx`, in bytes. An
  // `npx` run of a vendor CLI installs a whole package tree under `_npx/<hash>`;
  // one bot reached 2.2 GB in 45 minutes. TTL alone never caught it, because
  // the trees were written continuously and stayed "fresh".
  npmNpxQuotaBytes: 512 * 1024 * 1024, // 512 MiB
  // myrmidon(OPE-12110): total ceiling for the per-bot cargo target dir
  // (`hermes/.cache/cargo-target`); a Rust `target/` reached 2.4 GB in a task tree.
  cargoTargetQuotaBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
  // myrmidon(OPE-12110): a quota pass never evicts an entry written within this
  // window: an npx install or a cargo build that is still going has not opened
  // the file yet, or holds it only between two writes.
  quotaFreshGraceMinutes: 15,
});

/** Where the per-bot cargo target dir lives under HERMES_HOME (the image's `CARGO_TARGET_DIR`). */
export const CARGO_TARGET_SUBPATH = path.join(".cache", "cargo-target");

/** Absolute path of the per-bot cargo target dir for a given HERMES_HOME. */
export function cargoTargetDir(hermesHome) {
  return path.join(hermesHome, CARGO_TARGET_SUBPATH);
}

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
 * Size, file count and newest mtime of one cache entry (a directory): the entry
 * itself and its whole subtree. Symlinks are measured as links, never followed.
 * Throws when the entry directory itself is unreadable (the caller leaves it
 * alone); an unreadable descendant is skipped.
 */
function measureEntry(entryDir) {
  const m = { size: 0, files: 0, newest: fs.statSync(entryDir).mtimeMs };
  const walk = (dir) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const childPath = path.join(dir, child.name);
      try {
        const st = fs.lstatSync(childPath);
        m.newest = Math.max(m.newest, st.mtimeMs);
        // Walk the full subtree: cacache content/index leaves are nested several
        // levels deep, and a recently written blob keeps its shard fresh.
        if (st.isDirectory()) {
          walk(childPath);
        } else {
          m.size += st.size;
          m.files += 1;
        }
      } catch {}
    }
  };
  walk(entryDir);
  return m;
}

/**
 * The byte quota of one cache root (myrmidon OPE-12110): when the entries that
 * survived the age pass still weigh more than `quotaBytes`, whole entries are
 * removed LRU by mtime - the one whose newest write is oldest goes first - until
 * the total fits. An entry is never evicted when
 *   - a live process holds it open (fd or cwd at or under it; its bytes still
 *     count against the quota), or
 *   - it was written within `freshGraceMs` (an install or build still going).
 * So the quota can stay exceeded for a pass; the next pass retries.
 *
 * `units` are `{ path, size, files, newest, open }`. Returns the counters of
 * this pass only; the caller merges them into its own result.
 */
function evictOldestToQuota(units, quotaBytes, nowMs, freshGraceMs) {
  const out = { quotaEvicted: 0, quotaSkippedFresh: 0, cleanedFiles: 0, cleanedBytes: 0, keptBytes: 0 };
  let total = units.reduce((sum, u) => sum + u.size, 0);
  if (quotaBytes > 0 && total > quotaBytes) {
    const oldestFirst = [...units].sort((a, b) => a.newest - b.newest || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const u of oldestFirst) {
      if (total <= quotaBytes) break;
      if (u.open) continue;
      if (nowMs - u.newest < freshGraceMs) {
        out.quotaSkippedFresh += 1;
        continue;
      }
      try {
        fs.rmSync(u.path, { recursive: true, force: true });
      } catch {
        // left in place: it still counts toward the total, as it still occupies it
        continue;
      }
      total -= u.size;
      out.cleanedFiles += u.files;
      out.cleanedBytes += u.size;
      out.quotaEvicted += 1;
    }
  }
  out.keptBytes = total;
  return out;
}

/**
 * Removes stale whole cache entries from an entry-based cache root (npm `_npx/<hash>`,
 * `_cacache` content/index shard dirs). An entry is one immediate child directory of
 * `rootDir`: it is deleted as a unit or kept as a unit - never file-by-file, which
 * would corrupt a half-loaded npx package or an npm cache shard.
 *
 * An entry is stale when its NEWEST mtime across the entry and all descendants is older
 * than `ttlMs`: cache use does not update mtime, so the policy remains explicitly mtime-based.
 *
 * An entry is protected when any open fd or process cwd lies at or under it
 * (prefix check via `isPathOpen`): a running npx MCP server keeps its entry.
 *
 * With `quotaBytes > 0` (myrmidon OPE-12110, `_npx` only) a second pass bounds the
 * root: if the entries that survived the age pass still exceed the quota, the
 * least recently written go first (see `evictOldestToQuota`). The quota pass is
 * reported apart from the age pass (`quotaEvicted`, `quotaSkippedFresh`, `keptBytes`).
 */
export function cleanEntryCache(rootDir, ttlMs, nowMs, openPaths, quotaBytes = 0, quotaFreshGraceMs = 0) {
  const result = {
    cleanedFiles: 0,
    cleanedBytes: 0,
    skippedOpen: 0,
    keptFresh: 0,
    quotaEvicted: 0,
    quotaSkippedFresh: 0,
    keptBytes: 0,
  };
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return result;
  }

  const survivors = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name);
    try {
      const { size, files, newest } = measureEntry(candidate);
      const open = isPathOpen(candidate, openPaths);
      const unit = { path: candidate, size, files, newest, open };
      if (nowMs - newest < ttlMs) {
        result.keptFresh += 1;
        survivors.push(unit);
        continue;
      }
      if (open) {
        // Stale but held by a live process: never evicted - neither by age nor
        // by the quota - and its bytes still count against the ceiling.
        result.skippedOpen += 1;
        survivors.push(unit);
        continue;
      }
      // Stale: the whole entry goes, and the report shows how much went away.
      fs.rmSync(candidate, { recursive: true, force: true });
      result.cleanedFiles += files;
      result.cleanedBytes += size;
    } catch {
      // unreadable entry: leave it exactly where it is
    }
  }

  if (quotaBytes > 0 && survivors.length > 0) {
    const q = evictOldestToQuota(survivors, quotaBytes, nowMs, quotaFreshGraceMs);
    result.cleanedFiles += q.cleanedFiles;
    result.cleanedBytes += q.cleanedBytes;
    result.quotaEvicted = q.quotaEvicted;
    result.quotaSkippedFresh = q.quotaSkippedFresh;
    result.keptBytes = q.keptBytes;
  }

  return result;
}

/**
 * Byte quota for the per-bot cargo target dir (myrmidon OPE-12110): the image sets
 * `CARGO_TARGET_DIR=/data/hermes/.cache/cargo-target`, so every task of a bot builds
 * into that one directory, outside the task working trees. Its children
 * (`debug`, `release`, `<triple>/...`, `doc`) are the eviction units: removing one
 * costs a rebuild and nothing else, while half a profile dir would leave cargo
 * fingerprints pointing at missing artifacts. Same rules as `_npx`: whole entries,
 * LRU by mtime, open paths and entries written inside the fresh-grace window stay.
 *
 * A missing directory is a clean no-op (a bot that never ran cargo has none, and
 * nothing creates it here). A directory that resolves outside `options.root`
 * (a symlink out of HERMES_HOME) is left alone: botd never deletes through it.
 */
export function cleanCargoTarget(targetDir, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const result = {
    cleanedFiles: 0,
    cleanedBytes: 0,
    skippedOpen: 0,
    keptFresh: 0,
    quotaEvicted: 0,
    quotaSkippedFresh: 0,
    keptBytes: 0,
  };
  const quotaBytes = options.quotaBytes ?? HYGIENE_DEFAULTS.cargoTargetQuotaBytes;
  if (!(quotaBytes > 0)) return result;

  let entries = [];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return result;
  }
  if (options.root) {
    try {
      const real = fs.realpathSync(targetDir);
      const root = fs.realpathSync(options.root);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
        result.refused = "outside-home";
        return result;
      }
    } catch {
      return result;
    }
  }

  const units = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(targetDir, entry.name);
    try {
      const { size, files, newest } = measureEntry(candidate);
      const open = isPathOpen(candidate, options.openPaths);
      if (open) result.skippedOpen += 1;
      units.push({ path: candidate, size, files, newest, open });
    } catch {
      // unreadable entry: leave it exactly where it is
    }
  }

  const q = evictOldestToQuota(units, quotaBytes, nowMs, options.freshGraceMs ?? 0);
  result.cleanedFiles = q.cleanedFiles;
  result.cleanedBytes = q.cleanedBytes;
  result.quotaEvicted = q.quotaEvicted;
  result.quotaSkippedFresh = q.quotaSkippedFresh;
  result.keptBytes = q.keptBytes;
  return result;
}

/** Newest mtime across a directory entry and its whole subtree (0 when unreadable). */
function entryNewestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    let items = [];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const p = path.join(current, item.name);
      try {
        const st = fs.lstatSync(p);
        newest = Math.max(newest, st.mtimeMs);
        if (st.isDirectory()) walk(p);
      } catch {}
    }
  };
  try {
    newest = fs.statSync(dir).mtimeMs;
  } catch {}
  walk(dir);
  return newest;
}

/**
 * Imposes the per-bot npm cache ceiling (OPE-12104).
 *
 * The TTL pass alone cannot bound `.npm`: `_cacache/content-v2` is keyed by
 * content hash, so one large install (an npx package fetched whole) leaves a
 * tree whose shards are all as fresh as each other, and `cleanEntryCache`
 * removes a `.npm` entry as a unit or not at all — a single fresh descendant
 * pins 1.6 GiB forever. So when `.npm` is over the cap we evict by age,
 * oldest first, regardless of TTL:
 *   1. `_npx/<hash>` installs (whole entries: half an npx package is broken),
 *   2. `_cacache/content-v2/sha512/<xx>` shard dirs.
 * Open fds / process cwds are never evicted: a running npx MCP server keeps
 * its install even while the cache is over the cap.
 *
 * Returns { applied, sizeBefore, sizeAfter, cleanedFiles, cleanedBytes, skippedOpen, removed }.
 */
export function enforceNpmCap(npmDir, options = {}) {
  const capBytes = Number.isFinite(options.capBytes) ? options.capBytes : HYGIENE_DEFAULTS.npmCacheCapBytes;
  const openPaths = options.openPaths || new Set();
  const result = {
    applied: false,
    sizeBefore: 0,
    sizeAfter: 0,
    cleanedFiles: 0,
    cleanedBytes: 0,
    skippedOpen: 0,
    removed: [],
  };

  if (!(capBytes > 0)) return result;
  if (!fs.existsSync(npmDir)) return result;

  let size = dirSize(npmDir);
  result.sizeBefore = size;
  result.sizeAfter = size;
  if (size <= capBytes) return result;
  result.applied = true;

  const candidates = [];
  const npxRoot = path.join(npmDir, "_npx");
  const shardRoot = path.join(npmDir, "_cacache", "content-v2", "sha512");
  const collect = (root, kind) => {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      candidates.push({ kind, dir, mtime: entryNewestMtime(dir) });
    }
  };
  collect(npxRoot, "npx");
  collect(shardRoot, "cacache-shard");
  // _npx first, then cacache shards; within each kind the oldest entry goes first.
  candidates.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "npx" ? -1 : 1;
    return a.mtime - b.mtime;
  });

  for (const candidate of candidates) {
    if (size <= capBytes) break;
    if (isPathOpen(candidate.dir, openPaths)) {
      result.skippedOpen += 1;
      continue;
    }
    const freed = entrySize(candidate.dir);
    try {
      fs.rmSync(candidate.dir, { recursive: true, force: true });
    } catch {
      continue;
    }
    size -= freed.bytes;
    result.cleanedBytes += freed.bytes;
    result.cleanedFiles += freed.files;
    result.removed.push({ kind: candidate.kind, name: path.basename(candidate.dir), bytes: freed.bytes });
  }

  result.sizeAfter = Math.max(0, size);
  return result;
}

/**
 * Cap the complete per-bot cacache after the TTL pass. Evict whole content and
 * index shards oldest-first; never follow symlinks or delete an open subtree.
 * An active run is exempt at the call site because it may be installing now.
 */
export function enforceCacacheQuota(cacheDir, options = {}) {
  const quotaBytes = options.quotaBytes ?? HYGIENE_DEFAULTS.npmCacacheQuotaBytes;
  const result = { sizeBefore: 0, sizeAfter: 0, cleanedFiles: 0, cleanedBytes: 0, skippedOpen: 0, removed: [] };
  if (!(quotaBytes > 0)) return result;
  let root;
  try {
    // The workspace can itself be a bind/symlink alias; reject a symlink at
    // the cache leaf, while comparing descendants against its canonical root.
    root = fs.realpathSync(cacheDir);
    if (!fs.lstatSync(cacheDir).isDirectory()) return result;
  } catch { return result; }

  const candidates = [];
  const add = (dir) => {
    let entries;
    try {
      if (!fs.lstatSync(dir).isDirectory()) return;
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        try {
          const real = fs.realpathSync(candidate);
          if (!real.startsWith(`${root}${path.sep}`)) continue;
          candidates.push({ path: candidate, newest: entryNewestMtime(candidate) });
        } catch {}
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try { candidates.push({ path: candidate, newest: fs.lstatSync(candidate).mtimeMs }); } catch {}
      }
    }
  };
  // Content shards are `content-v2/sha512/<xx>`; index shards are
  // `index-v5/<xx>`. Include other top-level entries as individual units.
  let tops = [];
  try { tops = fs.readdirSync(cacheDir, { withFileTypes: true }); } catch { return result; }
  for (const top of tops) {
    const p = path.join(cacheDir, top.name);
    if (top.isDirectory() && (top.name === "content-v2" || top.name === "index-v5")) {
      if (top.name === "content-v2") {
        if (!fs.lstatSync(p).isDirectory()) continue;
        add(path.join(p, "sha512"));
        // Other content algorithms, if present, remain whole entries.
        let algorithms = [];
        try { algorithms = fs.readdirSync(p, { withFileTypes: true }); } catch {}
        for (const algorithm of algorithms) if (algorithm.name !== "sha512" && algorithm.isDirectory()) add(path.join(p, algorithm.name));
      } else add(p);
    } else if (top.isDirectory()) candidates.push({ path: p, newest: entryNewestMtime(p) });
    else if (top.isFile() || top.isSymbolicLink()) {
      try { candidates.push({ path: p, newest: fs.lstatSync(p).mtimeMs }); } catch {}
    }
  }
  let size = dirSize(cacheDir);
  result.sizeBefore = size;
  result.sizeAfter = size;
  if (size <= quotaBytes) return result;
  candidates.sort((a, b) => a.newest - b.newest || a.path.localeCompare(b.path));
  for (const candidate of candidates) {
    if (size <= quotaBytes) break;
    if (isPathOpen(candidate.path, options.openPaths)) { result.skippedOpen++; continue; }
    const st = fs.lstatSync(candidate.path);
    const before = st.isDirectory() ? entrySize(candidate.path) : { bytes: st.size, files: 1 };
    try {
      if (st.isDirectory()) fs.rmSync(candidate.path, { recursive: true, force: true });
      else fs.unlinkSync(candidate.path);
      if (fs.existsSync(candidate.path)) continue;
    } catch { continue; }
    size -= before.bytes;
    result.cleanedBytes += before.bytes;
    result.cleanedFiles += before.files;
    result.removed.push(path.relative(cacheDir, candidate.path));
  }
  result.sizeAfter = dirSize(cacheDir);
  return result;
}

/** { bytes, files } for one entry tree (0 when unreadable). */
function entrySize(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    let items = [];
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const p = path.join(current, item.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else {
        bytes += st.size;
        files += 1;
      }
    }
  };
  walk(dir);
  return { bytes, files };
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
    npxTtlMs: (options.limits?.npxTtlHours ?? options.npxTtlHours ?? HYGIENE_DEFAULTS.npxTtlHours) * HOUR,
    uvCacheTtlMs: (options.limits?.uvCacheTtlHours ?? options.uvCacheTtlHours ?? HYGIENE_DEFAULTS.uvCacheTtlHours) * HOUR,
    terminalOutputTtlMs: (options.limits?.terminalOutputTtlHours ?? options.terminalOutputTtlHours ?? HYGIENE_DEFAULTS.terminalOutputTtlHours) * HOUR,
    npmCacheCapBytes: options.limits?.npmCacheCapBytes ?? options.npmCacheCapBytes ?? HYGIENE_DEFAULTS.npmCacheCapBytes,
    npmNpxQuotaBytes: options.limits?.npmNpxQuotaBytes ?? options.npmNpxQuotaBytes ?? HYGIENE_DEFAULTS.npmNpxQuotaBytes,
    cargoTargetQuotaBytes: options.limits?.cargoTargetQuotaBytes ?? options.cargoTargetQuotaBytes ?? HYGIENE_DEFAULTS.cargoTargetQuotaBytes,
    quotaFreshGraceMs: (options.limits?.quotaFreshGraceMinutes ?? options.quotaFreshGraceMinutes ?? HYGIENE_DEFAULTS.quotaFreshGraceMinutes) * MINUTE,
    npmCacacheQuotaBytes: options.limits?.npmCacacheQuotaBytes ?? options.npmCacacheQuotaBytes ?? HYGIENE_DEFAULTS.npmCacacheQuotaBytes,
    npmNpxQuotaBytes: options.limits?.npmNpxQuotaBytes ?? options.npmNpxQuotaBytes ?? HYGIENE_DEFAULTS.npmNpxQuotaBytes,
    cargoTargetQuotaBytes: options.limits?.cargoTargetQuotaBytes ?? options.cargoTargetQuotaBytes ?? HYGIENE_DEFAULTS.cargoTargetQuotaBytes,
    quotaFreshGraceMs: (options.limits?.quotaFreshGraceMinutes ?? options.quotaFreshGraceMinutes ?? HYGIENE_DEFAULTS.quotaFreshGraceMinutes) * MINUTE,
  };

  // A live run may be using an npx install right now; the whole-`.npm` cap below is
  // skipped then (same rule the repack pass follows for `idle`). The `_npx` and
  // cargo quotas above are not: they spare open entries and entries written inside
  // the fresh-grace window instead.
  const live = options.live === true;

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
    // `_npx/<hash>` installs are transient one-shot downloads: 24 h, not the
    // 48 h the long-lived content-addressable cache gets.
    const ttlMs = t.name === "npm-npx"
      ? limits.npxTtlMs
      : t.name === "npm-cacache" || t.name === "npm-cacache-index"
        ? limits.npmCacheTtlMs
        : limits.terminalOutputTtlMs;
    // myrmidon(OPE-12110): only the `_npx` root carries the byte ceiling here;
    // the cacache shards and terminal output stay TTL-only (the whole `.npm`
    // has its own cap below), and the cargo target dir is handled after the loop.
    const quotaBytes = t.name === "npm-npx" ? limits.npmNpxQuotaBytes : 0;
    const res = t.mode === "walk"
      ? cleanTargetDir(t.dir, ttlMs, nowMs, openPaths)
      : cleanEntryCache(t.dir, ttlMs, nowMs, openPaths, quotaBytes, limits.quotaFreshGraceMs);
    targetResults[t.name] = res;
    totalFiles += res.cleanedFiles;
    totalBytes += res.cleanedBytes;
    totalSkippedOpen += res.skippedOpen;
    totalKept += res.keptFresh;
    if (t.name === "npm-npx" && res.quotaEvicted > 0 && typeof options.log === "function") {
      options.log(`botd hygiene: npx quota ${limits.npmNpxQuotaBytes} bytes exceeded, evicted ${res.quotaEvicted} entries oldest-first, kept ${res.keptBytes} bytes`);
    }
  }

  // myrmidon(OPE-12110): the per-bot cargo target dir (`CARGO_TARGET_DIR`), a byte
  // quota with LRU-by-mtime eviction of its profile dirs. Not skipped on a live
  // run: an entry written in the last `quotaFreshGraceMinutes` or held open by a
  // process (a build in flight) is never evicted, so a running build keeps its
  // artifacts and only an idle profile dir goes.
  const cargo = cleanCargoTarget(options.cargoTargetDir || cargoTargetDir(hermesHome), {
    nowMs,
    quotaBytes: limits.cargoTargetQuotaBytes,
    openPaths,
    freshGraceMs: limits.quotaFreshGraceMs,
    root: hermesHome,
  });
  targetResults["cargo-target"] = cargo;
  totalFiles += cargo.cleanedFiles;
  totalBytes += cargo.cleanedBytes;
  totalSkippedOpen += cargo.skippedOpen;
  if (cargo.quotaEvicted > 0 && typeof options.log === "function") {
    options.log(`botd hygiene: cargo target quota ${limits.cargoTargetQuotaBytes} bytes exceeded, evicted ${cargo.quotaEvicted} entries oldest-first, kept ${cargo.keptBytes} bytes`);
  }
  if (cargo.refused && typeof options.log === "function") {
    options.log(`botd hygiene: cargo target dir not touched (${cargo.refused})`);
  }

  // Size ceiling last: the TTL pass above frees what it can, then the cap evicts
  // the oldest remaining installs/shards until `.npm` fits. Skipped during a live
  // run — an in-flight agent may own any entry (its fd is open, but a run that has
  // not opened the file yet is still using the install).
  if (!live) {
    const cacacheQuota = enforceCacacheQuota(path.join(hermesHome, ".npm", "_cacache"), {
      quotaBytes: limits.npmCacacheQuotaBytes,
      openPaths,
    });
    targetResults["npm-cacache-quota"] = cacacheQuota;
    totalFiles += cacacheQuota.cleanedFiles;
    totalBytes += cacacheQuota.cleanedBytes;
    totalSkippedOpen += cacacheQuota.skippedOpen;
    if (typeof options.log === "function") {
      options.log(`botd hygiene: npm _cacache quota pass ${limits.npmCacacheQuotaBytes} bytes (${cacacheQuota.sizeBefore} -> ${cacacheQuota.sizeAfter}), evicted ${cacacheQuota.removed.length} entries, skipped open ${cacacheQuota.skippedOpen}`);
    }

    const cap = enforceNpmCap(path.join(hermesHome, ".npm"), {
      capBytes: limits.npmCacheCapBytes,
      openPaths,
    });
    targetResults["npm-cap"] = cap;
    totalFiles += cap.cleanedFiles;
    totalBytes += cap.cleanedBytes;
    totalSkippedOpen += cap.skippedOpen;
    if (cap.applied && typeof options.log === "function") {
      options.log(`botd hygiene: npm cap ${limits.npmCacheCapBytes} bytes exceeded (${cap.sizeBefore} -> ${cap.sizeAfter}), evicted ${cap.removed.length} entries`);
    }
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
