#!/usr/bin/env node
// myrmidon(1.6.7 BOT-DISK OPE-12489): host-side GC of per-bot git-base packs
// that are fully covered by the fleet mirror at /srv/myrmidon-cache/git.
//
// Background: every bot keeps a bare per-repo base at
// /srv/myrmidon-bots/<bot>/.myrmidon/git-base/<owner>/<repo>.git. After the
// alternates migration (OPE-10311) each base points at the shared mirror and
// its own packs are redundant — every object also lives in the mirror. The
// bot-side idle migration (botd git-migration.js) removes those packs two
// repos per idle pass, which is too slow for a 34.9 GB fleet-wide backlog.
// This script does the same verified removal in one host-side sweep, using
// the exact same coverage check (verify-pack listing vs mirror cat-file
// --batch-check) imported from botd, so behaviour is identical to the
// incremental path.
//
// Safety:
//   - Only packs whose EVERY object exists in the mirror are removed.
//   - Only repos whose objects/info/alternates points inside the mirror root.
//   - Hardlink backup of every removed pack into the backup dir first
//     (hardlinks are free until the original is unlinked; the backup keeps
//     the data alive, so removal is reversible while the backup survives).
//   - Lockfile, symlink checks, JSONL journal — same discipline as
//     host-clone-cache-gc.mjs.
//   - Dry-run by default. Nothing is removed without --apply.
//
// Usage:
//   node scripts/myrmidon/host-gc/host-git-base-pack-gc.mjs --dry-run
//   node scripts/myrmidon/host-gc/host-git-base-pack-gc.mjs --apply
//     [--bots-root /srv/myrmidon-bots]
//     [--mirror-root /srv/myrmidon-cache/git]
//     [--backup-dir <path>]   (default <bots-root>/.git-base-pack-backup/<ts>)
//     [--journal <path>] [--lock <path>]

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The coverage check is the single source of truth shared with the bot-side
// idle migration (docker/bot-runtime/botd/lib/git-migration.js). Importing it
// instead of re-implementing guarantees the two paths agree.
import {
  removeMirrorCoveredPacks,
  resolveMirrorGitDirs,
} from "../../../docker/bot-runtime/botd/lib/git-migration.js";

// --- Args -------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    botsRoot: "/srv/myrmidon-bots",
    mirrorRoot: process.env.MYRMIDON_GIT_MIRROR_ROOT || "/srv/myrmidon-cache/git",
    backupDir: null,
    journal: "/var/log/myrmidon-host-gc.jsonl",
    lock: "/var/run/myrmidon-git-base-pack-gc.lock",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--bots-root") args.botsRoot = argv[++i];
    else if (a === "--mirror-root") args.mirrorRoot = argv[++i];
    else if (a === "--backup-dir") args.backupDir = argv[++i];
    else if (a === "--journal") args.journal = argv[++i];
    else if (a === "--lock") args.lock = argv[++i];
    else if (a === "--help") {
      console.log("Usage: host-git-base-pack-gc.mjs [--apply|--dry-run] [--bots-root p] [--mirror-root p] [--backup-dir p] [--journal p] [--lock p]");
      process.exit(0);
    }
  }
  return args;
}

// --- Lock / journal (same discipline as host-clone-cache-gc.mjs) ------------

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

export function journalRecord(journalPath, record) {
  const dir = path.dirname(path.resolve(journalPath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n";
  const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
  try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// --- Scanning ---------------------------------------------------------------

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function isBareRepoDir(p) {
  try {
    return fs.existsSync(path.join(p, "HEAD")) && fs.existsSync(path.join(p, "objects"));
  } catch { return false; }
}

function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) {
      try { total += fs.statSync(full).size; } catch {}
    }
  }
  return total;
}

/**
 * Find every per-bot git-base bare repo under <botsRoot>. Expected layout:
 *   <botsRoot>/<bot>/.myrmidon/git-base/<owner>/<repo>.git
 * Symlinks are skipped (never touch redirected paths).
 */
export function scanGitBases(botsRoot) {
  const out = [];
  let bots;
  try { bots = fs.readdirSync(botsRoot, { withFileTypes: true }); } catch { return out; }
  for (const bot of bots) {
    if (!bot.isDirectory() || bot.isSymbolicLink()) continue;
    const baseRoot = path.join(botsRoot, bot.name, ".myrmidon", "git-base");
    let owners;
    try { owners = fs.readdirSync(baseRoot, { withFileTypes: true }); } catch { continue; }
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const ownerDir = path.join(baseRoot, owner.name);
      let repos;
      try { repos = fs.readdirSync(ownerDir, { withFileTypes: true }); } catch { continue; }
      for (const repo of repos) {
        if (!repo.isDirectory() || repo.isSymbolicLink()) continue;
        const gitDir = path.join(ownerDir, repo.name);
        if (!isBareRepoDir(gitDir)) continue;
        if (isSymlink(gitDir)) continue;
        out.push({ bot: bot.name, owner: owner.name, repo: repo.name, gitDir });
      }
    }
  }
  return out;
}

function readAlternates(gitDir) {
  try {
    return fs.readFileSync(path.join(gitDir, "objects", "info", "alternates"), "utf8");
  } catch {
    return null;
  }
}

// --- Backup -----------------------------------------------------------------

