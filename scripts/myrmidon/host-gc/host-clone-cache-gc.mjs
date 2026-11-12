#!/usr/bin/env node
// myrmidon(1.6.7-BOT-DISK-HOST-GC): Host-side GC for task clones and build caches.
// Replaces the temporary devbuild-v2-gc.sh with a unified, journaled scheduler.
//
// Targets:
//   - vm-core:       /srv/myrmidon-bots/* (bot workspaces)
//   - myr-dev-build: /srv/devbuild/* (build copies), /srv/devcache/* (build caches)
//   - vm-core:       <runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId> (SSH runner
//                    run copies, OPE-12722; only when a runner root is configured)
//   - vm-core:       <runner root>/<runner>/{workspace,home}/<task folder> (SSH runner task
//                    folders of closed issues, OPE-12855; only when a runner root is configured)
//
// Policy:
//   - Task clones (done/cancelled >24h, clean+pushed): remove
//   - Task clones (done/cancelled >24h, dirty/unpushed): archive first, then remove
//   - Active checkouts/worktrees: never touch
//   - Build caches >72h: LRU eviction by mtime
//   - SSH runner run copies >4h (by the run directory's mtime, set when the run starts): remove;
//     runs only with --runner-root / HOST_GC_RUNNER_ROOTS
//   - SSH runner task folders of done/cancelled issues >24h: clean+pushed remove; unsafe git
//     state archive first, then remove; other statuses or an unreachable board stay; runs only
//     with --runner-root / HOST_GC_RUNNER_ROOTS
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
//   --runner-root <path>  SSH runner root to prune run copies under (repeatable; also
//                         HOST_GC_RUNNER_ROOTS, colon-separated). No root, no pass.
//   --run-copy-ttl <hours> Override the run-copy TTL (default 4; finite, at least 3 = longest run timeout)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CLONE_TTL_HOURS = 24;
const CACHE_TTL_HOURS = 72;

// myrmidon(1.6.8 OPE-12722 / OPE-12759): an SSH runner (the omp container) keeps one copy of
// the workspace per run under `<runner>/workspace/.paperclip-runtime/runs/<runId>`. A run that
// fails or is cancelled never reaches the restore that removes its copy, and the adapter prunes
// old copies only when the next run on that runner starts. On 11.11 an idle fleet left 47 GB
// of such copies; the bots disk filled up and nine bots stayed down for 15 hours. This pass
// removes run copies older than the longest run timeout (3 h) plus a margin.
// The 4 h matches REMOTE_RUN_DIR_RETENTION_MINUTES (240) in
// packages/adapter-utils/src/remote-managed-runtime.ts, the adapter's own prune on the next run;
// keep the two in step. The TTL cannot be set below the longest run timeout (3 h): a copy younger
// than that may still belong to a live run.
const RUN_COPY_TTL_HOURS = 4;
const RUN_COPY_MIN_TTL_HOURS = 3;

// myrmidon(1.6.8 OPE-12855, ported from #3004): a runner keeps one task folder per board issue
// it ever checked out: the clone folder `<runner>/workspace/OPE-<n>/` (the repo inside is a
// full clone) and worktree folders (`<runner>/workspace/OPE-<n>-wt/`, `<runner>/home/wt-ope<n>`),
// whose `.git` file points into a run directory that is deleted when the run ends. A done or
// cancelled issue's folder is never cleaned up. The folder of a done/cancelled issue is removed
// like a task clone (the clone TTL, git-clean guards), with one difference: a folder whose git
// state cannot be proven from the host (a worktree with a dead gitdir fails every git command)
// is archived to `<runner root>/.gc-archive/` first and only then removed — the archive is the
// safety net for work the host cannot inspect. Folders of issues in any other status are kept,
// an unreachable board keeps the folder (fail-closed), and the pass runs only when a runner
// root is configured (the same gate as the run-copy pass above).
const RUNNER_TASK_FOLDER_NAME = /^(OPE-\d+(?:-wt)?|wt-ope\d+)$/i;
const RUNNER_TASK_FOLDER_KEY = /^(?:OPE-(\d+)(?:-wt)?|wt-ope(\d+))$/i;
// Directories never walked while hunting for git repos inside a task folder.
const TASK_FOLDER_SCAN_SKIP_NAMES = new Set(["node_modules", ".next", ".helper", ".gc-archive"]);

