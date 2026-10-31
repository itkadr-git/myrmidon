import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";

export const REPACK_MIGRATED_MARKER = ".repack-migrated";
const LOCK_STALE_MS = 900_000; // 15 minutes

// myrmidon(1.6.6 BOT-DISK OPE-10311): fleet git mirror root. Candidate
// discovery and mirror-covered pack removal read this one constant instead of
// hard-coding /cache/git at each use.
export const GIT_MIRROR_ROOT = process.env.MYRMIDON_GIT_MIRROR_ROOT || "/cache/git";
// Loose objects older than this are pruned as unreachable (gc-equivalent).
export const DEFAULT_PRUNE_EXPIRE = "2.weeks.ago";

function getFleetLockPath() {
  try {
    if (fs.existsSync("/cache/pnpm-store")) {
      return "/cache/pnpm-store/.fleet-git-migration.lock";
    }
    if (fs.existsSync("/cache/pnpm")) {
      return "/cache/pnpm/.fleet-git-migration.lock";
    }
  } catch {}
  return "/data/hermes/.myrmidon/git-migration.lock";
}

export function withFleetMigrationLock(fn, lockPathOverride) {
  const lockPath = lockPathOverride || getFleetLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {}

  let fd = null;
  try {
    fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
  } catch (err) {
    if (err.code === "EEXIST") {
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          try {
            fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, "utf8");
          } catch {
            return null;
          }
        } else {
          return null; // Lock held by another bot
        }
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

function cleanTmpPacks(packDir) {
  try {
    if (!fs.existsSync(packDir)) return;
    const entries = fs.readdirSync(packDir);
    for (const f of entries) {
      if (f.startsWith(".tmp-")) {
        try {
          fs.rmSync(path.join(packDir, f), { force: true });
        } catch {}
      }
    }
  } catch {}
}

function runNice(args, timeoutMs = 600_000) {
  // gc-equivalent git runs are always nice -n 19; ionice -c 3 (idle class)
  // when the kernel allows it, plain nice otherwise.
  try {
    child_process.execFileSync("nice", ["-n", "19", "ionice", "-c", "3", "git", ...args], {
      stdio: "ignore",
      timeout: timeoutMs,
    });
    return true;
  } catch {
    try {
      child_process.execFileSync("nice", ["-n", "19", "git", ...args], {
        stdio: "ignore",
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * myrmidon(1.6.6 BOT-DISK OPE-10311): prune aged unreachable objects, then
 * repack locally (`-l` keeps alternates objects out of the new pack). The ADM
 * measurement on a real git-base showed `repack -a -d -l --keep-unreachable`
 * alone freed nothing: 393k loose objects were unreachable since 17.10 and
 * only `git prune --expire=2.weeks.ago` reclaimed them, so prune runs first.
 */
export function runRepackWithNiceIonice(gitDir, { pruneExpire = DEFAULT_PRUNE_EXPIRE } = {}) {
  if (!runNice(["--git-dir", gitDir, "prune", "--expire", pruneExpire])) return false;
  return runNice(["--git-dir", gitDir, "repack", "-a", "-d", "-l", "--keep-unreachable"]);
}

/** Alternates file content of a repo's objects dir; "" when absent. */
export function readAlternates(objectsDir) {
  try {
    return fs.readFileSync(path.join(objectsDir, "info", "alternates"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Resolve a workspace `.git` entry to its git dir. Handles both a plain
 * directory (normal clone) and a `gitdir: <path>` pointer file (linked
 * worktree), then follows `commondir` to the owning base repo so objects and
 * alternates are looked up in the right place.
 */
export function resolveWorktreeGitDir(wsDir) {
  let gitDir = null;
  try {
    const dotGit = path.join(wsDir, ".git");
    const st = fs.lstatSync(dotGit);
    if (st.isDirectory()) {
      gitDir = dotGit;
    } else if (st.isFile()) {
      const m = /^gitdir:\s*(\S+)/m.exec(fs.readFileSync(dotGit, "utf8"));
      gitDir = m ? m[1] : null;
    }
  } catch {
    return null;
  }
  if (!gitDir) return null;
  try {
    const common = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    if (common) return path.resolve(gitDir, common);
  } catch {}
  return gitDir;
}

function pushCandidate(candidates, gitDir) {
  const objectsDir = path.join(gitDir, "objects");
  const markerFile = path.join(objectsDir, "info", REPACK_MIGRATED_MARKER);
  if (fs.existsSync(markerFile)) return;
  candidates.push({
    gitDir,
    objectsDir,
    markerFile,
    alternates: readAlternates(objectsDir),
  });
}

function isBareRepoDir(dir) {
  try {
    return fs.statSync(path.join(dir, "objects")).isDirectory() && fs.existsSync(path.join(dir, "HEAD"));
  } catch {
    return false;
  }
}

/**
 * myrmidon(1.6.6 BOT-DISK OPE-10311): find git repos needing prune/repack.
 * - baseDir live layout is two levels: git-base/<owner>/<repo>.git (myr-ws
 *   lib/base.js); one-level git-base/<repo>.git entries are still honored.
 * - Repos WITHOUT alternates are included too: their loose objects (the 393k
 *   case) stay unpacked forever if only alternates repos are migrated.
 * - workspacesDir entries are resolved through their `.git` pointer files
 *   (gitdir: + commondir) to the repo that actually owns the objects.
 */
export function findMigrationCandidates(baseDir, workspacesDir) {
  const candidates = [];

  if (baseDir && fs.existsSync(baseDir)) {
    try {
      for (const ent of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(baseDir, ent.name);
        if (isBareRepoDir(dir)) {
          pushCandidate(candidates, dir);
          continue;
        }
        // Nested layout: git-base/<owner>/<repo>.git
        for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const nested = path.join(dir, sub.name);
          if (isBareRepoDir(nested)) pushCandidate(candidates, nested);
        }
      }
    } catch {}
  }

  if (workspacesDir && fs.existsSync(workspacesDir)) {
    try {
      for (const ent of fs.readdirSync(workspacesDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const ws = path.join(workspacesDir, ent.name);
        const gitDir = resolveWorktreeGitDir(ws) || resolveWorktreeGitDir(path.join(ws, "repo"));
        if (gitDir && isBareRepoDir(gitDir)) {
          // Avoid double-adding a base repo already found via baseDir.
          if (!candidates.some((c) => c.gitDir === gitDir)) pushCandidate(candidates, gitDir);
        }
      }
    } catch {}
  }

  return candidates;
}

/**
 * myrmidon(1.6.6 BOT-DISK OPE-10311): delete packs whose every object exists
 * in the fleet mirror. The manual `repack -a -d -l --keep-unreachable` freed
 * nothing on a measured git-base because pack objects were already in the
 * mirror ("nothing new to pack") and repack -d kept the old packs. Only
 * packs covered 100% by the mirror are removed, and only from repos whose
 * alternates point at that mirror, so reachability is preserved.
 */
export function removeMirrorCoveredPacks(gitDir, alternatesContent, opts = {}) {
  const git = opts.git || ((args, input) =>
    child_process.execFileSync("git", args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 120_000,
      input,
    }));
  const mirrorGitDirs = alternatesContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((objectsDir) => objectsDir.replace(/[/\\]objects$/, ""))
    .filter((d, i, arr) => arr.indexOf(d) === i);
  if (mirrorGitDirs.length === 0) return { removed: 0, checked: 0 };

  const packDir = path.join(gitDir, "objects", "pack");
  if (!fs.existsSync(packDir)) return { removed: 0, checked: 0 };

  let removed = 0;
  let checked = 0;
  for (const f of fs.readdirSync(packDir)) {
    if (!f.endsWith(".pack")) continue;
    checked++;
    try {
      const listing = git(["--git-dir", gitDir, "verify-pack", "-v", path.join(packDir, f)]);
      const oids = listing
        .split("\n")
        .map((l) => l.split(" ")[0])
        .filter((oid) => /^[0-9a-f]{40,64}$/.test(oid));
      if (oids.length === 0) continue;
      // Ask each mirror about all objects in one batch; a line ending in
      // "missing" (or a short answer) means the pack is not covered.
      let covered = false;
      for (const mirrorGitDir of mirrorGitDirs) {
        try {
          const out = git(["--git-dir", mirrorGitDir, "cat-file", "--batch-check"], `${oids.join("\n")}\n`);
          const lines = out.trim().split(/\r?\n/).filter(Boolean);
          covered = lines.length === oids.length && lines.every((l) => !l.endsWith("missing"));
        } catch {
          covered = false;
        }
        if (covered) break;
      }
      if (!covered) continue;
      fs.rmSync(path.join(packDir, f), { force: true });
      fs.rmSync(path.join(packDir, f.replace(/\.pack$/, ".idx")), { force: true });
      fs.rmSync(path.join(packDir, f.replace(/\.pack$/, ".rev")), { force: true });
      fs.rmSync(path.join(packDir, f.replace(/\.pack$/, ".bitmap")), { force: true });
      removed++;
    } catch {}
  }
  return { removed, checked };
}

export function migrateIdleGitRepos({
  baseDir,
  workspacesDir,
  idle,
  enabled,
  log = () => {},
  repackRunner = runRepackWithNiceIonice,
  mirrorPackRemover = removeMirrorCoveredPacks,
  pruneExpire = DEFAULT_PRUNE_EXPIRE,
  lockPathOverride,
}) {
  if (!enabled || !idle) {
    return { migrated: 0, skipped: true };
  }

  return withFleetMigrationLock(() => {
    const candidates = findMigrationCandidates(baseDir, workspacesDir);
    let migrated = 0;
    let packsRemoved = 0;

    // Process up to 2 repos per idle pass to preserve responsiveness
    for (const item of candidates.slice(0, 2)) {
      try {
        const ok = repackRunner(item.gitDir, { pruneExpire });
        if (ok) {
          let removed = 0;
          if (item.alternates.length > 0) {
            try {
              const res = mirrorPackRemover(item.gitDir, item.alternates);
              removed = (res && res.removed) || 0;
              packsRemoved += removed;
            } catch {}
          }
          fs.writeFileSync(item.markerFile, `${new Date().toISOString()}${removed ? ` packs-removed=${removed}` : ""}\n`, "utf8");
          migrated++;
          log(`git-migration: repacked ${item.gitDir}${removed ? ` (removed ${removed} mirror-covered packs)` : ""}`);
        } else {
          // Failure path: clean up temporary pack files, never touch alternates!
          cleanTmpPacks(path.join(item.objectsDir, "pack"));
          log(`git-migration: repack failed for ${item.gitDir}, alternates preserved for retry`);
        }
      } catch (err) {
        cleanTmpPacks(path.join(item.objectsDir, "pack"));
        log(`git-migration error for ${item.gitDir}: ${err.message}`);
      }
    }

    return { migrated, packsRemoved, totalCandidates: candidates.length };
  }, lockPathOverride) || { migrated: 0, locked: true };
}
