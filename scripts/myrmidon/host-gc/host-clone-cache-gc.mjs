#!/usr/bin/env node
// myrmidon(1.6.7-BOT-DISK-HOST-GC): Host-side GC for task clones and build caches.
// Replaces the temporary devbuild-v2-gc.sh with a unified, journaled scheduler.
//
// Targets:
//   - vm-core:       /srv/myrmidon-bots/* (bot workspaces)
//   - vm-core:       <runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId> (SSH runner
//                    run copies, OPE-12722; only when a runner root is configured)
//   - vm-core:       <runner root>/<runner>/home/.npm/{_cacache,_npx} (runner agent npm/npx
//                    caches, OPE-12855; only when a runner root is configured)
//   - vm-core:       <runner root>/<runner>/tmp/* (the runner's /tmp bind-mounted from the data
//                    disk, OPE-12966; only when a runner root is configured)
//   - myr-dev-build: /srv/devbuild/* (build copies), /srv/devcache/* (build caches)
//
// Policy:
//   - Task clones (done/cancelled >3h, clean+pushed): remove
//   - Task clones (done/cancelled >3h, dirty/unpushed): archive first, then remove
//   - Active checkouts/worktrees: never touch
//   - Build caches >72h: LRU eviction by mtime
//   - SSH runner run copies >4h (by the run directory's mtime, set when the run starts): remove;
//     runs only with --runner-root / HOST_GC_RUNNER_ROOTS
//   - SSH runner npm/npx caches >4h (by the newest mtime in the cache tree, so a cache an
//     npm/npx call is still writing stays fresh): remove; runs only with
//     --runner-root / HOST_GC_RUNNER_ROOTS
//   - SSH runner /tmp entries (top level of <runner>/tmp) whose newest mtime inside is >24h
//     old: remove; symlinks and other filesystems are never entered; runs only with
//     --runner-root / HOST_GC_RUNNER_ROOTS
//   - SSH runner task folders for done/cancelled issues >3h: clean+pushed remove; unsafe
//     git state archive first, then remove; active/board-unavailable folders stay
//   - Atomic guards: lockfile, symlink checks, TOCTOU-safe deletion
//   - JSONL journal at /var/log/myrmidon-host-gc.jsonl
//
// Modes:
//   --dry-run  (default)  Plan only, no deletion
//   --apply               Execute plan with journal
//   --root <path>         Override root directory (for testing)
//   --journal <path>      Override journal path (for testing)
//   --lock <path>         Override lockfile path (for testing)
//   --clone-ttl <hours>   Override clone TTL (default 3)
//   --cache-ttl <hours>   Override cache TTL (default 72)
//   --runner-root <path>  SSH runner root to prune run copies under (repeatable; also
//                         HOST_GC_RUNNER_ROOTS, colon-separated). No root, no pass.
//   --run-copy-ttl <hours> Override the run-copy TTL (default 4; finite, at least 3 = longest run timeout)
//   --npm-cache-ttl <hours> Override the npm cache TTL (default 4; finite, at least 1)
//   --runner-tmp-ttl <hours> Override the runner /tmp TTL (default 24; finite, at least 3)

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const CLONE_TTL_HOURS = 3;
const CACHE_TTL_HOURS = 72;
const SCRATCH_TTL_HOURS = 12;
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
const DEFAULT_ENV_PATH = "/etc/myrmidon-host-gc.env";

// myrmidon(1.6.8 OPE-12855): the npm/npx caches of a runner agent
// (`<runner>/home/.npm/{_cacache,_npx}`) are pure download/index caches: npm refills them on
// demand, so a removed entry costs a re-download and nothing else. The TTL is judged by the
// newest mtime in the cache tree — a cache an npm/npx call is still writing stays `fresh` —
// with a floor of 1 h so a scan cannot race a long npm install. Same runner-root gate as the
// run-copy pass; no root, no pass.
const NPM_CACHE_TTL_HOURS = 4;
const NPM_CACHE_MIN_TTL_HOURS = 1;

// myrmidon(OPE-12966): the omp SSH runner's /tmp lives on the data volume
// (`<runner>/tmp`, docker/agent-runtime/omp-ssh/compose.yml) instead of the container's write
// layer on the root disk, and nothing removed what tests and task tooling leave there (15.8 GB
// in two days on 13.11). The pass removes top-level entries of `<runner>/tmp` not changed
// anywhere inside for the TTL; the same gate as the run-copy pass (a runner root is configured).
const RUNNER_TMP_TTL_HOURS = 24;
const RUNNER_TMP_MIN_TTL_HOURS = 3;

// myrmidon(1.6.8-BOT-CONTAINER-ORPHAN / OPE-12654): the data directory of a decommissioned
// bot (the gate A22 removed its container, the board logs `bot_data_left_for_host_gc`) is
// removed by this host pass, not by the gate: the gate is uid 65532 and holds the volume root
// read-only, so its delete could never succeed (the ADM hand-off of 11.11). A directory goes
// only when every guard says go:
//   - the name is a lowercase UUID bot key (`botKeyPattern`),
//   - the board lists no hermes_gateway card with this agent id (the adapter moved away, or
//     the agent is gone),
//   - the agent has no heartbeat run in "running",
//   - the gate has no `myrmidon-bot-<key>` container (any state, including leftovers `.next`
//     and `.helper`),
//   - the directory is older than the retention delay (24 h, the clone TTL of the workspaces),
//   - the git worktrees inside hold no unpushed work: no uncommitted edits, no stash, and no
//     commits ahead of their upstream; a `.next` or `.helper` directory is not a worktree and
//     is not touched.
// A directory that fails any guard is kept and journalled with the reason — never archived,
// never partially removed. Everything is best-effort: an unreachable board or gate keeps the
// directories (fail-closed).
const BOT_DATA_TTL_HOURS = 24;
const BOT_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOCKER_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 30_000;
const HERMES_GATEWAY_ADAPTER_TYPE = "hermes_gateway";