/** A usage error: the CLI prints it as JSON and exits non-zero (never a stack trace). */
export class UsageError extends Error {}

/** `null` when `hours` is a usable run-copy TTL, otherwise the reason it is refused. */
export function runCopyTtlError(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) {
    return `--run-copy-ttl must be a finite number of hours (got ${String(hours)})`;
  }
  if (hours < RUN_COPY_MIN_TTL_HOURS) {
    return `--run-copy-ttl must be at least ${RUN_COPY_MIN_TTL_HOURS} hours, the longest run timeout (got ${hours})`;
  }
  return null;
}

// --- Args -------------------------------------------------------------------

export function parseArgs(argv) {
  const args = {
    dryRun: true,
    root: null,
    journal: "/var/log/myrmidon-host-gc.jsonl",
    lock: "/var/run/myrmidon-host-gc.lock",
    cloneTtlHours: CLONE_TTL_HOURS,
    cacheTtlHours: CACHE_TTL_HOURS,
    runnerRoots: (process.env.HOST_GC_RUNNER_ROOTS || "").split(":").map((r) => r.trim()).filter(Boolean),
    runCopyTtlHours: RUN_COPY_TTL_HOURS,
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
    else if (a === "--runner-root") args.runnerRoots.push(argv[++i]);
    else if (a === "--run-copy-ttl") args.runCopyTtlHours = Number(argv[++i]);
    else if (a === "--help") {
      console.log("Usage: host-clone-cache-gc.mjs [--apply|--dry-run] [--root path] [--journal path] [--lock path] [--clone-ttl h] [--cache-ttl h] [--runner-root path] [--run-copy-ttl h (>= 3)]");
      process.exit(0);
    }
  }
  const ttlError = runCopyTtlError(args.runCopyTtlHours);
  if (ttlError) throw new UsageError(ttlError);
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

function issueIdentifierFromCloneName(name) {
  return name.split("@")[0];
}

export async function fetchIssueStatus(identifier, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  let base = (baseUrl || "").replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:3100";
  if (!base.endsWith("/api")) base += "/api";
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const url = `${base}/issues/${encodeURIComponent(identifier)}`;
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(url, { headers });
    if (!response.ok) return { ok: false, reason: "board-unavailable", statusCode: response.status };
    const issue = await response.json();
    if (!issue || typeof issue.status !== "string") return { ok: false, reason: "issue-not-found" };
    return { ok: true, status: issue.status };
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
}

export async function filterClosedTaskClones(clones, options = {}) {
  const candidates = [];
  const skipped = [];
  for (const clone of clones) {
    const identifier = issueIdentifierFromCloneName(clone.name);
    const result = await fetchIssueStatus(identifier, options);
    if (!result.ok) {
      skipped.push({ ...clone, identifier, reason: result.reason });
    } else if (!["done", "cancelled"].includes(result.status)) {
      skipped.push({ ...clone, identifier, status: result.status, reason: "issue-status" });
    } else {
      candidates.push({ ...clone, identifier, issueStatus: result.status });
    }
  }
  return { candidates, skipped };
}

// Minimal helper for the run-copy size measurement (taken from main).
export function inspectPathTree(targetPath) {
  let maxMtimeMs = 0;
  let totalSizeBytes = 0;
  const inodes = new Set();

  function walk(current) {
    let st;
    try {
      st = fs.lstatSync(current);
    } catch {
      return;
    }
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    totalSizeBytes += st.size || 0;
    inodes.add(`${st.dev}:${st.ino}`);

    if (st.isDirectory() && !st.isSymbolicLink()) {
      let entries = [];
      try {
        entries = fs.readdirSync(current);
      } catch {
        return;
      }
      for (const entry of entries) {
        walk(path.join(current, entry));
      }
    }
  }

  walk(targetPath);
  return { maxMtimeMs, totalSizeBytes, inodes };
}

// --- SSH runner run copies (OPE-12722) -----------------------------------------

function lstatSafe(p) {
  try {
    return { st: fs.lstatSync(p), err: null };
  } catch (err) {
    return { st: null, err };
  }
}

// The path is simply not there (a runner without runs yet, a copy the adapter removed between
// two calls): expected, not worth a journal line. Anything else (EACCES, EIO, ...) is.
function isAbsent(err) {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

/**
 * Run copies under `<runnersRoot>/<runner>/workspace/.paperclip-runtime/runs/<runId>`.
 * Every component of the path must be a real directory (a symlink anywhere skips the
 * runner); a copy older than `ttlHours` (by the run directory's own mtime, set when the run
 * starts) is `ttl`, a newer one is `fresh`. Each item carries `runnersRoot`, the root the
 * removal is guarded against.
 *
 * The scan never throws on the filesystem: a configured root that does not exist is reported
 * as `run-copy-root-missing`, any other failure (per root or per runner) as
 * `run-copy-scan-failed` with the error message, through `onEvent`, and the scan continues
 * with the next runner — one unreadable directory must not abort the whole `--apply` pass.
 */
export function scanSshRunCopies(runnersRoot, now, ttlHours, { onEvent = () => {} } = {}) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  const fail = (extra, err) => {
    onEvent({ event: "run-copy-scan-failed", root: runnersRoot, ...extra, error: err?.message || String(err) });
  };

  const rootStat = lstatSafe(runnersRoot);
  if (rootStat.err) {
    if (isAbsent(rootStat.err)) onEvent({ event: "run-copy-root-missing", root: runnersRoot });
    else fail({}, rootStat.err);
    return results;
  }
  if (!rootStat.st.isDirectory()) {
    fail({}, new Error("runner root is not a directory (a symlink is not followed)"));
    return results;
  }
  let runners;
  try {
    runners = fs.readdirSync(runnersRoot, { withFileTypes: true });
  } catch (err) {
    fail({}, err);
    return results;
  }
  for (const runner of runners) {
    if (!runner.isDirectory()) continue;
    try {
      let dir = path.join(runnersRoot, runner.name);
      let ok = true;
      for (const part of ["workspace", ".paperclip-runtime", "runs"]) {
        dir = path.join(dir, part);
        const { st, err } = lstatSafe(dir);
        if (err && !isAbsent(err)) throw err;
        if (!st || !st.isDirectory()) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const run of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!run.isDirectory()) continue;
        const runPath = path.join(dir, run.name);
        const { st, err } = lstatSafe(runPath);
        if (err && !isAbsent(err)) {
          fail({ runner: runner.name, path: runPath }, err);
          continue;
        }
        if (!st || !st.isDirectory()) continue;
        const ageMs = now - st.mtimeMs;
        results.push({
          runner: runner.name,
          name: run.name,
          path: runPath,
          runsDir: dir,
          runnersRoot,
          ageMs,
          mtimeMs: st.mtimeMs,
          reason: ageMs >= ttlMs ? "ttl" : "fresh",
        });
      }
    } catch (err) {
      if (!isAbsent(err)) fail({ runner: runner.name }, err);
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

/**
 * Removes the planned run copies (items of `scanSshRunCopies`, reason `ttl`). The drop is
 * guarded against the configured runner root, not against the copy's own parent: a runner's
 * `workspace` swapped for a symlink after the scan resolves outside the root and is refused
 * (journaled `run-copy-remove-failed`). The size is measured before the removal, best-effort.
 * Returns the paths actually removed.
 */
export function pruneSshRunCopies(items, journalPath) {
  const removed = [];
  for (const r of items) {
    let sizeBytes = null;
    try {
      sizeBytes = inspectPathTree(r.path).totalSizeBytes;
    } catch {
      // best-effort: the size is informational
    }
    try {
      atomicDrop(r.path, r.runnersRoot);
    } catch (err) {
      journalRecord(journalPath, { event: "run-copy-remove-failed", path: r.path, runner: r.runner, error: err.message });
      continue;
    }
    removed.push(r.path);
    journalRecord(journalPath, {
      event: "run-copy-removed",
      path: r.path,
      runner: r.runner,
      ageHours: Math.round(r.ageMs / HOUR_MS),
      sizeBytes,
    });
  }
  return removed;
}

// --- Runner task folders (OPE-12855, ported from #3004) -----------------------

export function issueIdentifierFromRunnerFolderName(name) {
  const m = RUNNER_TASK_FOLDER_KEY.exec(name);
  return m ? `OPE-${m[1] ?? m[2]}` : null;
}

// Git directories inside one task folder worth guarding: the folder itself when it carries
// a `.git` entry (a worktree checked out as the task folder), `<folder>/repo` (the omp
// clone layout), then any nested repository up to depth 3 — including linked worktrees,
// whose `.git` is a file pointing at the main repo's worktrees dir. `node_modules`, `.next`
// and `.helper` are never walked. Returns `null` when the folder is unreadable: the caller
// cannot prove it clean.
function runnerFolderGitDirs(folder) {
  try {
    fs.readdirSync(folder);
  } catch {
    return null;
  }
  if (fs.existsSync(path.join(folder, ".git"))) return [folder];
  const dirs = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || TASK_FOLDER_SCAN_SKIP_NAMES.has(entry.name)) continue;
      const child = path.join(dir, entry.name);
      if (fs.existsSync(path.join(child, ".git")) && !seen.has(child)) {
        seen.add(child);
        dirs.push(child);
      }
      if (depth > 0) visit(child, depth - 1);
    }
  };
  visit(folder, 3);
  return dirs;
}