/**
 * Hardlink .pack/.idx/.rev/.bitmap companions of every pack in packDir into
 * backupDir. Hardlinks share storage with the originals, so the backup costs
 * no extra disk until the originals are unlinked — at which point the backup
 * keeps the data alive and the removal is reversible.
 */
export function backupPacks(packDir, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const backedUp = [];
  let entries;
  try { entries = fs.readdirSync(packDir); } catch { return backedUp; }
  for (const f of entries) {
    if (!f.endsWith(".pack")) continue;
    for (const suffix of [".pack", ".idx", ".rev", ".bitmap"]) {
      const src = path.join(packDir, f.replace(/\.pack$/, suffix));
      if (!fs.existsSync(src)) continue;
      const dst = path.join(backupDir, path.basename(src));
      try {
        fs.linkSync(src, dst);
        backedUp.push(dst);
      } catch {
        // Existing backup entry from an earlier interrupted run is fine.
      }
    }
  }
  return backedUp;
}

// --- Main -------------------------------------------------------------------

export function runGitBasePackGc(args, { log = console.log } = {}) {
  const bases = scanGitBases(args.botsRoot);
  const report = {
    ok: true,
    dryRun: args.dryRun,
    total: bases.length,
    processed: 0,
    skippedNoAlternates: 0,
    skippedNoMirror: 0,
    packsRemoved: 0,
    packsChecked: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    repos: [],
  };

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-").slice(0, 15);
  const backupRoot = args.backupDir || path.join(args.botsRoot, ".git-base-pack-backup", ts);

  for (const item of bases) {
    const alternates = readAlternates(item.gitDir);
    if (!alternates || !alternates.trim()) {
      report.skippedNoAlternates++;
      journalRecord(args.journal, { event: "git-base-skipped", path: item.gitDir, reason: "no-alternates" });
      continue;
    }
    // Only touch repos whose alternates resolve inside the mirror root; this
    // is the same guard the bot-side migration uses.
    const mirrorGitDirs = resolveMirrorGitDirs(
      path.join(item.gitDir, "objects"),
      alternates,
      args.mirrorRoot,
    );
    if (mirrorGitDirs.length === 0) {
      report.skippedNoMirror++;
      journalRecord(args.journal, { event: "git-base-skipped", path: item.gitDir, reason: "alternates-not-in-mirror" });
      continue;
    }

    const packDir = path.join(item.gitDir, "objects", "pack");
    const before = dirSize(packDir);

    if (args.dryRun) {
      // Plan only: run the same coverage check without deleting.
      const plan = planPackRemoval(item.gitDir, alternates, args.mirrorRoot);
      report.processed++;
      report.packsChecked += plan.checked;
      report.packsRemoved += plan.removable;
      report.repos.push({ ...item, packsChecked: plan.checked, packsRemovable: plan.removable, bytesBefore: before });
      journalRecord(args.journal, { event: "git-base-dry-run", path: item.gitDir, checked: plan.checked, removable: plan.removable });
      continue;
    }

    // Apply: hardlink backup, then verified removal (botd logic).
    const backupDir = path.join(backupRoot, item.bot, item.owner, item.repo);
    let backupCount = 0;
    try {
      backupCount = backupPacks(packDir, backupDir).length;
    } catch (err) {
      journalRecord(args.journal, { event: "git-base-backup-failed", path: item.gitDir, error: err.message });
      continue; // never remove without a backup
    }

    let result;
    try {
      result = removeMirrorCoveredPacks(item.gitDir, alternates, { mirrorRoot: args.mirrorRoot });
    } catch (err) {
      journalRecord(args.journal, { event: "git-base-remove-failed", path: item.gitDir, error: err.message });
      continue;
    }
    const after = dirSize(packDir);
    report.processed++;
    report.packsChecked += result.checked;
    report.packsRemoved += result.removed;
    report.bytesBefore += before;
    report.bytesAfter += after;
    report.repos.push({ ...item, ...result, bytesBefore: before, bytesAfter: after, backupDir });
    journalRecord(args.journal, {
      event: "git-base-packs-removed",
      path: item.gitDir,
      checked: result.checked,
      removed: result.removed,
      bytesBefore: before,
      bytesAfter: after,
      backupDir,
      backupCount,
    });
  }

  log(JSON.stringify({ summary: report }, null, 2));
  return report;
}

/**
 * Dry-run helper: list packs and check mirror coverage without deleting.
 * Mirrors removeMirrorCoveredPacks' verification so the dry-run plan matches
 * what --apply would do.
 */
function planPackRemoval(gitDir, alternatesContent, mirrorRoot) {
  const git = (gitArgs, input) =>
    spawnSync("git", gitArgs, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 120_000,
      input,
    }).stdout;
  const mirrorGitDirs = resolveMirrorGitDirs(path.join(gitDir, "objects"), alternatesContent, mirrorRoot);
  if (mirrorGitDirs.length === 0) return { checked: 0, removable: 0 };
  const packDir = path.join(gitDir, "objects", "pack");
  if (!fs.existsSync(packDir)) return { checked: 0, removable: 0 };
  let checked = 0;
  let removable = 0;
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
      if (covered) removable++;
    } catch {}
  }
  return { checked, removable };
}

function main() {
  const args = parseArgs(process.argv);
  const lock = acquireLock(args.lock);
  if (!lock.ok) {
    console.error(JSON.stringify({ ok: false, reason: lock.reason }));
    process.exit(1);
  }
  try {
    runGitBasePackGc(args);
  } finally {
    lock.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