// myrmidon(1.6.8 OPE-12855): a runner keeps one task folder per board issue it ever checked
// out: the clone folder `<runner>/workspace/OPE-<n>/` (the repo inside is a full clone) and
// worktree folders (`<runner>/workspace/OPE-<n>-wt/`, `<runner>/home/wt-ope<n>`), whose
// `.git` file points into a run directory that is deleted when the run ends. A done or
// cancelled issue's folder is never cleaned up: on 11.11 four runners held 41.5 GB of them
// and the bots volume stood at 91%. The folder of a done/cancelled issue is removed like a
// task clone (the clone TTL, git-clean guards), with one difference: a folder whose git
// state cannot be proven from the host (a worktree with a dead gitdir fails every git
// command) is archived to `<runner root>/.gc-archive/` first and only then removed — the
// archive is the safety net for work the host cannot inspect. Folders of issues in any
// other status are kept, and the pass runs only when a runner root is configured (the
// same gate as the run-copy pass above).
const RUNNER_TASK_FOLDER_NAME = /^(OPE-\d+(?:-wt)?|wt-ope\d+)$/i;
const RUNNER_TASK_FOLDER_KEY = /^(?:OPE-(\d+)(?:-wt)?|wt-ope(\d+))$/i;

// --- Env Config -------------------------------------------------------------

export function loadEnvConfig(envPath = DEFAULT_ENV_PATH) {
  if (!envPath || !fs.existsSync(envPath)) return {};
  try {
    const content = fs.readFileSync(envPath, "utf8");
    const result = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// --- Args -------------------------------------------------------------------

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

/** `null` when `hours` is a usable npm cache TTL, otherwise the reason it is refused. */
export function npmCacheTtlError(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) {
    return `--npm-cache-ttl must be a finite number of hours (got ${String(hours)})`;
  }
  if (hours < NPM_CACHE_MIN_TTL_HOURS) {
    return `--npm-cache-ttl must be at least ${NPM_CACHE_MIN_TTL_HOURS} hour(s), the longest npm install can run (got ${hours})`;
  }
  return null;
}

/** `null` when `hours` is a usable runner /tmp TTL, otherwise the reason it is refused. */
export function runnerTmpTtlError(hours) {
  if (typeof hours !== "number" || !Number.isFinite(hours)) {
    return `--runner-tmp-ttl must be a finite number of hours (got ${String(hours)})`;
  }
  if (hours < RUNNER_TMP_MIN_TTL_HOURS) {
    return `--runner-tmp-ttl must be at least ${RUNNER_TMP_MIN_TTL_HOURS} hours, the longest run timeout (got ${hours})`;
  }
  return null;
}

export function parseArgs(argv) {
  let envPath = DEFAULT_ENV_PATH;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--env" && argv[i + 1]) {
      envPath = argv[++i];
    }
  }
  loadEnvConfig(envPath);

  const envTtl = process.env.SCRATCH_TTL_HOURS ||
    process.env.SCRATCH_TTL ||
    process.env.BOT_SCRATCH_TTL_HOURS ||
    process.env.HOST_GC_SCRATCH_TTL_HOURS ||
    process.env.MYRMIDON_HOST_GC_SCRATCH_TTL_HOURS;
  const defaultScratchTtl = envTtl !== undefined && !isNaN(Number(envTtl))
    ? Number(envTtl)
    : SCRATCH_TTL_HOURS;

  const args = {
    dryRun: true,
    root: null,
    scratchRoots: [],
    journal: "/var/log/myrmidon-host-gc.jsonl",
    lock: "/var/run/myrmidon-host-gc.lock",
    cloneTtlHours: CLONE_TTL_HOURS,
    cacheTtlHours: CACHE_TTL_HOURS,
    scratchTtlHours: defaultScratchTtl,
    procDir: process.env.PROC_DIR || "/proc",
    runnerRoots: (process.env.HOST_GC_RUNNER_ROOTS || "").split(":").map((r) => r.trim()).filter(Boolean),
    runCopyTtlHours: RUN_COPY_TTL_HOURS,
    runnerTmpTtlHours: RUNNER_TMP_TTL_HOURS,
    npmCacheTtlHours: (() => {
      const envTtl = process.env.MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS;
      return envTtl !== undefined && !isNaN(Number(envTtl)) ? Number(envTtl) : NPM_CACHE_TTL_HOURS;
    })(),
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.dryRun = false;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--scratch-root") args.scratchRoots.push(argv[++i]);
    else if (a === "--journal") args.journal = argv[++i];
    else if (a === "--lock") args.lock = argv[++i];
    else if (a === "--clone-ttl") args.cloneTtlHours = Number(argv[++i]);
    else if (a === "--cache-ttl") args.cacheTtlHours = Number(argv[++i]);
    else if (a === "--scratch-ttl") args.scratchTtlHours = Number(argv[++i]);
    else if (a === "--proc-dir") args.procDir = argv[++i];
    else if (a === "--runner-root") args.runnerRoots.push(argv[++i]);
    else if (a === "--run-copy-ttl") args.runCopyTtlHours = Number(argv[++i]);
    else if (a === "--npm-cache-ttl") args.npmCacheTtlHours = Number(argv[++i]);
    else if (a === "--runner-tmp-ttl") args.runnerTmpTtlHours = Number(argv[++i]);
    else if (a === "--env") i++;
    else if (a === "--help") {
      console.log("Usage: host-clone-cache-gc.mjs [--apply|--dry-run] [--root path] [--scratch-root path] [--journal path] [--lock path] [--clone-ttl h] [--cache-ttl h] [--scratch-ttl h] [--proc-dir path] [--runner-root path] [--run-copy-ttl h (>= 3)] [--runner-tmp-ttl h (>= 3)] [--env path]");
      process.exit(0);
    }
  }
  const ttlError = runCopyTtlError(args.runCopyTtlHours);
  if (ttlError) throw new UsageError(ttlError);
  const npmTtlError = npmCacheTtlError(args.npmCacheTtlHours);
  if (npmTtlError) throw new UsageError(npmTtlError);
  const tmpTtlError = runnerTmpTtlError(args.runnerTmpTtlHours);
  if (tmpTtlError) throw new UsageError(tmpTtlError);
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

// --- Scratch GC (BOT-DISK-SCRATCH) -------------------------------------------

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