// Verdict for one folder: `remove` (every git repo inside is clean and fully pushed), or
// `archive-remove` (unpushed work, or a git state the host cannot read — the archive keeps
// what the host could not inspect). The board status is checked first.
function judgeRunnerTaskFolder(folder, boardStatus) {
  if (boardStatus !== undefined) {
    if (!boardStatus.ok) {
      return { action: "keep", reason: `board-unavailable${boardStatus.statusCode ? `-${boardStatus.statusCode}` : ""}` };
    }
    if (!["done", "cancelled"].includes(boardStatus.status)) {
      return { action: "keep", reason: `issue-status:${boardStatus.status}` };
    }
  }
  const gitDirs = runnerFolderGitDirs(folder);
  if (gitDirs === null) return { action: "archive-remove", reason: "unreadable-folder" };
  if (gitDirs.length === 0) return { action: "remove", reason: "no-git-repos" };
  for (const dir of gitDirs) {
    const readable = isGitWorktree(dir);
    if (!readable || !isClean(dir) || !isPushed(dir) || hasStash(dir) || hasAlternates(dir)) {
      return { action: "archive-remove", reason: "unsafe-archive" };
    }
  }
  return { action: "remove", reason: "clean-pushed" };
}

/**
 * Task folders of runner issues (OPE-12855) under `<runnersRoot>/<runner>/{workspace,home}/`:
 * names `OPE-<n>`, `OPE-<n>-wt` (workspace) and `wt-ope<n>` (home). A folder younger than
 * `ttlHours` (the clone TTL, by the folder's own mtime) is `retention`; an older one asks the
 * board for the issue status (fail-closed: an unreachable board keeps the folder) and the git
 * guards decide `remove` vs `archive-remove`. Every component of the path must be a real
 * directory; a symlink anywhere skips the entry. The scan never throws: per-root and
 * per-runner failures go through `onEvent` (`runner-folder-root-missing`,
 * `runner-folder-scan-failed`) and the scan continues — one unreadable runner must not abort
 * the whole `--apply` pass. `fetchStatus` is injectable for tests; the default is the board
 * call the clone pass uses.
 */
