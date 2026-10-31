import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";

export const REPACK_MIGRATED_MARKER = ".repack-migrated";
const LOCK_STALE_MS = 900_000; // 15 minutes

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

function runRepackWithNiceIonice(gitDir) {
  // Use nice -n 19 ionice -c 3 git --git-dir <gitDir> repack -a -d -l --keep-unreachable
  try {
    child_process.execFileSync(
      "nice",
      ["-n", "19", "ionice", "-c", "3", "git", "--git-dir", gitDir, "repack", "-a", "-d", "-l", "--keep-unreachable"],
      { stdio: "ignore", timeout: 600000 }
    );
    return true;
  } catch {
    // If ionice is restricted or not available, retry with nice alone
    try {
      child_process.execFileSync(
        "nice",
        ["-n", "19", "git", "--git-dir", gitDir, "repack", "-a", "-d", "-l", "--keep-unreachable"],
        { stdio: "ignore", timeout: 600000 }
      );
      return true;
    } catch {
      return false;
    }
  }
}

function findMigrationCandidates(baseDir, workspacesDir) {
  const candidates = [];

  // 1. Check baseDir (/data/hermes/.myrmidon/git-base)
  if (baseDir && fs.existsSync(baseDir)) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const candidateDir = path.join(baseDir, ent.name);
        const altFile = path.join(candidateDir, "objects", "info", "alternates");
        const markerFile = path.join(candidateDir, "objects", "info", REPACK_MIGRATED_MARKER);
        if (fs.existsSync(altFile) && !fs.existsSync(markerFile)) {
          try {
            const content = fs.readFileSync(altFile, "utf8");
            if (content.includes("/cache/git")) {
              candidates.push({
                gitDir: candidateDir,
                objectsDir: path.join(candidateDir, "objects"),
                markerFile,
              });
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 2. Check workspacesDir (/workspace)
  if (workspacesDir && fs.existsSync(workspacesDir)) {
    try {
      const entries = fs.readdirSync(workspacesDir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const ws = path.join(workspacesDir, ent.name);
        const repoGit = path.join(ws, "repo", ".git");
        const directGit = path.join(ws, ".git");
        const gitDir = fs.existsSync(repoGit) ? repoGit : (fs.existsSync(directGit) ? directGit : null);
        if (gitDir) {
          const altFile = path.join(gitDir, "objects", "info", "alternates");
          const markerFile = path.join(gitDir, "objects", "info", REPACK_MIGRATED_MARKER);
          if (fs.existsSync(altFile) && !fs.existsSync(markerFile)) {
            try {
              const content = fs.readFileSync(altFile, "utf8");
              if (content.includes("/cache/git")) {
                candidates.push({
                  gitDir,
                  objectsDir: path.join(gitDir, "objects"),
                  markerFile,
                });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  return candidates;
}

export function migrateIdleGitRepos({
  baseDir,
  workspacesDir,
  idle,
  enabled,
  log = () => {},
  repackRunner = runRepackWithNiceIonice,
  lockPathOverride,
}) {
  if (!enabled || !idle) {
    return { migrated: 0, skipped: true };
  }

  return withFleetMigrationLock(() => {
    const candidates = findMigrationCandidates(baseDir, workspacesDir);
    let migrated = 0;

    // Process up to 2 repos per idle pass to preserve responsiveness
    for (const item of candidates.slice(0, 2)) {
      try {
        const ok = repackRunner(item.gitDir);
        if (ok) {
          fs.writeFileSync(item.markerFile, `${new Date().toISOString()}\n`, "utf8");
          migrated++;
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

    return { migrated, totalCandidates: candidates.length };
  }, lockPathOverride) || { migrated: 0, locked: true };
}