// --- Runner task folders (OPE-12855) -----------------------------------------

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
      if (entry.name.startsWith(".") || BOT_SCAN_SKIP_NAMES.has(entry.name)) continue;
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

// --- Runner unrecognized workspace folders (OPE-13018) --------------------------

// Names the runner workspace legitimately holds besides the task folders: the
// runtime state directory the board spares from every cleanup. Everything else
// the OMP agent created with a name that is not a task-folder pattern is
// "unrecognized": the GC reports it, never removes it.
const RUNNER_WORKSPACE_KNOWN_NAMES = new Set([".paperclip-runtime"]);

/**
 * Directories in `<runnersRoot>/<runner>/workspace` whose names do not match
 * `RUNNER_TASK_FOLDER_NAME` and are not known runtime directories. A folder
 * younger than `ttlHours` (by its own mtime) is fresh — the agent may still be
 * working in it; an older one is reported so a typo'd task folder (e.g.
 * `OPR-12962` for `OPE-12962`, myrmidon OPE-13018) does not sit on the disk
 * forever without a trace. Report-only: nothing here is ever deleted, the
 * entry is journaled as `runner-unrecognized-workspace-folder` and returned
 * with `action: "report"`. Every path component must be a real directory; a
 * symlink anywhere skips the entry. Failures go to `onEvent`
 * (`runner-unrecognized-scan-failed`) and the scan continues.
 */