export async function scanRunnerTaskFolders(runnersRoot, now, ttlHours, { onEvent = () => {}, fetchStatus = fetchIssueStatus } = {}) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  const fail = (extra, err) => {
    onEvent({ event: "runner-folder-scan-failed", root: runnersRoot, ...extra, error: err?.message || String(err) });
  };
  const rootStat = lstatSafe(runnersRoot);
  if (rootStat.err) {
    if (isAbsent(rootStat.err)) onEvent({ event: "runner-folder-root-missing", root: runnersRoot });
    else fail({}, rootStat.err);
    return results;
  }
  if (!rootStat.st.isDirectory()) {
    fail({}, new Error("runner root is not a directory (a symlink is not followed)"));
    return results;
  }
  let runners;
  try {
    runners = fs.readdirSync(runnersRoot, { withFileTypes: true });
  } catch (err) {
    fail({}, err);
    return results;
  }
  for (const runner of runners) {
    if (!runner.isDirectory()) continue;
    for (const base of ["workspace", "home"]) {
      const baseDir = path.join(runnersRoot, runner.name, base);
      const { st: baseSt, err: baseErr } = lstatSafe(baseDir);
      if (baseErr && !isAbsent(baseErr)) {
        fail({ runner: runner.name }, baseErr);
        continue;
      }
      if (!baseSt || !baseSt.isDirectory()) continue;
      let entries;
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch (err) {
        fail({ runner: runner.name }, err);
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !RUNNER_TASK_FOLDER_NAME.test(entry.name)) continue;
        const folder = path.join(baseDir, entry.name);
        const { st, err } = lstatSafe(folder);
        if (err && !isAbsent(err)) {
          fail({ runner: runner.name, path: folder }, err);
          continue;
        }
        if (!st || !st.isDirectory()) continue;
        const item = {
          runner: runner.name,
          name: entry.name,
          identifier: issueIdentifierFromRunnerFolderName(entry.name),
          path: folder,
          runnersRoot,
          ageMs: now - st.mtimeMs,
          mtimeMs: st.mtimeMs,
          action: "keep",
          reason: "retention",
        };
        if (now - st.mtimeMs >= ttlMs && item.identifier) {
          try {
            const verdict = judgeRunnerTaskFolder(folder, await fetchStatus(item.identifier));
            item.action = verdict.action;
            item.reason = verdict.reason;
          } catch (err) {
            fail({ runner: runner.name, path: folder }, err);
            item.reason = "scan-failed";
          }
        }
        results.push(item);
      }
    }
  }
  return results;
}

