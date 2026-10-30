import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REPACK_INTERVAL_MS = 24 * 3600 * 1000;
export const MAX_PACKS_THRESHOLD = 20;
export const MARKER_FILE = ".myrmidon-repack";

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function countPacks(repoPath) {
  try {
    const packDir = path.join(repoPath, "objects", "pack");
    const entries = fs.readdirSync(packDir);
    return entries.filter((e) => e.endsWith(".pack")).length;
  } catch {
    return 0;
  }
}

export function hasLockFile(repoPath) {
  try {
    const rootEntries = fs.readdirSync(repoPath);
    for (const e of rootEntries) {
      if (e.endsWith(".lock")) return true;
    }
  } catch {}
  try {
    const packEntries = fs.readdirSync(path.join(repoPath, "objects", "pack"));
    for (const e of packEntries) {
      if (e.endsWith(".lock")) return true;
    }
  } catch {}
  try {
    const refsDir = path.join(repoPath, "refs");
    if (hasLockInDir(refsDir)) return true;
  } catch {}
  return false;
}

function hasLockInDir(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (hasLockInDir(path.join(dir, e.name))) return true;
      } else if (e.name.endsWith(".lock")) {
        return true;
      }
    }
  } catch {}
  return false;
}

export function getDirSizeBytes(dirPath) {
  let total = 0;
  function walk(d) {
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else {
          try {
            const st = fs.statSync(p);
            total += st.size;
          } catch {}
        }
      }
    } catch {}
  }
  walk(dirPath);
  return total;
}

export function shouldRepack(repoPath, options = {}) {
  const maxPacks = options.maxPacks ?? MAX_PACKS_THRESHOLD;
  const intervalMs = options.intervalMs ?? REPACK_INTERVAL_MS;
  const now = options.now ?? Date.now();
  const packs = countPacks(repoPath);

  if (packs > maxPacks) {
    return { should: true, reason: "pack-count", packs };
  }

  const markerPath = path.join(repoPath, MARKER_FILE);
  try {
    const st = fs.statSync(markerPath);
    const ageMs = now - st.mtimeMs;
    if (ageMs < intervalMs) {
      return { should: false, reason: "recent", packs, lastRepackMs: st.mtimeMs };
    }
  } catch {
    // Marker does not exist: repack needed
  }

  return { should: true, reason: "schedule", packs };
}

export function defaultRunCmd(bin, args, cwdOrOpts) {
  const opts = typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : (cwdOrOpts || {});
  const execOpts = {
    cwd: opts.cwd,
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  };
  if (typeof opts.uid === "number" && (process.getuid ? process.getuid() === 0 : true)) {
    execOpts.uid = opts.uid;
  }
  if (typeof opts.gid === "number" && (process.getuid ? process.getuid() === 0 : true)) {
    execOpts.gid = opts.gid;
  }
  return new Promise((resolve) => {
    execFile(bin, args, execOpts, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

export async function repackRepo(repoPath, options = {}) {
  const log = options.log || (() => {});
  const runCmd = options.runCmd || defaultRunCmd;
  const gitBin = options.gitBin || "git";

  if (hasLockFile(repoPath)) {
    log(`botd repack: skipping ${repoPath}, lock file present`);
    return { ok: false, skipped: true, reason: "locked" };
  }

  let uid = options.uid;
  let gid = options.gid;
  if (uid == null || gid == null) {
    try {
      const st = fs.statSync(repoPath);
      if (uid == null) uid = st.uid;
      if (gid == null) gid = st.gid;
    } catch {}
  }

  const cmdOpts = { cwd: repoPath };
  if (typeof uid === "number") cmdOpts.uid = uid;
  if (typeof gid === "number") cmdOpts.gid = gid;

  const packsBefore = countPacks(repoPath);
  const sizeBefore = getDirSizeBytes(repoPath);

  // 1. git repack -A -d
  const repackRes = await runCmd(gitBin, ["-C", repoPath, "repack", "-A", "-d"], cmdOpts);
  if (repackRes.code !== 0) {
    log(`botd repack: git repack failed on ${repoPath} (code ${repackRes.code}): ${repackRes.stderr || repackRes.stdout}`);
    return { ok: false, error: repackRes.stderr || repackRes.stdout };
  }

  // 2. git prune --expire=2.weeks
  const pruneRes = await runCmd(gitBin, ["-C", repoPath, "prune", "--expire=2.weeks"], cmdOpts);
  if (pruneRes.code !== 0) {
    log(`botd repack: git prune warning on ${repoPath} (code ${pruneRes.code}): ${pruneRes.stderr || pruneRes.stdout}`);
  }

  const packsAfter = countPacks(repoPath);
  const sizeAfter = getDirSizeBytes(repoPath);

  // Update timestamp marker
  const markerPath = path.join(repoPath, MARKER_FILE);
  try {
    const fd = fs.openSync(markerPath, "w");
    fs.closeSync(fd);
    if (typeof uid === "number" && typeof gid === "number" && (process.getuid ? process.getuid() === 0 : true)) {
      try {
        fs.chownSync(markerPath, uid, gid);
      } catch {}
    }
  } catch {}

  log(`botd repack: git-base ${repoPath} repacked: packs ${packsBefore} -> ${packsAfter}, size ${formatBytes(sizeBefore)} -> ${formatBytes(sizeAfter)}`);

  return {
    ok: true,
    packsBefore,
    packsAfter,
    sizeBefore,
    sizeAfter,
    uid,
    gid,
  };
}

export async function repackAllBases(baseDir, options = {}) {
  const log = options.log || (() => {});
  let owners = [];
  try {
    owners = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  const results = [];
  for (const owner of owners) {
    let repos = [];
    try {
      repos = fs.readdirSync(path.join(baseDir, owner));
    } catch {
      continue;
    }
    for (const r of repos) {
      if (!r.endsWith(".git")) continue;
      const repoPath = path.join(baseDir, owner, r);
      try {
        const decision = shouldRepack(repoPath, options);
        if (!decision.should) continue;
        const res = await repackRepo(repoPath, options);
        results.push({ repo: `${owner}/${r}`, ...res });
      } catch (err) {
        log(`botd repack: error on ${repoPath}: ${err.message}`);
      }
    }
  }
  return results;
}