export function scanRunnerUnrecognizedWorkspaceFolders(runnersRoot, now, ttlHours, { onEvent = () => {} } = {}) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  const fail = (extra, err) => {
    onEvent({ event: "runner-unrecognized-scan-failed", root: runnersRoot, ...extra, error: err?.message || String(err) });
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
    const workspaceDir = path.join(runnersRoot, runner.name, "workspace");
    const { st: baseSt, err: baseErr } = lstatSafe(workspaceDir);
    if (baseErr && !isAbsent(baseErr)) {
      fail({ runner: runner.name }, baseErr);
      continue;
    }
    if (!baseSt || !baseSt.isDirectory()) continue;
    let entries;
    try {
      entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch (err) {
      fail({ runner: runner.name }, err);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (RUNNER_TASK_FOLDER_NAME.test(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;
      if (RUNNER_WORKSPACE_KNOWN_NAMES.has(entry.name)) continue;
      const folder = path.join(workspaceDir, entry.name);
      const { st, err } = lstatSafe(folder);
      if (err && !isAbsent(err)) {
        fail({ runner: runner.name, path: folder }, err);
        continue;
      }
      if (!st || !st.isDirectory()) continue;
      const ageMs = now - st.mtimeMs;
      results.push({
        runner: runner.name,
        name: entry.name,
        path: folder,
        runnersRoot,
        ageMs,
        mtimeMs: st.mtimeMs,
        action: "report",
        reason: ageMs >= ttlMs ? "unrecognized-ttl" : "unrecognized-fresh",
      });
    }
  }
  return results;
}

export function collectOpenProcInfo(procDir = "/proc") {
  const openPaths = new Set();
  const openInodes = new Set();
  if (!fs.existsSync(procDir)) return { openPaths, openInodes };
  let pids = [];
  try {
    pids = fs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
  } catch {
    return { openPaths, openInodes };
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
      const fdPath = path.join(fdDir, fd);
      try {
        const link = fs.readlinkSync(fdPath);
        if (link.startsWith("/")) {
          openPaths.add(link);
          try { openPaths.add(fs.realpathSync(link)); } catch {}
        }
      } catch {}
      try {
        const st = fs.statSync(fdPath);
        openInodes.add(`${st.dev}:${st.ino}`);
      } catch {}
    }
    const cwdPath = path.join(procDir, pid, "cwd");
    try {
      const cwd = fs.readlinkSync(cwdPath);
      if (cwd.startsWith("/")) {
        openPaths.add(cwd);
        try { openPaths.add(fs.realpathSync(cwd)); } catch {}
      }
    } catch {}
    try {
      const st = fs.statSync(cwdPath);
      openInodes.add(`${st.dev}:${st.ino}`);
    } catch {}
  }
  return { openPaths, openInodes };
}

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

export function isTreeOpen(targetPath, inodes, openPaths, openInodes) {
  const normTarget = path.resolve(targetPath);
  for (const ino of inodes) {
    if (openInodes.has(ino)) return true;
  }
  for (const p of openPaths) {
    if (p === normTarget || p.startsWith(normTarget + path.sep)) return true;
  }
  return false;
}

export function scanScratchDirectory(scratchDir, now, ttlHours, openInfo = { openPaths: new Set(), openInodes: new Set() }) {
  const ttlMs = ttlHours * HOUR_MS;
  const results = [];
  if (!fs.existsSync(scratchDir)) return results;

  let entries = [];
  try {
    entries = fs.readdirSync(scratchDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(scratchDir, entry.name);
    if (entry.name === "gh-cli-cache") {
      results.push({ name: entry.name, path: fullPath, reason: "protected-gh-cli-cache", sizeBytes: 0, ageMs: 0 });
      continue;
    }
    const { maxMtimeMs, totalSizeBytes, inodes } = inspectPathTree(fullPath);
    const ageMs = now - maxMtimeMs;

    if (isTreeOpen(fullPath, inodes, openInfo.openPaths, openInfo.openInodes)) {
      results.push({ name: entry.name, path: fullPath, reason: "open-by-process", sizeBytes: totalSizeBytes, ageMs });
      continue;
    }

    if (ageMs >= ttlMs) {
      results.push({ name: entry.name, path: fullPath, reason: "ttl", sizeBytes: totalSizeBytes, ageMs, mtimeMs: maxMtimeMs });
    } else {
      results.push({ name: entry.name, path: fullPath, reason: "fresh", sizeBytes: totalSizeBytes, ageMs, mtimeMs: maxMtimeMs });
    }
  }

  return results;
}

export function discoverBotScratchDirs(botsRoot) {
  const dirs = [];
  if (!fs.existsSync(botsRoot)) return dirs;
  let entries = [];
  try {
    entries = fs.readdirSync(botsRoot, { withFileTypes: true });
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const scratchDir = path.join(botsRoot, entry.name, "hermes/cache/scratch");
    if (fs.existsSync(scratchDir)) {
      dirs.push(scratchDir);
    }
  }
  return dirs;
}

// --- Bot data GC (OPE-12654) -------------------------------------------------

// Every container of the gate on this host, any state, with the bot label. The
// plain `docker ps -a --filter label=myrmidon.bot` covers main, .next and
// .helper: one key lists once, so a leftover keeps its data directory held as
// well as a running main.
export function listBotContainers({ docker = "docker", timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  const res = spawnSync(docker, ["ps", "-a", "--format", "{{.Labels}}"], { encoding: "utf8", timeout: timeoutMs });
  if (res.error || res.status !== 0) return { ok: false, reason: res.error?.code === "ENOENT" ? "docker-unavailable" : "docker-failed" };
  const keys = new Set();
  for (const line of (res.stdout || "").split("\n")) {
    const m = /(?:^|,)myrmidon\.bot=([0-9a-f-]+)(?:,|$)/.exec(line.trim());
    if (m) keys.add(m[1].toLowerCase());
  }
  return { ok: true, keys };
}

// One `GET /api/agents/{id}` against the board (real route, server/src/routes/agents.ts).
// The lookup happens per candidate directory, only after the container and retention
// guards passed, so a pass makes a handful of calls at most. The verdict decides the
// guard of the plan below:
//   - 404: the agent row is gone (hard delete) — the bot may go;
//   - 200 + status "terminated" — the agent was fired, the bot may go;
//   - 200 + adapter "hermes_gateway" (any other status) — a live hermes card: never touch
//     its bot data (the contract keeps hermes containers and their directories);
//   - 200 + status "running" — a heartbeat run is in flight: keep, the bot may still be
//     written to;
//   - 200 + any other adapter and status — the agent moved off hermes_gateway and is
//     idle: the bot may go;
//   - 401/403/5xx, a network error or a malformed body — the board could not answer:
//     fail-closed, the directory stays.
export async function fetchAgentDecommissionState(agentId, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!BOT_KEY_PATTERN.test(agentId)) return { ok: false, reason: "bad-agent-id" };
  let base = (baseUrl || "").replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:3100";
  if (!base.endsWith("/api")) base += "/api";
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${base}/agents/${encodeURIComponent(agentId)}`;
  let response;
  try {
    response = await fetchImpl(url, { headers });
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
  if (response.status === 404) return { ok: true, state: "deleted" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "board-forbidden", statusCode: response.status };
  if (!response.ok) return { ok: false, reason: "board-unavailable", statusCode: response.status };
  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
  if (!body || typeof body !== "object" || typeof body.adapterType !== "string" || typeof body.status !== "string") {
    return { ok: false, reason: "board-unavailable" };
  }
  if (body.status === "terminated") return { ok: true, state: "terminated" };
  if (body.adapterType === HERMES_GATEWAY_ADAPTER_TYPE) return { ok: true, state: "hermes_gateway" };
  if (body.status === "running") return { ok: true, state: "running" };
  return { ok: true, state: "left_hermes_gateway" };
}

// The unpushed-work scan of one bot data directory (OPE-12654): every git worktree under
// <dir>/workspace must be clean, without stash, without an operation in progress, and
// without unpushed commits. The clone layout is <dir>/workspace/<ISSUE-KEY>/repo (one task,
// one clone per the working-copy rule), so the walk goes deep enough to find the repos;
// `.next` and `.helper` are not worktrees and are skipped, like `node_modules`. The verdict
// matches the clone-hygiene report the board holds a decommission for. Any git command that
// fails unexpectedly (and an unreadable workspace) is fail-closed: the directory is held
// with a reason, not removed.
const BOT_SCAN_SKIP_NAMES = new Set([".next", ".helper", "node_modules", ".gc-archive"]);
const BOT_SCAN_MAX_DEPTH = 4;

function botDataGitOpInProgress(gitDir) {
  for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply"]) {
    if (fs.existsSync(path.join(gitDir, marker))) return marker;
  }
  return null;
}

export function scanBotDataForUnpushedWork(dir, { gitBin = "git", timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const workspace = path.join(dir, "workspace");
  const reasons = [];
  let entries;
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return { unpushed: false, reasons: [] }; // no workspace: nothing unpushed by definition
    return { unpushed: true, reasons: [`workspace: unreadable (${err?.code || "error"})`] };
  }

  const walk = (base, rel, depth) => {
    let list;
    try {
      list = fs.readdirSync(base, { withFileTypes: true });
    } catch (err) {
      reasons.push(`${rel || "."}: unreadable (${err?.code || "error"})`);
      return;
    }
    for (const entry of list) {
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      if (BOT_SCAN_SKIP_NAMES.has(entry.name)) continue;
      const repo = path.join(base, entry.name);
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      const run = (args) => spawnSync(gitBin, args, { cwd: repo, encoding: "utf8", timeout: timeoutMs });
      const inside = run(["rev-parse", "--is-inside-work-tree"]);
      if (inside.error || (inside.status !== 0 && inside.status !== 128)) {
        reasons.push(`${relName}: git failed (${inside.status ?? "spawn"})`);
        continue;
      }
      if (inside.status === 128 || inside.stdout?.trim() !== "true") {
        // Not a worktree — keep walking below it (e.g. <ISSUE>/<repo>).
        if (depth < BOT_SCAN_MAX_DEPTH) walk(repo, relName, depth + 1);
        continue;
      }
      // A worktree: inspect it.
      if (run(["status", "--porcelain"]).stdout?.trim() !== "") reasons.push(`${relName}: uncommitted changes`);
      if (run(["stash", "list"]).stdout?.trim() !== "") reasons.push(`${relName}: stash entries`);
      const gitDirOut = run(["rev-parse", "--absolute-git-dir"]);
      const gitDir = gitDirOut.status === 0 ? gitDirOut.stdout?.trim() : path.join(repo, ".git");
      const op = botDataGitOpInProgress(gitDir);
      if (op) reasons.push(`${relName}: ${op} in progress`);
      const ahead = run(["log", "@{u}..HEAD", "--oneline"]);
      if (ahead.status === 0) {
        if (ahead.stdout?.trim() !== "") reasons.push(`${relName}: commits ahead of upstream`);
      } else {
        // No upstream configured: count commits that exist on no remote — a local
        // branch or a detached HEAD with work that was never pushed.
        const unpushed = run(["log", "--oneline", "--branches", "--not", "--remotes"]);
        const detached = run(["log", "--oneline", "-1", "HEAD", "--not", "--remotes"]);
        if (unpushed.error || detached.error) {
          reasons.push(`${relName}: git failed checking upstream`);
        } else if (unpushed.stdout?.trim() !== "" || detached.stdout?.trim() !== "") {
          reasons.push(`${relName}: commits on no remote`);
        }
      }
    }
  };
  walk(workspace, "", 0);
  return { unpushed: reasons.length > 0, reasons };
}

// The XFS project quota of a removed bot (host side of the gate's hand-off): the gate
// keeps `botKey -> project id` in /etc/projid and /etc/projects and leaves the entries
// in place while the data directory exists (Quota.Remove refuses then). After this pass
// removes the directory it clears the entries the same way the gate does — drop the
// /etc/projid line, the matching /etc/projects lines, and reset the limits of the
// project id — and then `xfs_quota project -s` is not needed: the directory is gone.
// Best-effort and only when the files are readable/writable (root on vm-core): a
// failure is journaled, not thrown, and never blocks the directory removal itself.
export function clearBotDiskProject(botKey, {
  projidFile = "/etc/projid",
  projectsFile = "/etc/projects",
  xfsQuotaBin = "xfs_quota",
  volumeRoot = "/srv/myrmidon-bots",
} = {}) {
  const result = { cleared: false, projectId: null, reasons: [] };
  let projidLines;
  try {
    projidLines = fs.readFileSync(projidFile, "utf8").split("\n");
  } catch (err) {
    result.reasons.push(`read ${projidFile}: ${err?.code || "error"}`);
    return result;
  }
  let projectId = 0;
  const newProjid = [];
  for (const line of projidLines) {
    const key = line.slice(0, Math.max(line.indexOf(":"), 0));
    if (key === botKey) {
      projectId = Number.parseInt(line.slice(key.length + 1), 10) || 0;
      continue;
    }
    newProjid.push(line);
  }
  result.projectId = projectId || null;
  if (projectId === 0) return result; // nothing registered: nothing to clear
  let projectsLines;
  try {
    projectsLines = fs.readFileSync(projectsFile, "utf8").split("\n");
  } catch (err) {
    result.reasons.push(`read ${projectsFile}: ${err?.code || "error"}`);
    return result;
  }
  const idText = String(projectId);
  const dir = path.join(volumeRoot, botKey);
  const newProjects = projectsLines.filter((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return true;
    const lineKey = line.slice(0, idx);
    const lineValue = line.slice(idx + 1);
    return lineKey !== idText && lineValue !== dir;
  });
  // Reset the limits first: with the entries gone from the files, an xfs_quota call is
  // the only way to lift a hard limit left on the project id.
  if (fs.existsSync(xfsQuotaBin) || spawnSync(xfsQuotaBin, ["-V"], { encoding: "utf8" }).status === 0) {
    const clear = spawnSync(xfsQuotaBin, ["-x", "-c", `limit -p bhard=0 bsoft=0 ${idText}`, volumeRoot], { encoding: "utf8", timeout: 30000 });
    if (clear.status !== 0) result.reasons.push(`xfs_quota limit: ${clear.status}`);
  }
  try {
    fs.writeFileSync(projidFile, newProjid.join("\n"));
  } catch (err) {
    result.reasons.push(`write ${projidFile}: ${err?.code || "error"}`);
  }
  try {
    fs.writeFileSync(projectsFile, newProjects.join("\n"));
  } catch (err) {
    result.reasons.push(`write ${projectsFile}: ${err?.code || "error"}`);
  }
  result.cleared = result.reasons.length === 0;
  return result;
}

// The bot-data plan: candidates, guards, verdicts. `now` is injected for the tests. The
// board is asked per candidate (`fetchAgentDecommissionState`) — never when docker or the
// retention guard already held every directory.
export async function planBotDataGc(
  root,
  { now = Date.now(), ttlHours = BOT_DATA_TTL_HOURS, containers, agentState = fetchAgentDecommissionState, scan = scanBotDataForUnpushedWork } = {},
) {
  const ttlMs = ttlHours * HOUR_MS;
  const plan = [];
  if (!containers?.ok) {
    return { ok: false, reason: containers?.reason || "docker-unavailable" };
  }
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { ok: true, plan };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !BOT_KEY_PATTERN.test(entry.name)) continue;
    const dir = safeJoin(root, entry.name);
    const st = fs.statSync(dir);
    const item = { name: entry.name, path: dir, ageMs: now - st.mtimeMs, action: "keep", reason: "" };
    if (item.ageMs < ttlMs) {
      item.reason = "retention";
    } else if (containers.keys.has(entry.name)) {
      item.reason = "container-exists";
    } else {
      const agent = await agentState(entry.name);
      if (!agent?.ok) {
        item.reason = "board-unavailable";
        item.details = [agent?.reason || "board-unavailable"];
      } else if (agent.state === "hermes_gateway") {
        item.reason = "agent-on-hermes-gateway";
      } else if (agent.state === "running") {
        item.reason = "agent-has-running-run";
      } else {
        const { unpushed, reasons } = scan(dir);
        if (unpushed) {
          item.reason = "unpushed-work";
          item.details = reasons;
        } else {
          item.action = "remove";
          item.reason = agent.state === "terminated" ? "agent-terminated-clean" : agent.state === "deleted" ? "agent-deleted-clean" : "decommissioned-clean";
        }
      }
    }
    plan.push(item);
  }
  return { ok: true, plan };
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

/**
 * npm/npx caches of one runner agent under `<runnersRoot>/<runner>/home/.npm/`:
 * `_cacache` (the download/index cache) and `_npx` (the npx package cache). Every component
 * of the path must be a real directory — a symlinked `.npm` or cache dir skips the runner —
 * and the TTL is judged by the newest mtime in the cache tree (`inspectPathTree`), so a
 * cache an npm/npx call is still writing stays `fresh` no matter how old its root is. Each
 * item carries `kind` (`_cacache`|`_npx`) and `runnersRoot`, the root the removal is
 * guarded against.
 *
 * The scan never throws on the filesystem: a configured root that does not exist is reported
 * as `runner-npm-cache-root-missing`, any other failure (per root or per runner) as
 * `runner-npm-cache-scan-failed` with the error message, through `onEvent`, and the scan
 * continues with the next runner — one unreadable directory must not abort the whole
 * `--apply` pass.
 */
export function scanRunnerNpmCaches(runnersRoot, now, ttlHours, { onEvent = () => {} } = {}) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  const fail = (extra, err) => {
    onEvent({ event: "runner-npm-cache-scan-failed", root: runnersRoot, ...extra, error: err?.message || String(err) });
  };

  const rootStat = lstatSafe(runnersRoot);
  if (rootStat.err) {
    if (isAbsent(rootStat.err)) onEvent({ event: "runner-npm-cache-root-missing", root: runnersRoot });
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
    const npmDir = path.join(runnersRoot, runner.name, "home", ".npm");
    try {
      const { st, err } = lstatSafe(npmDir);
      if (err && !isAbsent(err)) throw err;
      if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
      for (const kind of ["_cacache", "_npx"]) {
        const cachePath = path.join(npmDir, kind);
        const cacheStat = lstatSafe(cachePath);
        if (cacheStat.err && !isAbsent(cacheStat.err)) throw cacheStat.err;
        if (!cacheStat.st || !cacheStat.st.isDirectory() || cacheStat.st.isSymbolicLink()) continue;
        const tree = inspectPathTree(cachePath);
        const ageMs = now - tree.maxMtimeMs;
        results.push({
          runner: runner.name,
          kind,
          path: cachePath,
          runnersRoot,
          ageMs,
          sizeBytes: tree.totalSizeBytes,
          reason: ageMs >= ttlMs ? "ttl" : "fresh",
        });
      }
    } catch (err) {
      if (!isAbsent(err)) fail({ runner: runner.name }, err);
    }
  }
  return results;
}

/**
 * Removes the planned npm caches (items of `scanRunnerNpmCaches`, reason `ttl`). The drop is
 * guarded against the configured runner root, not against the cache's own parent: a `.npm`
 * directory swapped for a symlink after the scan resolves outside the root and is refused
 * (journaled `runner-npm-cache-remove-failed`). The size in each item was measured before
 * the removal by the scan; returns the paths actually removed.
 */
export function pruneRunnerNpmCaches(items, journalPath) {
  const removed = [];
  for (const r of items) {
    try {
      atomicDrop(r.path, r.runnersRoot);
    } catch (err) {
      journalRecord(journalPath, { event: "runner-npm-cache-remove-failed", path: r.path, runner: r.runner, kind: r.kind, error: err.message });
      continue;
    }
    removed.push(r.path);
    journalRecord(journalPath, {
      event: "runner-npm-cache-removed",
      path: r.path,
      runner: r.runner,
      kind: r.kind,
      ageHours: Math.round(r.ageMs / HOUR_MS),
      sizeBytes: r.sizeBytes,
    });
  }
  return removed;
}

// --- Runner /tmp (OPE-12966) ---------------------------------------------------

/**
 * Newest mtime (lstat, no symlink followed) of a tree and its apparent size. Stops early when
 * something younger than `freshAfterMs` is found (the entry is fresh, the rest does not
 * matter). A directory on another filesystem than `dev` (a mount inside the entry) makes the
 * entry `crossesFs`: the removal would descend into it. `error` is set when something cannot be
 * read; the caller keeps the entry then.
 */
function newestMtimeInTree(entryPath, dev, freshAfterMs) {
  let maxMtimeMs = 0;
  let sizeBytes = 0;
  const stack = [entryPath];
  while (stack.length) {
    const current = stack.pop();
    const { st, err } = lstatSafe(current);
    if (err) {
      if (isAbsent(err)) continue; // vanished between two calls
      return { maxMtimeMs, sizeBytes, crossesFs: false, error: err };
    }
    if (st.dev !== dev) return { maxMtimeMs, sizeBytes, crossesFs: true, error: null };
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
    sizeBytes += st.size || 0;
    if (maxMtimeMs >= freshAfterMs) return { maxMtimeMs, sizeBytes, crossesFs: false, error: null };
    if (st.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(current);
      } catch (e) {
        if (isAbsent(e)) continue;
        return { maxMtimeMs, sizeBytes, crossesFs: false, error: e };
      }
      for (const n of names) stack.push(path.join(current, n));
    }
  }
  return { maxMtimeMs, sizeBytes, crossesFs: false, error: null };
}

/**
 * Top-level entries (files and directories) of `<runnersRoot>/<runner>/tmp`, the runner's
 * /tmp bind-mounted from the data disk. An entry's age is the newest mtime anywhere inside it
 * (a symlink is never followed, a directory on another filesystem keeps the entry), so an
 * entry something wrote to within `ttlHours` is `fresh`; an older one is `ttl`. A top-level
 * symlink is never listed for removal (`symlink`), `tmp` itself is never removed. Every path
 * component (`<runner>`, `tmp`) must be a real directory. Failures go to `onEvent`
 * (`runner-tmp-root-missing`, `runner-tmp-scan-failed`) and the scan goes on with the next
 * runner or entry. Each item carries `runnersRoot`, the root the removal is guarded against.
 */
export function scanRunnerTmp(runnersRoot, now, ttlHours, { onEvent = () => {} } = {}) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  const fail = (extra, err) => {
    onEvent({ event: "runner-tmp-scan-failed", root: runnersRoot, ...extra, error: err?.message || String(err) });
  };
  const rootStat = lstatSafe(runnersRoot);
  if (rootStat.err) {
    if (isAbsent(rootStat.err)) onEvent({ event: "runner-tmp-root-missing", root: runnersRoot });
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
    const tmpDirPath = path.join(runnersRoot, runner.name, "tmp");
    try {
      const { st: tmpSt, err: tmpErr } = lstatSafe(tmpDirPath);
      if (tmpErr && !isAbsent(tmpErr)) throw tmpErr;
      if (!tmpSt || !tmpSt.isDirectory()) continue;
      for (const entry of fs.readdirSync(tmpDirPath, { withFileTypes: true })) {
        const entryPath = path.join(tmpDirPath, entry.name);
        try {
          const { st, err } = lstatSafe(entryPath);
          if (err) {
            if (!isAbsent(err)) fail({ runner: runner.name, path: entryPath }, err);
            continue;
          }
          const base = { runner: runner.name, name: entry.name, path: entryPath, runnersRoot, mtimeMs: st.mtimeMs, ageMs: now - st.mtimeMs, sizeBytes: null };
          if (st.isSymbolicLink()) {
            results.push({ ...base, reason: "symlink" });
            continue;
          }
          if (st.dev !== tmpSt.dev) {
            results.push({ ...base, reason: "other-filesystem" });
            continue;
          }
          const tree = newestMtimeInTree(entryPath, tmpSt.dev, now - ttlMs);
          if (tree.error) {
            fail({ runner: runner.name, path: entryPath }, tree.error);
            results.push({ ...base, reason: "scan-failed" });
            continue;
          }
          if (tree.crossesFs) {
            results.push({ ...base, reason: "other-filesystem" });
            continue;
          }
          const ageMs = now - Math.max(tree.maxMtimeMs, st.mtimeMs);
          results.push({
            ...base,
            mtimeMs: Math.max(tree.maxMtimeMs, st.mtimeMs),
            ageMs,
            sizeBytes: tree.sizeBytes,
            reason: ageMs >= ttlMs ? "ttl" : "fresh",
          });
        } catch (err) {
          if (!isAbsent(err)) fail({ runner: runner.name, path: entryPath }, err);
        }
      }
    } catch (err) {
      if (!isAbsent(err)) fail({ runner: runner.name }, err);
    }
  }
  return results;
}

/**
 * Removes the planned runner /tmp entries (items of `scanRunnerTmp`, reason `ttl`), guarded
 * against the configured runner root like the run copies. Returns the paths actually removed.
 */
export function pruneRunnerTmp(items, journalPath) {
  const removed = [];
  for (const r of items) {
    try {
      atomicDrop(r.path, r.runnersRoot);
    } catch (err) {
      journalRecord(journalPath, { event: "runner-tmp-remove-failed", path: r.path, runner: r.runner, error: err.message });
      continue;
    }
    removed.push(r.path);
    journalRecord(journalPath, { event: "runner-tmp-removed", path: r.path, runner: r.runner, ageHours: Math.round(r.ageMs / HOUR_MS), sizeBytes: r.sizeBytes });
  }
  return removed;
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
  if (result.status !== 0) {
    // A failed run leaves a partial archive of 1-2 GB behind on every pass; remove exactly this file.
    fs.rmSync(archivePath, { force: true });
    // stderr is often empty (a killed or timed-out child), so the exit code and signal go in the text.
    throw new Error(`archive failed for ${clonePath}: exit code ${result.status}, signal ${result.signal}: ${String(result.stderr ?? "").trim()}`);
  }
  const verification = spawnSync(verify[0], verify[1], { timeout: 60000, stdio: "ignore" });
  if (verification.status !== 0) {
    fs.rmSync(archivePath, { force: true });
    throw new Error(`archive verification failed for ${archivePath}`);
  }
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

    const plan = { clones: [], caches: [], scratch: [], botData: [], runCopies: [], runnerTaskFolders: [], runnerNpmCaches: [], runnerTmp: [], runnerUnrecognized: [], kept: [], removed: [], archived: [] };

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

    // 3. Scan bot scratch directories (BOT-DISK-SCRATCH)
    const scratchDirs = [...args.scratchRoots];
    if (scratchDirs.length === 0) {
      scratchDirs.push(...discoverBotScratchDirs(root));
    }
    const openInfo = collectOpenProcInfo(args.procDir);
    for (const sDir of scratchDirs) {
      if (!fs.existsSync(sDir)) continue;
      const scratchEntries = scanScratchDirectory(sDir, now, args.scratchTtlHours, openInfo);
      for (const item of scratchEntries) {
        if (item.reason === "ttl") {
          plan.scratch.push({ ...item, action: "remove" });
        } else {
          plan.kept.push({ ...item, action: "keep", reason: item.reason });
        }
      }
    }

    // 3b. Bot data directories of decommissioned bots (OPE-12654). Every guard
    // must say go; an unreachable docker daemon or board keeps the directories
    // (fail-closed) and only the journal says why.
    const containers = listBotContainers();
    const botData = await planBotDataGc(root, { now, containers });
    if (botData.ok) {
      for (const item of botData.plan) {
        if (item.action === "remove") {
          plan.botData.push({ ...item, action: "remove" });
        } else if (item.reason === "unpushed-work") {
          // The signal the issue asks for: the board holds the bot because of
          // unpushed work — log it loudly, keep the directory.
          plan.kept.push({ path: item.path, action: "keep", reason: `bot-data:${item.reason}`, details: item.details });
          journalRecord(args.journal, { event: "bot-data-held-unpushed", path: item.path, details: item.details });
          console.error(JSON.stringify({ ok: true, held: item.path, reason: "bot-data-held-unpushed", details: item.details }));
        } else if (item.reason === "board-unavailable") {
          plan.kept.push({ path: item.path, action: "keep", reason: `bot-data:${item.reason}` });
          journalRecord(args.journal, { event: "bot-data-board-unavailable", path: item.path, details: item.details });
        } else {
          plan.kept.push({ path: item.path, action: "keep", reason: `bot-data:${item.reason}` });
        }
      }
    } else {
      journalRecord(args.journal, { event: "bot-data-gc-unavailable", reason: botData.reason });
      console.error(JSON.stringify({ ok: false, reason: `bot-data-gc-unavailable: ${botData.reason}` }));
    }

    // 3c. SSH runner run copies (OPE-12722): only when a runner root is configured.
    // A failure of one root or runner is journaled and skipped, never thrown: it must not
    // abort the clones, caches, scratch and bot-data passes of the same --apply.
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

    // 3e. npm/npx caches of runner agents (OPE-12855): only when a runner root is
    // configured, the same gate as 3c/3d. No board call: the TTL decision is purely local
    // (newest mtime in the cache tree), so a board outage cannot block cache pruning.
    for (const runnersRoot of args.runnerRoots) {
      const items = scanRunnerNpmCaches(runnersRoot, now, args.npmCacheTtlHours, {
        onEvent: (event) => journalRecord(args.journal, event),
      });
      for (const item of items) {
        if (item.reason === "ttl") plan.runnerNpmCaches.push({ ...item, action: "remove" });
        else plan.kept.push({ ...item, action: "keep", reason: "fresh" });
      }
    }

    // 3f. Runner /tmp (OPE-12966): the same gate as 3c. Entries whose newest mtime is inside
    // the TTL, symlinks and other filesystems stay; only the journal says why for the odd ones.
    for (const runnersRoot of args.runnerRoots) {
      const items = scanRunnerTmp(runnersRoot, now, args.runnerTmpTtlHours, {
        onEvent: (event) => journalRecord(args.journal, event),
      });
      for (const item of items) {
        if (item.reason === "ttl") plan.runnerTmp.push({ ...item, action: "remove" });
        else {
          if (item.reason !== "fresh") {
            journalRecord(args.journal, { event: "runner-tmp-skipped", path: item.path, runner: item.runner, reason: item.reason });
          }
          plan.kept.push({ ...item, action: "keep" });
        }
      }
    }

    // 3g. Unrecognized workspace folders of runner agents (OPE-13018): the same
    // gate as 3c. A task folder the agent named with a typo (OPR-12962 for
    // OPE-12962) never matches RUNNER_TASK_FOLDER_NAME, so 3d never sees it and
    // it would sit on the disk forever. Report-only: the entry is journaled, the
    // folder is never removed here.
    for (const runnersRoot of args.runnerRoots) {
      const items = scanRunnerUnrecognizedWorkspaceFolders(runnersRoot, now, args.cloneTtlHours, {
        onEvent: (event) => journalRecord(args.journal, event),
      });
      for (const item of items) {
        plan.runnerUnrecognized.push(item);
        if (item.reason === "unrecognized-ttl") {
          journalRecord(args.journal, {
            event: "runner-unrecognized-workspace-folder",
            path: item.path,
            runner: item.runner,
            name: item.name,
            ageHours: Math.round(item.ageMs / HOUR_MS),
          });
        }
      }
    }

    // 4. Execute or report
    if (args.dryRun) {
      journalRecord(args.journal, {
        event: "dry-run",
        clones: plan.clones.length,
        caches: plan.caches.length,
        scratch: plan.scratch.length,
        runCopies: plan.runCopies.length,
        runnerTaskFolders: plan.runnerTaskFolders.length,
        runnerNpmCaches: plan.runnerNpmCaches.length,
        runnerTmp: plan.runnerTmp.length,
        runnerUnrecognized: plan.runnerUnrecognized.length,
        kept: plan.kept.length,
      });
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
      for (const s of plan.scratch.filter((x) => x.action === "remove")) {
        try {
          atomicDrop(s.path, path.dirname(s.path));
          plan.removed.push({ path: s.path });
          journalRecord(args.journal, { event: "scratch-pruned", path: s.path, sizeBytes: s.sizeBytes });
        } catch (err) {
          journalRecord(args.journal, { event: "scratch-prune-failed", path: s.path, error: err.message });
        }
      }
      for (const b of plan.botData.filter((x) => x.action === "remove")) {
        try {
          atomicDrop(b.path, root);
          plan.removed.push({ path: b.path });
          journalRecord(args.journal, { event: "bot-data-removed", path: b.path, reason: b.reason });
          // The gate left the XFS project entries in place while the directory
          // existed (uid 65532 cannot remove them); this pass is the one that
          // clears them, best-effort (root on vm-core).
          const quota = clearBotDiskProject(b.name, { volumeRoot: root });
          if (quota.projectId !== null) {
            journalRecord(args.journal, {
              event: "bot-data-quota-cleared",
              path: b.path,
              projectId: quota.projectId,
              cleared: quota.cleared,
              reasons: quota.reasons,
            });
          }
        } catch (err) {
          journalRecord(args.journal, { event: "bot-data-remove-failed", path: b.path, error: err.message });
        }
      }
      const runCopiesGone = pruneSshRunCopies(plan.runCopies.filter((x) => x.action === "remove"), args.journal);
      for (const gone of runCopiesGone) plan.removed.push({ path: gone });
      const npmCachesGone = pruneRunnerNpmCaches(plan.runnerNpmCaches.filter((x) => x.action === "remove"), args.journal);
      for (const gone of npmCachesGone) plan.removed.push({ path: gone });
      const runnerTmpGone = pruneRunnerTmp(plan.runnerTmp, args.journal);
      for (const gone of runnerTmpGone) plan.removed.push({ path: gone });
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
      journalRecord(args.journal, {
        event: "apply-complete",
        removed: plan.removed.length,
        archived: plan.archived.length,
        scratchPruned: plan.scratch.length,
        botDataRemoved: plan.botData.length,
        runCopiesRemoved: runCopiesGone.length,
        runnerTaskFoldersRemoved,
        runnerNpmCachesRemoved: npmCachesGone.length,
        runnerTmpRemoved: runnerTmpGone.length,
        runnerUnrecognized: plan.runnerUnrecognized.length,
        kept: plan.kept.length,
      });
      console.log(JSON.stringify({
        ok: true,
        dryRun: false,
        removed: plan.removed.length,
        archived: plan.archived.length,
        scratchPruned: plan.scratch.length,
        botDataRemoved: plan.botData.length,
        runCopiesRemoved: runCopiesGone.length,
        runnerTaskFoldersRemoved,
        runnerNpmCachesRemoved: npmCachesGone.length,
        runnerTmpRemoved: runnerTmpGone.length,
        runnerUnrecognized: plan.runnerUnrecognized.length,
        kept: plan.kept.length,
      }, null, 2));
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