// --- Archive ----------------------------------------------------------------

function archiveClone(clonePath, archiveRoot) {
  if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, { recursive: true });
  const name = path.basename(clonePath);
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-").slice(0, 15);
  const hasZstd = spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
  const extension = hasZstd ? "tar.zst" : "tar.gz";
  const archivePath = path.join(archiveRoot, `${name}-${ts}.${extension}`);
  let result;
  let verify;
  if (hasZstd) {
    // Prefer zstd, but do not make archival depend on an optional host binary.
    result = spawnSync("bash", ["-c", `tar -cf - -C "${path.dirname(clonePath)}" "${name}" | zstd -q -o "${archivePath}"`], { timeout: 120000 });
    verify = ["bash", ["-c", `zstd -q -d -c "${archivePath}" | tar -tf - > /dev/null`]];
  } else {
    result = spawnSync("tar", ["-czf", archivePath, "-C", path.dirname(clonePath), name], { timeout: 120000 });
    verify = ["tar", ["-tzf", archivePath]];
  }
  if (result.status !== 0) throw new Error(`archive failed for ${clonePath}: ${result.stderr}`);
  const verification = spawnSync(verify[0], verify[1], { timeout: 60000, stdio: "ignore" });
  if (verification.status !== 0) throw new Error(`archive verification failed for ${archivePath}`);
  return archivePath;
}

// --- Main -------------------------------------------------------------------

async function main() {
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

    const plan = { clones: [], caches: [], runCopies: [], runnerTaskFolders: [], kept: [], removed: [], archived: [] };

    // 1. Scan task clones
    const clones = scanTaskClones(root, now, args.cloneTtlHours);
    const cloneStatuses = await filterClosedTaskClones(clones);
    for (const skipped of cloneStatuses.skipped) {
      journalRecord(args.journal, {
        event: "clone-skipped",
        path: skipped.path,
        identifier: skipped.identifier,
        status: skipped.status,
        reason: skipped.reason,
      });
    }
    for (const c of cloneStatuses.candidates) {
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

    // 3c. SSH runner run copies (OPE-12722): only when a runner root is configured.
    // A failure of one root or runner is journaled and skipped, never thrown: it must not
    // abort the clones and caches passes of the same --apply.
    for (const runnersRoot of args.runnerRoots) {
      const items = scanSshRunCopies(runnersRoot, now, args.runCopyTtlHours, {
        onEvent: (event) => journalRecord(args.journal, event),
      });
      for (const item of items) {
        if (item.reason === "ttl") plan.runCopies.push({ ...item, action: "remove" });
        else plan.kept.push({ ...item, action: "keep", reason: "fresh" });
      }
    }

    // 3d. Task folders of runner issues (OPE-12855): only when a runner root is configured,
    // the same gate as 3c. The scan asks the board for the issue status (fail-closed: an
    // unreachable board keeps the folder) and the git guards decide removal vs archive.
    for (const runnersRoot of args.runnerRoots) {
      const items = await scanRunnerTaskFolders(runnersRoot, now, args.cloneTtlHours, {
        onEvent: (event) => journalRecord(args.journal, event),
      });
      for (const item of items) {
        if (item.action === "keep") {
          if (item.reason !== "retention") {
            journalRecord(args.journal, {
              event: "runner-task-folder-skipped",
              path: item.path,
              identifier: item.identifier,
              runner: item.runner,
              reason: item.reason,
            });
          }
          plan.kept.push({ ...item, action: "keep", reason: item.reason });
          continue;
        }
        plan.runnerTaskFolders.push({ ...item, action: item.action });
      }
    }


    // 3. Execute or report
    if (args.dryRun) {
      journalRecord(args.journal, { event: "dry-run", clones: plan.clones.length, caches: plan.caches.length, runCopies: plan.runCopies.length, runnerTaskFolders: plan.runnerTaskFolders.length, kept: plan.kept.length });
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
      const runCopiesGone = pruneSshRunCopies(plan.runCopies.filter((x) => x.action === "remove"), args.journal);
      for (const gone of runCopiesGone) plan.removed.push({ path: gone });
      let runnerTaskFoldersRemoved = 0;
      // myrmidon(1.6.8 OPE-12855): archive-then-remove for folders whose git state could not
      // be proven, plain removal for clean closed ones; both guarded against the runner root.
      for (const f of plan.runnerTaskFolders.filter((x) => x.action === "archive-remove")) {
        try {
          const archivePath = archiveClone(f.path, path.join(f.runnersRoot, ".gc-archive"));
          journalRecord(args.journal, { event: "runner-task-folder-archived", path: f.path, archive: archivePath, reason: f.reason });
          atomicDrop(f.path, f.runnersRoot);
          plan.archived.push({ path: f.path, archive: archivePath });
          journalRecord(args.journal, { event: "runner-task-folder-removed-after-archive", path: f.path, archive: archivePath });
          runnerTaskFoldersRemoved++;
        } catch (err) {
          journalRecord(args.journal, { event: "runner-task-folder-archive-failed", path: f.path, error: err.message });
        }
      }
      for (const f of plan.runnerTaskFolders.filter((x) => x.action === "remove")) {
        try {
          atomicDrop(f.path, f.runnersRoot);
          plan.removed.push({ path: f.path });
          journalRecord(args.journal, { event: "runner-task-folder-removed", path: f.path, reason: f.reason, runner: f.runner, ageHours: Math.round(f.ageMs / HOUR_MS) });
          runnerTaskFoldersRemoved++;
        } catch (err) {
          journalRecord(args.journal, { event: "runner-task-folder-remove-failed", path: f.path, error: err.message });
        }
      }
      journalRecord(args.journal, { event: "apply-complete", runCopiesRemoved: runCopiesGone.length, runnerTaskFoldersRemoved, removed: plan.removed.length, archived: plan.archived.length, kept: plan.kept.length });
      console.log(JSON.stringify({ ok: true, dryRun: false, removed: plan.removed.length, archived: plan.archived.length, runCopiesRemoved: runCopiesGone.length, runnerTaskFoldersRemoved, kept: plan.kept.length }, null, 2));
    }
  } finally {
    lock.release();
  }
}

// Only run main when executed directly (not when imported by tests)
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    if (err instanceof UsageError) {
      console.error(JSON.stringify({ ok: false, reason: err.message }));
      process.exitCode = 2;
      return;
    }
    console.error(err);
    process.exitCode = 1;
  });
}
