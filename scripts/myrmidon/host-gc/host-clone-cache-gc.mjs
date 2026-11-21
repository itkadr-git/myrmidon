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
//   - Task clones of open tasks (in_review, blocked, backlog) with no live run, idle for
//     IDLE_OPEN_CLONE_HOURS (1 h when the bots volume has under 10% free), clean, HEAD on a
//     server tip: remove the linked worktree (idle-open-clone-removed); anything else is kept
//     (idle-open-clone-kept, with the reason)
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
//   --idle-open-hours <h> Override the idle time of an open task's clean pushed clone (default 6)
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
// Names of build and dependency dirs left out of safety-net archives (restored by an install or a
// build, OPE-13104), but only where git confirms the path is ignored: see archiveExcludes().
// A file git does not ignore (user or uncommitted work) is always archived, even inside `dist/`.
const ARCHIVE_EXCLUDES = ["node_modules", ".pnpm-store", ".turbo", "dist", ".next", "coverage"];
const SCRATCH_TTL_HOURS = 6;
// Disk pressure (partitionThresholdPercent / partitionCriticalPercent of the bots disk): above the
// first the scratch TTL drops to one hour; above the second the journal gets a disk-critical record
// for the board operator. This mode does not change the 24 h life of archives (they expire after
// 24 h in every mode, unpushed work included) and does not touch the checkouts of open tasks.
const PRESSURE_PERCENT = 85;
const CRITICAL_PERCENT = 95;
const PRESSURE_SCRATCH_TTL_HOURS = 1;
// myrmidon(1.6.9 OPE-13411): a clone of a task in in_review, blocked or backlog has no end date:
// the closed-task rule (CLONE_TTL_HOURS) never matches it. On 16.11 the bots volume (230 GB) hit
// 100% with 234 such clones of 0.5-0.6 GB each and 63 runs failed with "No space left on device".
// A clone of an open task is freed when no run is live on the issue, nothing in it changed for
// IDLE_OPEN_CLONE_HOURS, it is clean and its HEAD is on a branch the server advertises. The bot
// checks the branch out again on its next run, so the cost is one re-checkout.
// With less than LOW_FREE_PERCENT of the volume free, the idle time drops to
// LOW_FREE_IDLE_OPEN_CLONE_HOURS: the volume must not fill again before the next pass.
// Tasks in todo or in_progress are never touched: a bot is about to work, or is working, there.
const IDLE_OPEN_CLONE_HOURS = 6;
const LOW_FREE_PERCENT = 10;
const LOW_FREE_IDLE_OPEN_CLONE_HOURS = 1;
const IDLE_OPEN_STATUSES = new Set(["in_review", "blocked", "backlog"]);
// myrmidon(1.6.9 HOST-GC-OMP-RUNNER-REVIEW-COPIES): an omp runner keeps a full copy (0.7-0.9 GB) of every
// task it works on under `<runner>/workspace/OPE-<n>`, and a task of that engineer often waits in
// in_review for hours; the closed-task rule never matches it. The folder of a task in in_review, blocked
// or backlog gets the closed-task verdict (remove when clean and pushed, else archive first) when no run
// is live on the task and nothing outside `.git` changed for IDLE_OPEN_RUNNER_FOLDER_MINUTES. It does not
// wait for the clone TTL. todo and in_progress are never touched.
const IDLE_OPEN_RUNNER_FOLDER_MINUTES = 30;
// The runner container sees its own `<runner>/workspace` as /workspace.
const RUNNER_CONTAINER_ROOT = "/workspace";
// myrmidon(1.6.9 OPE-13411): a reviewer bot makes a full worktree (about 0.5 GB) for each PR it reviews,
// about one per 3 minutes per reviewer. After the review the task goes to an engineer or to done, and
// the reviewer's copy would stay (the idle rule above only matches in_review, blocked and backlog).
// (1.6.9 NO-COPIES-FOR-REVIEWERS-LEADS: a reviewer's copy is freed even while the reviewer is the
// task's assignee, which it is during the review stage; its own live run still keeps the copy.)
// (1.6.9: the rule is wider now: the copy of ANY agent that is not the task's assignee is freed, so the
// copies of leads and other non-executors go too; reviewers are such agents.)
// A reviewer's copy is freed in any task status after REVIEW_CLONE_IDLE_MINUTES, if the reviewer has
// no run of its own, the copy is clean and its HEAD is on the server.
const REVIEW_CLONE_IDLE_MINUTES = 10;
const MINUTE_MS = 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Untracked service directories that never hold work (they are rebuilt); the same names the
// archive leaves out. An untracked entry of any other name keeps the clone.
const IDLE_OPEN_JUNK_UNTRACKED = new Set([...ARCHIVE_EXCLUDES, ".helper", ".gc-archive"]);
// The bot container sees its own data directory as /bot.
const BOT_CONTAINER_ROOT = "/bot";
export function diskUsedPercent(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.blocks > 0 ? Math.round(((st.blocks - st.bfree) / st.blocks) * 1000) / 10 : null;
  } catch { return null; }
}
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
const OMP_AGENT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
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
    requestFile: process.env.HOST_GC_REQUEST_FILE || null,
    cloneTtlHours: CLONE_TTL_HOURS,
    idleOpenCloneHours: IDLE_OPEN_CLONE_HOURS,
    cacheTtlHours: CACHE_TTL_HOURS,
    scratchTtlHours: defaultScratchTtl,
    pressurePercent: Number(process.env.HOST_GC_PRESSURE_PERCENT) || PRESSURE_PERCENT,
    criticalPercent: Number(process.env.HOST_GC_CRITICAL_PERCENT) || CRITICAL_PERCENT,
    procDir: process.env.PROC_DIR || "/proc",
    runnerRoots: (process.env.HOST_GC_RUNNER_ROOTS || "").split(":").map((r) => r.trim()).filter(Boolean),
    runnerContainerPrefix: process.env.MYRMIDON_HOST_GC_OMP_RUNNER_CONTAINER_PREFIX || "myrmidon-omp-runner-",
    docker: process.env.MYRMIDON_HOST_GC_DOCKER || "docker",
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
    else if (a === "--request-file") args.requestFile = argv[++i];
    else if (a === "--clone-ttl") args.cloneTtlHours = Number(argv[++i]);
    else if (a === "--idle-open-hours") args.idleOpenCloneHours = Number(argv[++i]);
    else if (a === "--cache-ttl") args.cacheTtlHours = Number(argv[++i]);
    else if (a === "--scratch-ttl") args.scratchTtlHours = Number(argv[++i]);
    else if (a === "--pressure-percent") args.pressurePercent = Number(argv[++i]);
    else if (a === "--critical-percent") args.criticalPercent = Number(argv[++i]);
    else if (a === "--proc-dir") args.procDir = argv[++i];
    else if (a === "--runner-root") args.runnerRoots.push(argv[++i]);
    else if (a === "--run-copy-ttl") args.runCopyTtlHours = Number(argv[++i]);
    else if (a === "--npm-cache-ttl") args.npmCacheTtlHours = Number(argv[++i]);
    else if (a === "--runner-tmp-ttl") args.runnerTmpTtlHours = Number(argv[++i]);
    else if (a === "--env") i++;
    else if (a === "--help") {
      console.log("Usage: host-clone-cache-gc.mjs [--apply|--dry-run] [--root path] [--scratch-root path] [--journal path] [--lock path] [--clone-ttl h] [--idle-open-hours h] [--cache-ttl h] [--scratch-ttl h] [--proc-dir path] [--runner-root path] [--run-copy-ttl h (>= 3)] [--runner-tmp-ttl h (>= 3)] [--env path]");
      process.exit(0);
    }
  }
  if (!Number.isFinite(args.idleOpenCloneHours) || args.idleOpenCloneHours <= 0) {
    throw new UsageError(`--idle-open-hours must be a positive number (got ${args.idleOpenCloneHours})`);
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

// --- Extraordinary pass request (OPE-13419) ---------------------------------
// The board defers runs while the bot volume has less than 10% free and asks for a cleanup by
// writing one small JSON file (MYRMIDON_HOST_GC_REQUEST_FILE on the board, HOST_GC_REQUEST_FILE /
// --request-file here; a systemd .path unit starts this service when the file changes). The file
// is removed when a pass starts, before the lock is taken: a pass that is already running serves
// the request, and the next request is a new file. The request only starts a pass and puts it in
// the existing disk-pressure mode (short scratch TTL); it never widens what may be deleted.
export function consumeGcRequest(requestPath) {
  if (!requestPath) return null;
  let raw;
  try { raw = fs.readFileSync(requestPath, "utf8"); } catch { return null; }
  try { fs.unlinkSync(requestPath); } catch { /* another pass took it */ }
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { /* an unreadable request is still a request */ }
  return {
    reason: typeof parsed.reason === "string" ? parsed.reason : "unknown",
    freePercent: Number.isFinite(parsed.freePercent) ? parsed.freePercent : null,
    requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : null,
  };
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

// spawnSync's default maxBuffer is 1 MiB: a long `git status` or `ls-files` would end in ENOBUFS.
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function git(args, cwd, env) {
  return spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30000, maxBuffer: GIT_MAX_BUFFER, ...(env ? { env: { ...process.env, ...env } } : {}) });
}

// --- Server-verified "pushed" (OPE-13218) ------------------------------------
// Local refs/remotes/* only say what the last fetch saw: a branch deleted or rewritten on the
// server since then still looks pushed. A commit counts as pushed only when a tip the server
// itself advertises (`git ls-remote`) is present locally and reaches it.
// One `ls-remote` per remote URL per pass: ~100 copies of one origin ask the server once. The
// entry is what the server advertised ({ ok, shas } or { ok: false, reason }), kept in memory
// for the process only (one GC pass), so a later pass always asks again.
const REMOTE_ANSWERS = new Map();

export function resetRemoteCache() {
  REMOTE_ANSWERS.clear();
}

function remoteTimeoutSeconds() {
  return Math.min(archiveTimeoutSeconds(), 60);
}

// A remote given as a path or `file://` is a directory on this host, not a server: it can vanish
// with the copy or be a stale mirror, so it never proves anything is pushed.
// Test hook HOST_GC_TEST_ALLOW_LOCAL_REMOTES=1 treats such a remote as a server, but only inside
// a node:test process (NODE_TEST_CONTEXT) and never under --apply: a stray variable in the
// service environment must not make the real pass trust a local directory.
let applyMode = false;
function isLocalRemote(url) {
  if (process.env.HOST_GC_TEST_ALLOW_LOCAL_REMOTES === "1" && process.env.NODE_TEST_CONTEXT && !applyMode) return false;
  return /^file:/i.test(url) || /^(\/|\.{1,2}\/|~)/.test(url) || (!url.includes("://") && !url.includes(":"));
}

function askRemote(repo, name, url, env) {
  const cached = REMOTE_ANSWERS.get(url);
  if (cached) return cached;
  const timeoutS = remoteTimeoutSeconds();
  const r = spawnSync("timeout", ["--kill-after=5s", `${timeoutS}s`, "git", "ls-remote", "--heads", "--tags", name], {
    cwd: repo,
    encoding: "utf8",
    timeout: (timeoutS + 20) * 1000,
    maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
  });
  let answer;
  if (r.status !== 0) {
    const why = r.status === 124 || r.status === 137 || r.error?.code === "ETIMEDOUT" ? `timed out after ${timeoutS} s` : `exit ${r.status}: ${String(r.stderr ?? "").trim().slice(0, 200)}`;
    answer = { ok: false, reason: `ls-remote ${name}: ${why}` };
  } else {
    const shas = new Set();
    for (const line of r.stdout.split("\n")) {
      const sha = line.split("\t")[0].trim();
      if (/^[0-9a-f]{40,64}$/.test(sha)) shas.add(sha);
    }
    answer = { ok: true, shas };
  }
  REMOTE_ANSWERS.set(url, answer);
  return answer;
}

// { verified, tips, reason }: `tips` are server tips (commits and tags) that exist locally.
// `verified` is false when there is no remote, a remote is a local path, or any remote did not
// answer: nothing is then known to be on the server.
function serverTips(repo, env) {
  const listed = git(["remote"], repo, env);
  if (listed.status !== 0) return { verified: false, tips: [], reason: "remote listing failed" };
  const names = listed.stdout.split("\n").map((n) => n.trim()).filter(Boolean);
  if (!names.length) return { verified: false, tips: [], reason: "no remote" };
  const advertised = new Set();
  for (const name of names) {
    const url = git(["remote", "get-url", name], repo, env).stdout.trim() || name;
    if (isLocalRemote(url)) return { verified: false, tips: [], reason: `remote ${name} is a local path, not a server` };
    const answer = askRemote(repo, name, url, env);
    if (!answer.ok) return { verified: false, tips: [], reason: answer.reason };
    for (const sha of answer.shas) advertised.add(sha);
  }
  if (!advertised.size) return { verified: true, tips: [] };
  const checked = spawnSync("git", ["cat-file", "--batch-check=%(objecttype) %(objectname)"], {
    cwd: repo, input: `${[...advertised].join("\n")}\n`, encoding: "utf8", timeout: 30000, maxBuffer: GIT_MAX_BUFFER,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  if (checked.status !== 0) return { verified: false, tips: [], reason: "cat-file failed" };
  const tips = [];
  for (const line of checked.stdout.split("\n")) {
    const m = /^(commit|tag) ([0-9a-f]{40,64})$/.exec(line.trim());
    if (m) tips.push(m[2]);
  }
  if (tips.length > 10000) return { verified: false, tips: [], reason: "too many server refs" };
  return { verified: true, tips };
}

// { verified, pushed, tips, reason }. `pushed` needs a verified server answer and no local
// branch, tag or HEAD commit outside it.
function pushState(repo, env) {
  const server = serverTips(repo, env);
  if (!server.verified) return { verified: false, pushed: false, tips: [], reason: server.reason };
  const args = ["rev-list", "HEAD", "--branches", "--tags"];
  if (server.tips.length) args.push("--not", ...server.tips);
  const r = git(args, repo, env);
  return { verified: true, pushed: r.status === 0 && r.stdout.trim() === "", tips: server.tips };
}

function isGitWorktree(dir, env) {
  try {
    const r = git(["rev-parse", "--is-inside-work-tree"], dir, env);
    return r.status === 0 && r.stdout.trim() === "true";
  } catch { return false; }
}

// A `.git` that is empty or broken is skipped by git, which then finds the parent repository:
// such a directory is no worktree of its own.
function isOwnWorktree(dir, env) {
  try {
    const r = git(["rev-parse", "--show-toplevel"], dir, env);
    return r.status === 0 && fs.realpathSync(r.stdout.trim()) === fs.realpathSync(dir);
  } catch { return false; }
}

function isClean(dir, env) {
  try {
    const r = git(["status", "--porcelain"], dir, env);
    return r.status === 0 && r.stdout.trim() === "";
  } catch { return false; }
}

function isPushed(dir, env) {
  try {
    return pushState(dir, env).pushed;
  } catch { return false; }
}

function hasStash(dir, env) {
  try {
    const r = git(["stash", "list"], dir, env);
    return r.status === 0 && r.stdout.trim() !== "";
  } catch { return false; }
}

// `.git` is a directory in a plain clone but a file (`gitdir: <path>`) in a linked worktree or a
// submodule: the objects, and their alternates file, then live in the real gitdir (and the
// common dir behind it), so look there.
// The object stores a repo borrows from: every entry of the `objects/info/alternates` files of
// its gitdirs (a linked worktree's admin dir and the common dir behind it).
function alternateStores(dir, mapped) {
  const stores = [];
  try {
    const dotGit = path.join(dir, ".git");
    const st = fs.lstatSync(dotGit);
    const gitDirs = [];
    if (mapped) {
      // A runner worktree whose gitdir is a container path: the host paths are already resolved.
      gitDirs.push(mapped.adminDir, mapped.commonDir);
    } else if (st.isDirectory()) {
      gitDirs.push(dotGit);
    } else if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (m) gitDirs.push(path.resolve(dir, m[1].trim()));
    }
    for (const gd of [...gitDirs]) {
      try {
        const common = fs.readFileSync(path.join(gd, "commondir"), "utf8").trim();
        if (common) gitDirs.push(path.resolve(gd, common));
      } catch { /* no commondir: the gitdir is the common dir */ }
    }
    for (const gd of gitDirs) {
      let text;
      try { text = fs.readFileSync(path.join(gd, "objects", "info", "alternates"), "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        const entry = line.trim();
        if (entry && !entry.startsWith("#")) stores.push(path.resolve(gd, "objects", entry));
      }
    }
  } catch { /* unreadable: the caller treats it as no store */ }
  return stores;
}

function hasAlternates(dir, mapped) {
  return alternateStores(dir, mapped).length > 0;
}

// The bot git-bases borrow objects from the shared mirror through `objects/info/alternates`.
// When the named store exists, is readable and git still reaches HEAD through the alternates
// chain, a compact archive is safe: `git bundle create` copies the borrowed objects into the
// bundle, so the archive recovers the copy on its own. When the store is missing or git cannot
// read the objects, nothing can prove recovery: the copy stays (fail closed).
function alternatesAccessible(repo, mapped, env) {
  for (const store of alternateStores(repo, mapped)) {
    try { fs.accessSync(store, fs.constants.R_OK); } catch { return false; }
  }
  const head = git(["cat-file", "-e", "HEAD"], repo, env);
  if (head.status !== 0) return false;
  return git(["ls-tree", "--name-only", "HEAD"], repo, env).status === 0;
}

// Every directory under `top` (itself included) holding a `.git` entry, directory or file, at
// any depth and inside any directory, node_modules, dist, .next, .helper or .gc-archive among
// them. Symlinks are not followed and `.git` is not entered. `complete` is false when a
// directory could not be read or the tree is implausibly large: nothing can be proven then.
const GIT_TREE_ENTRY_LIMIT = 5_000_000;
function scanGitTree(top) {
  const roots = [];
  let complete = true;
  let seen = 0;
  const stack = [top];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      complete = false;
      continue;
    }
    seen += entries.length;
    if (seen > GIT_TREE_ENTRY_LIMIT) return { roots: roots.sort(), complete: false };
    if (entries.some((e) => e.name === ".git")) roots.push(dir);
    for (const e of entries) {
      if (e.name === ".git" || e.isSymbolicLink() || !e.isDirectory()) continue;
      stack.push(path.join(dir, e.name));
    }
  }
  return { roots: roots.sort(), complete };
}

// --- Scanning ---------------------------------------------------------------

export function scanTaskClones(root, now, ttlHours) {
  const results = [];
  const ttlMs = ttlHours * HOUR_MS;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return results; }
  // A bot clone's `.git` may name a container path (`gitdir: /bot/...`) that does not exist on
  // the host: plain `git` then rejects the clone and the closed-task rule never sees it, so
  // done/cancelled copies are never freed. Map it through the same resolver the idle and review
  // rules use (root is the bot's `workspace`, its parent the bot dir the container calls /bot).
  const agentRoot = path.basename(path.resolve(root)) === "workspace" ? path.dirname(path.resolve(root)) : null;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const fullPath = safeJoin(root, name);
    if (isSymlink(fullPath)) continue;

    const st = fs.statSync(fullPath);

    // Resolve container gitfiles before probing git: the deployed git wrapper can make the
    // unmapped probe succeed while later archive/removal still needs the host admin paths.
    const dirs = resolveWorktreeGitDirs(fullPath, agentRoot);
    const mapped = dirs.adminDir ? dirs : null;
    // Fail closed for a container pointer that cannot be mapped, even if a wrapper accepts it.
    if (!mapped && dirs.reason !== "not-a-linked-worktree") continue;
    const env = mapped ? mappedGitEnv(mapped, fullPath) : undefined;
    if (!isGitWorktree(fullPath, env)) continue;

    // A linked worktree's own HEAD and reflog live in the admin dir: the directory mtime alone
    // can sit older than the newest real change (newestCloneChangeMs, as in the idle rule).
    const mtimeMs = mapped ? newestCloneChangeMs(fullPath, mapped.adminDir) : st.mtimeMs;
    const ageMs = now - mtimeMs;
    if (ageMs < ttlMs) continue; // too fresh

    const clean = isClean(fullPath, env ?? undefined);
    // `pushed` asks the server (ls-remote): left to assessClone, which main runs only for clones the
    // board reports closed. Open tasks are never touched and need no network round trip.
    const stash = hasStash(fullPath, env ?? undefined);
    const alternates = hasAlternates(fullPath, mapped ?? undefined);

    results.push({
      name,
      path: fullPath,
      ageMs,
      mtimeMs,
      isGit: true,
      clean,
      pushed: null,
      stash,
      alternates,
      ...(mapped ? { adminDir: mapped.adminDir, commonDir: mapped.commonDir, containerPath: mapped.containerPath } : {}),
      safeToRemove: false,
      reason: "unassessed",
    });
  }
  return results;
}

// Fills in `pushed` (checked against the server) and the removal verdict of a scanned clone.
export function assessClone(c) {
  // A linked worktree's `.git` names a container path the host cannot read: the mapped env of
  // the idle/review rules. A plain clone reads fine on its own.
  const env = c.adminDir ? mappedGitEnv(c, c.path) : undefined;
  c.pushed = c.clean && !c.stash && !c.alternates ? isPushed(c.path, env) : false;
  c.safeToRemove = c.clean && c.pushed && !c.stash && !c.alternates;
  c.reason = c.safeToRemove ? "clean-pushed" : "unsafe-archive";
  return c;
}

// --- Idle clones of open tasks (OPE-13411) ----------------------------------

export async function fetchIssueOpenState(identifier, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  let base = (baseUrl || "").replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:3100";
  if (!base.endsWith("/api")) base += "/api";
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(`${base}/issues/${encodeURIComponent(identifier)}`, { headers });
    if (!response.ok) return { ok: false, reason: "board-unavailable", statusCode: response.status };
    const issue = await response.json();
    if (!issue || typeof issue.status !== "string") return { ok: false, reason: "issue-not-found" };
    // The board sets executionRunId while a run executes on the issue and checkoutRunId while a
    // run holds the checkout; both are empty otherwise. Either one means a run is live.
    return {
      ok: true,
      status: issue.status,
      assigneeAgentId: typeof issue.assigneeAgentId === "string" && issue.assigneeAgentId ? issue.assigneeAgentId : null,
      liveRunId: issue.executionRunId || issue.checkoutRunId || null,
      // Both fields apart: they may belong to different agents (the engineer's run and a reviewer's).
      liveRunIds: [issue.executionRunId, issue.checkoutRunId].filter((id, i, all) => typeof id === "string" && id && all.indexOf(id) === i),
    };
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
}

// Free share of the volume in percent, or null when it cannot be read.
export function volumeFreePercent(dir, statfs = fs.statfsSync) {
  try {
    const st = statfs(dir);
    return st.blocks > 0 ? (Number(st.bavail) / Number(st.blocks)) * 100 : null;
  } catch { return null; }
}

// The linked worktree's own gitdir (`<git-base>/worktrees/<name>`) and its common dir on the HOST.
// The `.git` file of a bot's clone says `gitdir: /bot/hermes/...`, a path inside the container, where
// /bot is `<bots root>/<agentId>`. (An omp runner's container root is /workspace = `<runner>/workspace`:
// `containerRoot` and `agentRoot` say so.) Returns { adminDir, commonDir, containerPath } or { reason }.
function resolveWorktreeGitDirs(clonePath, agentRoot, containerRoot = BOT_CONTAINER_ROOT) {
  let text;
  try {
    const st = fs.lstatSync(path.join(clonePath, ".git"));
    if (!st.isFile()) return { reason: "not-a-linked-worktree" };
    text = fs.readFileSync(path.join(clonePath, ".git"), "utf8");
  } catch { return { reason: "not-a-linked-worktree" }; }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return { reason: "not-a-linked-worktree" };
  let target = m[1].trim();
  let containerPath = false;
  if (target === containerRoot || target.startsWith(`${containerRoot}/`)) {
    if (!agentRoot) return { reason: "gitdir-unmapped" };
    target = path.resolve(agentRoot, `.${target.slice(containerRoot.length)}`);
    if (!target.startsWith(path.resolve(agentRoot) + path.sep)) return { reason: "gitdir-unmapped" };
    containerPath = true;
  } else {
    target = path.resolve(clonePath, target);
  }
  try {
    const adminDir = fs.realpathSync(target);
    // The commondir file may name the CONTAINER path of the git base (`/bot/...`), which does
    // not exist on the host. The layout below still pins the real common dir, so an
    // unresolvable commondir content falls back to it (mappedGitEnv repairs the file for the
    // git calls of this pass and restores it on exit).
    let commonDir = null;
    try {
      const common = fs.readFileSync(path.join(adminDir, "commondir"), "utf8").trim();
      if (common) commonDir = fs.realpathSync(path.resolve(adminDir, common));
    } catch { /* unresolvable commondir: the layout check pins the common dir */ }
    if (!commonDir) commonDir = fs.realpathSync(path.dirname(path.dirname(adminDir)));
    if (path.dirname(path.dirname(adminDir)) !== commonDir || path.basename(path.dirname(adminDir)) !== "worktrees") {
      return { reason: "gitdir-unexpected-layout" };
    }
    if (!fs.existsSync(path.join(adminDir, "HEAD"))) return { reason: "gitdir-missing" };
    return { adminDir, commonDir, containerPath };
  } catch { return { reason: "gitdir-missing" }; }
}

// The admin dir's `commondir` file records the CONTAINER path of the git base (`/bot/...`),
// which does not exist on the host: bundle/HEAD/objects reads die with "fatal: not a git
// repository: /bot/...". GIT_COMMON_DIR and `core.commondir` do NOT override the file (git
// 2.47, verified on the build host), and a host `/bot` symlink cannot map every agent root,
// so the first mapped git use of an admin dir repoints its commondir file at the host common
// dir for the duration of the pass and restores the original content on exit. Plain clones
// pass no env and read their own `.git` directory.
const repairedCommondirs = new Map(); // adminDir -> original commondir content
let commondirRestoreArmed = false;
function armCommondirRestore() {
  if (commondirRestoreArmed) return;
  commondirRestoreArmed = true;
  const restore = () => {
    for (const [adminDir, original] of repairedCommondirs) {
      writeAdminFileAtomic(path.join(adminDir, "commondir"), original.text, original.stat);
    }
    repairedCommondirs.clear();
  };
  process.once("exit", restore);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => { restore(); process.kill(process.pid, signal); });
}
// Atomic same-directory write that keeps the owner and mode of the file it replaces.
function writeAdminFileAtomic(file, content, stat) {
  const tmp = path.join(path.dirname(file), `.myr-gc-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode: stat.mode & 0o777 });
    try { fs.chownSync(tmp, stat.uid, stat.gid); } catch { /* best effort */ }
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function repairCommondirForHost(adminDir, commonDir) {
  const file = path.join(adminDir, "commondir");
  // Never follow a symlink or touch anything but a regular file: a bot-created symlink
  // must not redirect a root write elsewhere. Anything unusual fails closed through git.
  let st;
  try { st = fs.lstatSync(file); } catch { return; }
  if (st.isSymbolicLink() || !st.isFile()) return;
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return; }
  const target = text.trim();
  if (!target) return;
  try { if (fs.existsSync(path.resolve(adminDir, target))) return; } catch { /* unreadable: repair below */ }
  // The recorded path does not resolve on the host (a container path): point the file at the
  // host common dir for this pass. Closed clones have no live runs; the idle and review rules
  // admit a clone only when the board reports no live run on the task.
  if (!repairedCommondirs.has(adminDir)) repairedCommondirs.set(adminDir, { text, stat: st });
  armCommondirRestore();
  writeAdminFileAtomic(file, `${commonDir}\n`, st);
}

// The mapped env every git call uses for a bot or runner linked worktree.
function mappedGitEnv(dirs, workTree) {
  repairCommondirForHost(dirs.adminDir, dirs.commonDir);
  return { GIT_DIR: dirs.adminDir, GIT_WORK_TREE: workTree, GIT_COMMON_DIR: dirs.commonDir, GIT_OPTIONAL_LOCKS: "0" };
}

// Newest change time of a clone: the directory, its top-level entries and the worktree's own
// HEAD and reflog (a commit or checkout touches those).
function newestCloneChangeMs(clonePath, adminDir) {
  let newest = 0;
  const take = (p) => { try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs); } catch { /* gone */ } };
  take(clonePath);
  try {
    for (const e of fs.readdirSync(clonePath)) if (e !== ".git") take(path.join(clonePath, e));
  } catch { /* unreadable: the dirty check will keep the clone */ }
  // Not the index: any `git status` (the closed-task scan runs one on every clone) refreshes it. A staged
  // change shows up as dirty anyway.
  for (const f of ["HEAD", path.join("logs", "HEAD")]) take(path.join(adminDir, f));
  return newest;
}

function cloneSizeBytes(dir) {
  const r = spawnSync("du", ["-sk", "--", dir], { encoding: "utf8", timeout: 120000 });
  const kb = r.status === 0 ? Number(r.stdout.split(/\s/)[0]) : NaN;
  return Number.isFinite(kb) ? kb * 1024 : null;
}

// `git status --porcelain` is empty, not counting untracked service directories.
function isCleanIgnoringJunk(clonePath, env) {
  const r = git(["status", "--porcelain", "--untracked-files=normal"], clonePath, env);
  if (r.status !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const m = /^\?\? (.+?)\/?$/.exec(line);
    if (m && IDLE_OPEN_JUNK_UNTRACKED.has(m[1])) continue;
    return false;
  }
  return true;
}

// { pushed, reason }: HEAD must be reachable from a tip the server advertises (ls-remote) that is
// present locally. Nothing is fetched: what cannot be proven keeps the clone.
function headIsOnServer(clonePath, env) {
  const server = serverTips(clonePath, env);
  if (!server.verified) return { pushed: false, reason: `push-unverified: ${server.reason}` };
  if (!server.tips.length) return { pushed: false, reason: "not-pushed" };
  const r = git(["rev-list", "-n", "1", "HEAD", "--not", ...server.tips], clonePath, env);
  if (r.status !== 0) return { pushed: false, reason: "push-unverified: rev-list failed" };
  return r.stdout.trim() === "" ? { pushed: true } : { pushed: false, reason: "not-pushed" };
}

/**
 * Plans the removal of idle clones of open tasks under `root` (a bot's `workspace` directory).
 * Returns items { name, path, identifier, status, ageMs, action: "remove" | "keep", reason, ... };
 * clones of tasks the board reports closed are left to the closed-task rule and not listed.
 */
export async function scanIdleOpenClones(root, now, {
  idleHours = IDLE_OPEN_CLONE_HOURS,
  fetchState = fetchIssueOpenState,
  statfs = fs.statfsSync,
  onEvent = () => {},
} = {}) {
  const items = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { items, thresholdHours: idleHours, freePercent: null }; }
  const freePercent = volumeFreePercent(root, statfs);
  const lowSpace = freePercent !== null && freePercent < LOW_FREE_PERCENT;
  const thresholdHours = lowSpace ? Math.min(idleHours, LOW_FREE_IDLE_OPEN_CLONE_HOURS) : idleHours;
  const agentRoot = path.basename(path.resolve(root)) === "workspace" ? path.dirname(path.resolve(root)) : null;
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const identifier = issueIdentifierFromCloneName(entry.name);
    if (!/^[A-Za-z]+-\d+$/.test(identifier)) continue; // not a task clone (bot folder, .gc-archive, ...)
    const clonePath = safeJoin(root, entry.name);
    if (isSymlink(clonePath)) continue;
    const state = await fetchState(identifier);
    const base = { name: entry.name, path: clonePath, identifier, thresholdHours, lowSpace };
    const keep = (reason, extra = {}) => items.push({ ...base, ...extra, action: "keep", reason });
    if (!state.ok) { keep(state.reason); continue; }
    if (["done", "cancelled"].includes(state.status)) continue; // the closed-task rule's business
    base.status = state.status;
    if (!IDLE_OPEN_STATUSES.has(state.status)) { keep(`status-${state.status}`); continue; }
    if (state.liveRunId) { keep("live-run", { liveRunId: state.liveRunId }); continue; }
    const dirs = resolveWorktreeGitDirs(clonePath, agentRoot);
    if (!dirs.adminDir) { keep(dirs.reason); continue; }
    const ageMs = now - newestCloneChangeMs(clonePath, dirs.adminDir);
    base.ageMs = ageMs;
    if (ageMs < thresholdHours * HOUR_MS) { keep("fresh"); continue; }
    // GIT_OPTIONAL_LOCKS=0: `git status` must not rewrite the index, or every pass would make the clone look fresh.
    const env = mappedGitEnv(dirs, clonePath);
    if (!isCleanIgnoringJunk(clonePath, env)) { keep("dirty"); continue; }
    const tree = scanGitTree(clonePath);
    if (!tree.complete || !tree.roots.every((r) => r === clonePath)) { keep("nested-repo"); continue; }
    const pushed = headIsOnServer(clonePath, env);
    if (!pushed.pushed) { keep(pushed.reason); continue; }
    items.push({ ...base, ...dirs, sizeBytes: cloneSizeBytes(clonePath), action: "remove", reason: "idle-clean-pushed" });
  }
  for (const item of items) {
    if (item.action === "keep") {
      onEvent({ event: "idle-open-clone-kept", path: item.path, identifier: item.identifier, status: item.status, reason: item.reason, ageHours: item.ageMs === undefined ? undefined : Math.round(item.ageMs / HOUR_MS) });
    }
  }
  return { items, thresholdHours, freePercent };
}

// Removes a planned worktree clone and exactly its own admin dir; returns how it was done.
function removeWorktreeClone(c, root) {
  let via;
  // `git worktree remove` finds the worktree by the path in the admin dir's `gitdir` file; when that
  // is a container path (/bot/...) it does not match on the host: the copy and exactly its own admin
  // dir are removed instead. No `git worktree prune`: it would also drop the admin dirs of other
  // tasks of this git-base, whose container paths do not exist on the host either.
  const registered = (() => {
    try { return fs.realpathSync(path.dirname(fs.readFileSync(path.join(c.adminDir, "gitdir"), "utf8").trim())) === fs.realpathSync(c.path); } catch { return false; }
  })();
  if (registered) {
    const r = spawnSync("git", ["--git-dir", c.commonDir, "worktree", "remove", "--force", c.path], { encoding: "utf8", timeout: 600000 });
    if (r.status !== 0) throw new Error(`git worktree remove: ${String(r.stderr).trim().slice(0, 300)}`);
    via = "git-worktree-remove";
    if (fs.existsSync(c.path)) atomicDrop(c.path, root);
  } else {
    atomicDrop(c.path, root);
    const worktrees = path.join(c.commonDir, "worktrees");
    if (path.dirname(c.adminDir) !== worktrees) throw new Error(`unexpected admin dir ${c.adminDir}`);
    fs.rmSync(c.adminDir, { recursive: true, force: true });
    via = "rm-and-admin-dir";
  }
  return via;
}

/**
 * Removes the planned idle clones. Just before the removal the board is asked again (a run may have
 * started since the scan). Returns the paths removed.
 */
export async function pruneIdleOpenClones(items, root, journalPath, { fetchState = fetchIssueOpenState, now = Date.now } = {}) {
  const removed = [];
  for (const c of items.filter((x) => x.action === "remove")) {
    try {
      const state = await fetchState(c.identifier);
      if (!state.ok || !IDLE_OPEN_STATUSES.has(state.status) || state.liveRunId) {
        journalRecord(journalPath, { event: "idle-open-clone-kept", path: c.path, identifier: c.identifier, status: state.status ?? c.status, reason: state.ok ? (state.liveRunId ? "live-run" : `status-${state.status}`) : state.reason });
        continue;
      }
      if (newestCloneChangeMs(c.path, c.adminDir) > now() - c.thresholdHours * HOUR_MS) {
        journalRecord(journalPath, { event: "idle-open-clone-kept", path: c.path, identifier: c.identifier, status: state.status, reason: "fresh" });
        continue;
      }
      const sizeBytes = c.sizeBytes ?? null;
      const ageHours = Math.round(c.ageMs / HOUR_MS);
      const via = removeWorktreeClone(c, root);
      removed.push(c.path);
      journalRecord(journalPath, { event: "idle-open-clone-removed", path: c.path, identifier: c.identifier, status: c.status, sizeBytes, ageHours, thresholdHours: c.thresholdHours, lowSpace: c.lowSpace, via });
    } catch (err) {
      journalRecord(journalPath, { event: "idle-open-clone-remove-failed", path: c.path, identifier: c.identifier, error: err.message });
    }
  }
  return removed;
}

// --- Copies of reviewer bots (OPE-13411) ------------------------------------

function boardApiBase(baseUrl) {
  let base = (baseUrl || "").replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:3100";
  if (!base.endsWith("/api")) base += "/api";
  return base;
}

/**
 * The board's agent of a bot folder: `<bots root>/<key>` where the key is the agent id (UUID) or the
 * agent name. Returns { ok, id, name, role } or { ok: false, reason }; { ok: true, id: null } when the
 * board has no such agent.
 */
export async function fetchBotAgent(key, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const base = boardApiBase(baseUrl);
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const pick = (a) => ({ ok: true, id: a.id, name: typeof a.name === "string" ? a.name : null, role: typeof a.role === "string" ? a.role : null });
  try {
    if (UUID_PATTERN.test(key)) {
      const response = await fetchImpl(`${base}/agents/${encodeURIComponent(key)}`, { headers });
      if (response.status === 404) return { ok: true, id: null };
      if (!response.ok) return { ok: false, reason: `board-http-${response.status}` };
      const agent = await response.json();
      return agent && typeof agent.id === "string" ? pick(agent) : { ok: false, reason: "board-invalid-agent" };
    }
    const companyId = process.env.MYRMIDON_COMPANY_ID || process.env.PAPERCLIP_COMPANY_ID;
    if (!companyId) return { ok: false, reason: "company-id-missing" };
    const response = await fetchImpl(`${base}/companies/${encodeURIComponent(companyId)}/agents?q=${encodeURIComponent(key)}`, { headers });
    if (!response.ok) return { ok: false, reason: `board-http-${response.status}` };
    const list = await response.json();
    if (!Array.isArray(list)) return { ok: false, reason: "board-invalid-agent-list" };
    const agent = list.find((a) => a?.name === key || a?.id === key);
    return agent && typeof agent.id === "string" ? pick(agent) : { ok: true, id: null };
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
}

// Owner of a run: GET /heartbeat-runs/<id> carries `agentId`.
export async function fetchRunAgentId(runId, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(`${boardApiBase(baseUrl)}/heartbeat-runs/${encodeURIComponent(runId)}`, { headers });
    if (!response.ok) return { ok: false, reason: `board-http-${response.status}` };
    const run = await response.json();
    return typeof run?.agentId === "string" ? { ok: true, agentId: run.agentId } : { ok: false, reason: "board-invalid-run" };
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
}

// A reviewer is an agent whose role says so or, as the board has no reviewer role (AGENT_ROLES), whose
// name has the `-review-` part (adm-dev-review-10). An unknown agent is not a reviewer: nothing is freed.
export function isReviewerAgent(agent) {
  if (!agent?.ok || !agent.id) return false;
  return agent.role === "reviewer" || /-review-/.test(agent.name || "");
}

// Does the reviewer have a run of its own on the task? A run of another agent (the engineer's
// executionRunId/checkoutRunId) does not use the reviewer's copy. A run whose owner is unknown
// counts as the reviewer's: nothing is freed on a guess.
async function reviewerRunLive(state, agentId, fetchRun) {
  const ids = state.liveRunIds ?? (state.liveRunId ? [state.liveRunId] : []);
  for (const runId of ids) {
    const run = await fetchRun(runId);
    if (!run.ok || run.agentId === agentId) return runId;
  }
  return null;
}

/**
 * Plans the removal of the copies of a bot under `root` (the bot's `workspace` directory) of tasks
 * where the bot is NOT the current assignee (reviewers, leads), in any task status. The assignee's own
 * copy is kept (the idle-open and closed rules handle it), a task without an assignee is kept
 * (conservative). Unknown agent or board does not answer: no items. Items are as in
 * scanIdleOpenClones, with action "remove" | "keep".
 */
export async function scanReviewerClones(root, now, {
  idleMinutes = REVIEW_CLONE_IDLE_MINUTES,
  fetchState = fetchIssueOpenState,
  fetchAgent = fetchBotAgent,
  fetchRun = fetchRunAgentId,
  onEvent = () => {},
} = {}) {
  const items = [];
  if (path.basename(path.resolve(root)) !== "workspace") return { items, agent: null };
  const agentRoot = path.dirname(path.resolve(root));
  const agent = await fetchAgent(path.basename(agentRoot));
  if (!agent?.ok || !agent.id) return { items, agent };
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { items, agent }; }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const identifier = issueIdentifierFromCloneName(entry.name);
    if (!/^[A-Za-z]+-\d+$/.test(identifier)) continue;
    const clonePath = safeJoin(root, entry.name);
    if (isSymlink(clonePath)) continue;
    const base = { name: entry.name, path: clonePath, identifier, agentId: agent.id, thresholdMinutes: idleMinutes };
    const keep = (reason, extra = {}) => items.push({ ...base, ...extra, action: "keep", reason });
    const state = await fetchState(identifier);
    if (!state.ok) { keep(state.reason); continue; }
    base.status = state.status;
    if (!state.assigneeAgentId) { keep("no-assignee"); continue; }
    // A reviewer is the assignee during the review stage: its copy is freed all the same.
    if (state.assigneeAgentId === agent.id && !isReviewerAgent(agent)) { keep("assignee"); continue; }
    const live = await reviewerRunLive(state, agent.id, fetchRun);
    if (live) { keep("live-run", { liveRunId: live }); continue; }
    const dirs = resolveWorktreeGitDirs(clonePath, agentRoot);
    if (!dirs.adminDir) { keep(dirs.reason); continue; }
    const ageMs = now - newestCloneChangeMs(clonePath, dirs.adminDir);
    base.ageMs = ageMs;
    if (ageMs < idleMinutes * MINUTE_MS) { keep("fresh"); continue; }
    const env = mappedGitEnv(dirs, clonePath);
    // Clean means `git status` is empty, as for the idle rule (untracked service directories are junk).
    if (!isCleanIgnoringJunk(clonePath, env)) { keep("dirty"); continue; }
    const tree = scanGitTree(clonePath);
    if (!tree.complete || !tree.roots.every((r) => r === clonePath)) { keep("nested-repo"); continue; }
    const pushed = headIsOnServer(clonePath, env);
    if (!pushed.pushed) { keep(pushed.reason); continue; }
    items.push({ ...base, ...dirs, sizeBytes: cloneSizeBytes(clonePath), action: "remove", reason: "nonassignee-copy-idle", reviewer: isReviewerAgent(agent) });
  }
  for (const item of items) {
    if (item.action === "keep") {
      onEvent({ event: "review-clone-kept", path: item.path, identifier: item.identifier, status: item.status, reason: item.reason, ageMinutes: item.ageMs === undefined ? undefined : Math.round(item.ageMs / MINUTE_MS) });
    }
  }
  return { items, agent };
}

/**
 * Removes the planned reviewer copies. Just before the removal the board is asked again: a run of the
 * reviewer may have started, and the copy must still be untouched.
 */
export async function pruneReviewerClones(items, root, journalPath, {
  fetchState = fetchIssueOpenState,
  fetchRun = fetchRunAgentId,
  now = Date.now,
} = {}) {
  const removed = [];
  for (const c of items.filter((x) => x.action === "remove")) {
    const kept = (status, reason) => journalRecord(journalPath, { event: "review-clone-kept", path: c.path, identifier: c.identifier, status, reason });
    try {
      if (!fs.existsSync(c.path)) { kept(c.status, "already-gone"); continue; }
      const state = await fetchState(c.identifier);
      if (!state.ok) { kept(c.status, state.reason); continue; }
      if (!state.assigneeAgentId) { kept(state.status, "no-assignee"); continue; }
      if (state.assigneeAgentId === c.agentId && !c.reviewer) { kept(state.status, "assignee"); continue; }
      if (await reviewerRunLive(state, c.agentId, fetchRun)) { kept(state.status, "live-run"); continue; }
      if (newestCloneChangeMs(c.path, c.adminDir) > now() - c.thresholdMinutes * MINUTE_MS) { kept(state.status, "fresh"); continue; }
      const sizeBytes = c.sizeBytes ?? null;
      const via = removeWorktreeClone(c, root);
      removed.push(c.path);
      journalRecord(journalPath, { event: "review-clone-removed", reason: c.reason, reviewer: c.reviewer, path: c.path, identifier: c.identifier, status: state.status, sizeBytes, ageMinutes: Math.round(c.ageMs / MINUTE_MS), thresholdMinutes: c.thresholdMinutes, via });
    } catch (err) {
      journalRecord(journalPath, { event: "review-clone-remove-failed", path: c.path, identifier: c.identifier, error: err.message });
    }
  }
  return removed;
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

// A linked worktree of a runner whose `.git` file names a path inside the runner container
// (`gitdir: /workspace/...`). Returns { adminDir, commonDir, env } when the path maps to a git
// directory under the runner's host `workspace` and has the expected layout; { reason } when it is
// such a worktree but the host cannot read it (the run copy that held the repository is gone);
// null for any other layout (a plain clone, a worktree git reads by itself).
function mapRunnerContainerWorktree(dir, runnerWorkspace) {
  if (!runnerWorkspace) return null;
  let text;
  try {
    const st = fs.lstatSync(path.join(dir, ".git"));
    if (!st.isFile()) return null;
    text = fs.readFileSync(path.join(dir, ".git"), "utf8");
  } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const target = m[1].trim();
  if (target !== RUNNER_CONTAINER_ROOT && !target.startsWith(`${RUNNER_CONTAINER_ROOT}/`)) return null;
  const dirs = resolveWorktreeGitDirs(dir, runnerWorkspace, RUNNER_CONTAINER_ROOT);
  if (!dirs.adminDir) return { reason: dirs.reason };
  return { ...dirs, env: mappedGitEnv(dirs, dir) };
}

// Newest change time (ms) of a task folder outside `.git`: the folder, its top-level entries and
// those of each repository folder inside, plus the HEAD and reflog of its git directory (a commit or
// a checkout touches those). The index is left out: any `git status` refreshes it.
function newestRunnerFolderChangeMs(folder, gitDirs, runnerWorkspace) {
  let newest = 0;
  const take = (p) => { try { newest = Math.max(newest, fs.lstatSync(p).mtimeMs); } catch { /* gone */ } };
  take(folder);
  for (const dir of new Set([folder, ...gitDirs])) {
    take(dir);
    try {
      for (const e of fs.readdirSync(dir)) if (e !== ".git") take(path.join(dir, e));
    } catch { /* unreadable: the git checks keep or archive the folder */ }
    const mapped = mapRunnerContainerWorktree(dir, runnerWorkspace);
    const adminDir = mapped?.adminDir ?? path.join(dir, ".git");
    if (mapped && !mapped.adminDir) continue;
    for (const f of ["HEAD", path.join("logs", "HEAD")]) take(path.join(adminDir, f));
  }
  return newest;
}

// Verdict for one folder: `remove` (every git repo inside is clean and fully pushed), or
// `archive-remove` (unpushed work, or a git state the host cannot read — the archive keeps
// what the host could not inspect). The board status is checked first.
//
// done/cancelled: the verdict follows from the git state alone. in_review, blocked and backlog
// (IDLE_OPEN_STATUSES): the same verdict, but only when no run is live on the task and nothing outside
// `.git` changed for IDLE_OPEN_RUNNER_FOLDER_MINUTES; otherwise `keep`. Any other status (todo,
// in_progress, ...) keeps the folder. `options.now` is the time of the pass, `options.runnerWorkspace`
// the host path the runner container sees as /workspace.
function judgeRunnerTaskFolder(folder, boardStatus, { now = Date.now(), runnerWorkspace = null, idleMinutes = IDLE_OPEN_RUNNER_FOLDER_MINUTES } = {}) {
  let idleOpen = false;
  if (boardStatus !== undefined) {
    if (!boardStatus.ok) {
      return { action: "keep", reason: `board-unavailable${boardStatus.statusCode ? `-${boardStatus.statusCode}` : ""}` };
    }
    if (IDLE_OPEN_STATUSES.has(boardStatus.status)) {
      idleOpen = true;
      const liveRunIds = boardStatus.liveRunIds ?? (boardStatus.liveRunId ? [boardStatus.liveRunId] : []);
      if (liveRunIds.length > 0) return { action: "keep", reason: "live-run" };
    } else if (!["done", "cancelled"].includes(boardStatus.status)) {
      return { action: "keep", reason: `issue-status:${boardStatus.status}` };
    }
  }
  const gitDirs = runnerFolderGitDirs(folder);
  if (gitDirs === null) return { action: "archive-remove", reason: "unreadable-folder", idleOpen };
  if (idleOpen && now - newestRunnerFolderChangeMs(folder, gitDirs, runnerWorkspace) < idleMinutes * MINUTE_MS) {
    return { action: "keep", reason: "fresh" };
  }
  const out = (verdict) => ({ ...verdict, idleOpen });
  // Independent of the depth-limited list above: a `.git` anywhere (skipped directories too) that
  // the list lacks sends the folder to the archive pass, which saves or keeps it.
  const tree = scanGitTree(folder);
  const listed = new Set(gitDirs);
  if (!tree.complete || tree.roots.some((r) => !listed.has(r))) return out({ action: "archive-remove", reason: "unlisted-git-repository" });
  if (gitDirs.length === 0) return out({ action: "remove", reason: "no-git-repos" });
  for (const dir of gitDirs) {
    const mapped = mapRunnerContainerWorktree(dir, runnerWorkspace);
    // A container gitdir the host cannot map (its run copy is gone) proves nothing: archive.
    if (mapped && !mapped.adminDir) return out({ action: "archive-remove", reason: "unsafe-archive" });
    const env = mapped?.env;
    if (!isGitWorktree(dir, env) || !isClean(dir, env) || !isPushed(dir, env) || hasStash(dir, env) || hasAlternates(dir, mapped)) {
      return out({ action: "archive-remove", reason: "unsafe-archive" });
    }
  }
  return out({ action: "remove", reason: "clean-pushed" });
}

/**
 * Before the removal of a folder planned under the idle-open rule: the board is asked again (a run
 * or a move to todo/in_progress may have come since the scan) and the folder must still be idle.
 * Returns the reason to keep the folder, or null.
 */
export async function runnerFolderKeepReason(item, now, { fetchStatus = fetchIssueOpenState, idleMinutes = IDLE_OPEN_RUNNER_FOLDER_MINUTES } = {}) {
  if (!item.idleOpen) return null;
  const state = await fetchStatus(item.identifier);
  if (!state.ok) return `board-unavailable${state.statusCode ? `-${state.statusCode}` : ""}`;
  if (!IDLE_OPEN_STATUSES.has(state.status)) return `issue-status:${state.status}`;
  const liveRunIds = state.liveRunIds ?? (state.liveRunId ? [state.liveRunId] : []);
  if (liveRunIds.length > 0) return "live-run";
  const gitDirs = runnerFolderGitDirs(item.path);
  if (gitDirs === null) return "unreadable-folder";
  if (now - newestRunnerFolderChangeMs(item.path, gitDirs, item.runnerWorkspace) < idleMinutes * MINUTE_MS) return "fresh";
  return null;
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
export async function scanRunnerTaskFolders(runnersRoot, now, ttlHours, { onEvent = () => {}, fetchStatus = fetchIssueOpenState, idleOpenMinutes = IDLE_OPEN_RUNNER_FOLDER_MINUTES } = {}) {
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
        // A closed task's folder waits for the clone TTL; a folder of a task in in_review, blocked or
        // backlog is judged after idleOpenMinutes (the verdict itself keeps any other status).
        const oldEnough = now - st.mtimeMs >= ttlMs;
        if ((oldEnough || now - st.mtimeMs >= idleOpenMinutes * MINUTE_MS) && item.identifier) {
          try {
            const runnerWorkspace = path.join(runnersRoot, runner.name, "workspace");
            const board = await fetchStatus(item.identifier);
            if (oldEnough || (board.ok && IDLE_OPEN_STATUSES.has(board.status))) {
              const verdict = judgeRunnerTaskFolder(folder, board, { now, runnerWorkspace, idleMinutes: idleOpenMinutes });
              item.action = verdict.action;
              item.reason = verdict.reason;
              if (verdict.idleOpen) {
                item.idleOpen = true;
                item.runnerWorkspace = runnerWorkspace;
                item.status = board.status;
              }
            }
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

// Scratch can hold a task checkout, not just disposable temporary files. Never
// reclaim a tree containing git metadata or one that cannot be inspected safely.
function scratchTreeIsDisposable(target, device) {
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let st;
    try { st = fs.lstatSync(current); } catch { return false; }
    if (st.dev !== device || st.isSymbolicLink()) return false;
    if (!st.isDirectory()) continue;
    let entries;
    try { entries = fs.readdirSync(current); } catch { return false; }
    if (entries.includes(".git")) return false;
    for (const entry of entries) stack.push(path.join(current, entry));
  }
  return true;
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
      let device;
      try { device = fs.lstatSync(scratchDir).dev; } catch { device = null; }
      if (device === null || !scratchTreeIsDisposable(fullPath, device)) {
        results.push({ name: entry.name, path: fullPath, reason: "unsafe-scratch-tree", sizeBytes: totalSizeBytes, ageMs });
        continue;
      }
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
    let scratchDir = path.join(botsRoot, entry.name);
    let safe = true;
    for (const part of ["hermes", "cache", "scratch"]) {
      scratchDir = path.join(scratchDir, part);
      const { st } = lstatSafe(scratchDir);
      if (!st?.isDirectory()) { safe = false; break; }
    }
    if (safe) dirs.push(scratchDir);
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

export function listOmpRunnerContainers({ docker = "docker", timeoutMs = DOCKER_TIMEOUT_MS, namePrefix = "myrmidon-omp-runner-" } = {}) {
  const res = spawnSync(docker, ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8", timeout: timeoutMs });
  if (res.error || res.status !== 0) return { ok: false, reason: res.error?.code === "ENOENT" ? "docker-unavailable" : "docker-failed" };
  const names = [];
  for (const line of (res.stdout || "").split("\n")) {
    const name = line.trim();
    if (name.startsWith(namePrefix) && OMP_AGENT_KEY_PATTERN.test(name.slice(namePrefix.length))) names.push(name);
  }
  return { ok: true, names };
}

export async function fetchAgentAdapter(agentId, {
  baseUrl = process.env.BOARD_API_URL || process.env.PAPERCLIP_API_URL || process.env.MYRMIDON_API_URL || "http://127.0.0.1:3100",
  apiKey = process.env.PAPERCLIP_API_KEY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!OMP_AGENT_KEY_PATTERN.test(agentId)) return { ok: false, reason: "bad-agent-id" };
  let base = (baseUrl || "").replace(/\/$/, "");
  if (!base) base = "http://127.0.0.1:3100";
  if (!base.endsWith("/api")) base += "/api";
  if (typeof fetchImpl !== "function") return { ok: false, reason: "board-unavailable" };
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    // Runner names use engN, while GET /agents/{id} accepts only UUIDs. Resolve
    // the canonical company agent name through the company-scoped list route.
    const companyId = process.env.MYRMIDON_COMPANY_ID || process.env.PAPERCLIP_COMPANY_ID;
    if (!companyId) return { ok: false, reason: "company-id-missing" };
    const number = /^eng(\d+)$/.exec(agentId)?.[1];
    if (!number) return { ok: false, reason: "bad-agent-id" };
    const response = await fetchImpl(`${base}/companies/${encodeURIComponent(companyId)}/agents?q=${encodeURIComponent(`adm-dev-eng-${number}`)}`, { headers });
    if (!response.ok) return { ok: false, reason: `board-http-${response.status}`, statusCode: response.status };
    const body = await response.json();
    if (!Array.isArray(body)) return { ok: false, reason: "board-invalid-agent-list" };
    const agent = body.find((entry) => entry?.name === `adm-dev-eng-${number}`);
    if (!agent) return { ok: true, adapterType: null };
    // adapterType is part of AgentListItem; do not make a second detail request.
    if (typeof agent.id !== "string" || typeof agent.adapterType !== "string") {
      return { ok: false, reason: "board-invalid-agent-list" };
    }
    return { ok: true, adapterType: agent.adapterType };
  } catch {
    return { ok: false, reason: "board-unavailable" };
  }
}

export async function planStaleOmpRunners(runnersRoot, {
  docker = "docker",
  namePrefix = "myrmidon-omp-runner-",
  fetchAdapter = fetchAgentAdapter,
} = {}) {
  const containers = listOmpRunnerContainers({ docker, namePrefix });
  if (!containers.ok) return { ok: false, reason: containers.reason, plan: [] };
  const plan = [];
  const activeKeys = new Set();
  for (const name of containers.names) {
    const agentKey = name.slice(namePrefix.length);
    activeKeys.add(agentKey);
    const runnerPath = path.join(runnersRoot, agentKey);
    const adapter = await fetchAdapter(agentKey);
    if (!adapter.ok) plan.push({ name, agentKey, path: runnerPath, action: "keep", reason: adapter.reason });
    else if (adapter.adapterType === "omp_local") plan.push({ name, agentKey, path: runnerPath, action: "keep", reason: "omp-local" });
    else plan.push({ name, agentKey, path: runnerPath, runnersRoot, action: "stop-remove", reason: adapter.adapterType ? "adapter-changed" : "agent-deleted" });
  }
  try {
    for (const agentKey of fs.readdirSync(runnersRoot)) {
      if (activeKeys.has(agentKey) || !OMP_AGENT_KEY_PATTERN.test(agentKey)) continue;
      const adapter = await fetchAdapter(agentKey);
      if (adapter.ok && adapter.adapterType !== "omp_local") plan.push({ name: `${namePrefix}${agentKey}`, agentKey, path: path.join(runnersRoot, agentKey), runnersRoot, action: "remove-stale-home", reason: adapter.adapterType ? "adapter-changed" : "agent-deleted" });
      else plan.push({ agentKey, path: path.join(runnersRoot, agentKey), action: "keep", reason: adapter.ok ? "omp-local" : adapter.reason });
    }
  } catch (err) {
    return { ok: false, reason: err.code === "ENOENT" ? "runner-root-missing" : "runner-root-unreadable", plan };
  }
  return { ok: true, plan };
}

export function stopOmpRunner(name, { docker = "docker", timeoutMs = DOCKER_TIMEOUT_MS } = {}) {
  const res = spawnSync(docker, ["rm", "-f", name], { encoding: "utf8", timeout: timeoutMs });
  return !res.error && res.status === 0;
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
  if (!OMP_AGENT_KEY_PATTERN.test(agentId)) return { ok: false, reason: "bad-agent-id" };
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
  const validStatuses = new Set(["active", "paused", "idle", "running", "error", "pending_approval", "terminated"]);
  if (!validStatuses.has(body.status) || !body.adapterType.trim()) return { ok: false, reason: "board-unavailable" };
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

// --- Board project workspace cleanup ----------------------------------------

// Conservative across container mount namespaces: any live git blocks pack cleanup.
export function boardGitActive(procDir = "/proc") {
  let pids;
  try { pids = fs.readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch { return true; }
  for (const pid of pids) {
    try {
      if (/^git(?:$|-)/.test(fs.readFileSync(path.join(procDir, pid, "comm"), "utf8").trim())) return true;
    } catch (err) { if (!isAbsent(err)) return true; }
  }
  return false;
}

async function fetchBoardProjectIssue(identifier) {
  try {
    const base = boardApiBase(process.env.BOARD_API_URL || process.env.MYRMIDON_API_URL || process.env.PAPERCLIP_API_URL);
    const key = process.env.MYRMIDON_API_KEY || process.env.PAPERCLIP_API_KEY;
    const response = await fetch(`${base}/issues/${encodeURIComponent(identifier)}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return { ok: false };
    const issue = await response.json();
    return { ok: true, status: issue.status, closedAt: issue.status === "done" ? issue.completedAt : issue.cancelledAt, liveRunId: issue.executionRunId || issue.checkoutRunId };
  } catch { return { ok: false }; }
}

async function assessBoardProjectItem(item, now, { fetchState = fetchBoardProjectIssue, gitActive = boardGitActive } = {}) {
  const { path: target, kind, identifier } = item;
  const st = lstatSafe(target).st;
  if (!st || (kind === "pack" ? !st.isFile() : !st.isDirectory())) return null;
  const result = { ...item, action: "keep", reason: "fresh" };
  const tree = newestMtimeInTree(target, st.dev, now - DAY_MS);
  if (tree.error || tree.crossesFs) result.reason = "unsafe-tree";
  else if (tree.maxMtimeMs >= now - DAY_MS) result.reason = "fresh";
  else if (kind === "pack" && gitActive()) result.reason = "live-git";
  else if (kind === "scratch") {
    const state = await fetchState(identifier);
    const closed = Date.parse(state?.closedAt);
    if (!state?.ok || !["done", "cancelled"].includes(state.status) || state.liveRunId || !Number.isFinite(closed) || now - closed <= DAY_MS) result.reason = "issue-not-old-closed";
    else {
      // Retain every nonempty scratch until all unpublished and ignored data can be verified.
      const safe = fs.readdirSync(target).length === 0;
      if (safe) { result.action = "remove"; result.reason = "ttl"; }
      else result.reason = "unpublished-or-unknown-work";
    }
  } else { result.action = "remove"; result.reason = "ttl"; }
  return result;
}

export async function scanBoardProjectWorkspaces(home, now, { fetchState = fetchBoardProjectIssue, gitActive = boardGitActive, onEvent = () => {} } = {}) {
  const items = [];
  if (!home) return items;
  const projects = path.join(home, "instances", "default", "projects");
  const dirs = (dir) => {
    try {
      if (!fs.lstatSync(dir).isDirectory()) return [];
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
    } catch (err) { if (!isAbsent(err)) onEvent({ event: "board-project-scan-failed", path: dir, error: err.message }); return []; }
  };
  let component = path.resolve(home);
  for (const part of [null, "instances", "default", "projects"]) {
    if (part) component = path.join(component, part);
    if (!lstatSafe(component).st?.isDirectory()) return items;
  }
  const add = async (repo, target, kind, identifier) => {
    const item = await assessBoardProjectItem({ path: target, root: projects, repo, kind, identifier }, now, { fetchState, gitActive });
    if (item) items.push(item);
  };
  for (const company of dirs(projects)) for (const project of dirs(company)) for (const repo of dirs(project)) {
    const packDir = path.join(repo, ".git", "objects", "pack");
    if ([".git", ".git/objects", ".git/objects/pack"].every((p) => lstatSafe(path.join(repo, p)).st?.isDirectory())) {
      try { for (const e of fs.readdirSync(packDir, { withFileTypes: true })) if (e.isFile() && /^tmp_(?:pack|idx)_/.test(e.name)) await add(repo, path.join(packDir, e.name), "pack"); }
      catch (err) { onEvent({ event: "board-project-scan-failed", path: packDir, error: err.message }); }
    }
    for (const folder of dirs(path.join(repo, ".scratch"))) {
      const match = /^ope-?(\d+)(?:-wt)?$/i.exec(path.basename(folder));
      if (match) await add(repo, folder, "scratch", `OPE-${match[1]}`);
    }
    if (lstatSafe(path.join(repo, ".paperclip")).st?.isDirectory()) await add(repo, path.join(repo, ".paperclip", "pnpm-store"), "store");
  }
  return items;
}

export async function pruneBoardProjectWorkspaces(items, journal, options = {}) {
  for (const item of items.filter((x) => x.action === "remove")) {
    try {
      const root = path.resolve(item.root);
      const relative = path.relative(root, item.path);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("unsafe target");
      let ancestor = root;
      for (const part of path.dirname(relative).split(path.sep)) {
        if (!lstatSafe(ancestor).st?.isDirectory()) throw new Error("unsafe ancestor");
        ancestor = path.join(ancestor, part);
      }
      if (!lstatSafe(ancestor).st?.isDirectory()) throw new Error("unsafe ancestor");
      const current = await assessBoardProjectItem(item, Date.now(), options);
      if (!current || current.action !== "remove") { journalRecord(journal, { event: "board-project-kept", path: item.path, reason: current?.reason || "gone-or-unsafe" }); continue; }
      if (item.kind === "scratch") fs.rmdirSync(item.path);
      else atomicDrop(item.path, item.root);
      journalRecord(journal, { event: "board-project-removed", path: item.path, kind: item.kind, identifier: item.identifier });
    } catch (err) { journalRecord(journal, { event: "board-project-remove-failed", path: item.path, error: err.message }); }
  }
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
// Treat unreadable trees as unsafe; symlinks are not followed by the removal path.
function runnerTmpContainsGit(root) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return true; }
    for (const entry of entries) {
      if (entry.name === ".git") return true;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return false;
}

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
          if (ageMs >= ttlMs && st.isDirectory() && runnerTmpContainsGit(entryPath)) {
            results.push({ ...base, ageMs, sizeBytes: tree.sizeBytes, reason: "unsafe-git-tree" });
            continue;
          }
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

// Git repos inside a clone: the clone itself and every nested one (`.git` directory or file) at
// any depth, skipped directories included (a repository inside node_modules is still one).
function archiveRepos(clonePath) {
  return scanGitTree(clonePath).roots;
}

// tar `--exclude` arguments: exact member paths (`<clone name>/<path>`) that git reports as ignored
// and whose last segment is in ARCHIVE_EXCLUDES. A git failure or a non-repo gives no excludes:
// the archive is whole, the safe default.
function archiveExcludes(clonePath, env) {
  const name = path.basename(clonePath);
  const out = new Set();
  const allRepos = archiveRepos(clonePath);
  for (const repo of allRepos) {
    let r;
    try {
      // The clone's own root may be a mapped linked worktree (its `.git` names a container
      // path): only the mapped env reads it. Nested repos are plain and read on their own.
      r = git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], repo, repo === clonePath ? env : undefined);
    } catch {
      continue;
    }
    if (r.status !== 0 || typeof r.stdout !== "string") continue;
    const repoRel = path.relative(clonePath, repo);
    for (const entry of r.stdout.split("\0")) {
      const rel = entry.replace(/\/+$/, "");
      if (!rel || !ARCHIVE_EXCLUDES.includes(rel.split("/").pop())) continue;
      // Never leave out a directory that holds a repository: its work is only safe inside the archive.
      const abs = path.join(repo, rel);
      if (allRepos.some((other) => other === abs || other.startsWith(`${abs}${path.sep}`))) continue;
      out.add(`--exclude=${[name, repoRel, rel].filter(Boolean).join("/")}`);
    }
  }
  return [...out];
}

// Per-archive limit, 10 min by default. The test hook is the env var (finite, > 0).
function archiveTimeoutSeconds() {
  const envTimeoutS = Number(process.env.HOST_GC_ARCHIVE_TIMEOUT_SECONDS);
  return Number.isFinite(envTimeoutS) && envTimeoutS > 0 ? envTimeoutS : 600;
}

// Runs one tool of the archive under `timeout`, so a hang kills the whole process tree and a
// failure is reported in words (stderr is often empty for a killed child).
// 124 = `timeout` fired; 137 = it had to KILL the child after --kill-after.
function runArchiveTool(cmd, args, what, extra = {}) {
  const timeoutS = archiveTimeoutSeconds();
  const result = spawnSync("timeout", ["--kill-after=10s", `${timeoutS}s`, cmd, ...args], { timeout: (timeoutS + 30) * 1000, maxBuffer: 1024 * 1024 * 1024, ...extra });
  if (result.status !== 0) {
    const timedOut = result.error?.code === "ETIMEDOUT" || result.status === 124 || result.status === 137;
    const reason = timedOut
      ? `timed out after ${timeoutS} s`
      : `exit code ${result.status}, signal ${result.signal}${result.error ? `, error ${result.error.message}` : ""}`;
    throw new Error(`${what} failed: ${reason}: ${String(result.stderr ?? "").trim()}`);
  }
  return result;
}

// Why a checkout cannot be archived compactly (bundle + patches). `{ keep: true }` means no
// safe archive of any kind exists (a full copy would lack the borrowed objects): the checkout
// stays. Otherwise the reason is journaled and the previous full archive is used.
function compactBlocker(clonePath, repos, envFor = () => undefined, mappedFor = () => undefined) {
  if (!repos.length) return { reason: "no-git-repository" };
  for (const repo of repos) {
    if (hasAlternates(repo, mappedFor(repo)) && !alternatesAccessible(repo, mappedFor(repo), envFor(repo))) {
      return { keep: true, reason: `alternate-objects inaccessible: ${repo}` };
    }
  }
  for (const repo of repos) {
    if (!isOwnWorktree(repo, envFor(repo))) {
      // The full archive leaves out git-ignored build and dependency directories: a broken
      // repository inside one would be lost with the copy. Keep the copy then.
      const skipped = path.relative(clonePath, repo).split(path.sep).some((seg) => ARCHIVE_EXCLUDES.includes(seg) || BOT_SCAN_SKIP_NAMES.has(seg));
      return skipped ? { keep: true, reason: `unusable-repository in a skipped directory: ${repo}` } : { reason: `unusable-repository: ${repo}` };
    }
  }
  // Files outside every git root (bundle and patches cannot carry them). `repos` holds every
  // `.git` found at any depth (scanGitTree), so a root is never mistaken for plain files.
  const roots = new Set(repos);
  const hasFiles = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    return entries.some((e) => (e.isDirectory() && !e.isSymbolicLink() ? hasFiles(path.join(dir, e.name)) : true));
  };
  const outside = (dir) => {
    if (roots.has(dir)) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return true; }
    const hasRepoBelow = repos.some((r) => r.startsWith(`${dir}${path.sep}`));
    if (!hasRepoBelow) return hasFiles(dir);
    return entries.some((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) return outside(p);
      return true;
    });
  };
  if (outside(clonePath)) return { reason: "files-outside-git" };
  return null;
}

// Compact recovery of one git root into `dest`: unpublished commits (git bundle), staged and
// unstaged changes (patches), untracked files. Returns the member names written (empty when
// everything is already on the remote).
function compactRepo(repo, dest, nestedRepos, journalPath, clonePath, env) {
  fs.mkdirSync(dest, { recursive: true });
  // A mapped linked worktree's `.git` names a container path: every git call needs the mapped
  // env, exactly as the scan and assessment use it.
  const toolEnv = env ? { ...process.env, ...env } : undefined;
  const members = [];
  const stashes = git(["stash", "list", "--format=%H"], repo, env);
  if (stashes.status !== 0) throw new Error(`stash listing failed: ${stashes.stderr}`);
  const stashCount = stashes.stdout.trim().split("\n").filter(Boolean).length;
  if (stashCount > 1) throw new Error("multiple stash entries require reflog preservation; keeping checkout");
  const state = pushState(repo, env);
  if (!state.verified && journalPath) {
    journalRecord(journalPath, { event: "remote-unverified", path: repo, clone: clonePath, reason: state.reason });
  }
  if (!state.pushed || stashCount) {
    const bundle = path.join(dest, "unpublished.bundle");
    // A bundle includes stashes as well as unpublished branches and tags. Only commits the server
    // itself advertised (and that exist here) are left out; without a verified answer nothing is.
    const exclude = state.verified && state.tips.length ? ["--not", ...state.tips] : [];
    runArchiveTool("git", ["-C", repo, "bundle", "create", bundle, "HEAD", "--all", ...exclude], "bundle creation", { env: toolEnv });
    runArchiveTool("git", ["-C", repo, "bundle", "verify", bundle], "bundle verification", { env: toolEnv });
    members.push("unpublished.bundle");
  }
  // Patches are bytes: the diff goes straight to the file, nothing is decoded or buffered.
  for (const [name, diffArgs] of [
    ["staged.patch", ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]],
    ["changes.patch", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--"]],
  ]) {
    const file = path.join(dest, name);
    const fd = fs.openSync(file, "w");
    try {
      runArchiveTool("git", ["-C", repo, ...diffArgs], `${name} diff`, { stdio: ["ignore", fd, "pipe"], env: toolEnv });
    } finally {
      fs.closeSync(fd);
    }
    if (fs.statSync(file).size > 0) members.push(name);
    else fs.rmSync(file, { force: true });
  }
  const listed = runArchiveTool("git", ["-C", repo, "ls-files", "--others", "--exclude-standard", "-z"], "untracked listing", { env: toolEnv });
  // A nested repository is archived by its own pass; the parent lists it as one directory. Names are
  // handled as latin1 so non-UTF-8 bytes survive the round trip to tar unchanged.
  const nestedRel = nestedRepos.map((r) => Buffer.from(path.relative(repo, r), "utf8").toString("latin1"));
  const untracked = Buffer.from(listed.stdout).toString("latin1").split("\0").filter((entry) => {
    if (!entry) return false;
    const clean = entry.replace(/\/+$/, "");
    return !nestedRel.some((n) => clean === n || clean.startsWith(`${n}/`));
  });
  if (untracked.length) {
    runArchiveTool("tar", ["-cf", path.join(dest, "untracked.tar"), "-C", repo, "--null", "-T", "-"], "untracked archive", { input: Buffer.from(`${untracked.join("\0")}\0`, "latin1") });
    members.push("untracked.tar");
  }
  return members;
}

// Archives only what could be lost: per git root (the checkout itself and repositories inside
// it) unpublished commits, uncommitted changes and untracked files. Returns the archive path,
// or null when everything is already pushed (nothing worth keeping). Where a compact archive is
// impossible the previous full archive is made and the reason journaled; a checkout whose Git
// state cannot be recovered by either way stays in place (throws).
function archiveClone(clonePath, archiveRoot, journalPath, mapped = null) {
  const tree = scanGitTree(clonePath);
  // A directory that cannot be read may hide a repository: nothing can be proven, keep the copy.
  if (!tree.complete) throw new Error(`cannot safely archive ${clonePath}: unreadable or oversized tree; keeping checkout`);
  const repos = tree.roots;
  // A mapped linked worktree's `.git` names a container path the host cannot read: the blocker,
  // the compact recovery and the exclude checks need the same mapped env as the scan.
  const env = mapped ? mappedGitEnv(mapped, clonePath) : undefined;
  const envFor = (repo) => (mapped && repo === clonePath ? env : undefined);
  const mappedFor = (repo) => (mapped && repo === clonePath ? mapped : undefined);
  const blocker = compactBlocker(clonePath, repos, envFor, mappedFor);
  if (blocker?.keep) throw new Error(`cannot safely archive ${clonePath}: ${blocker.reason}; keeping checkout`);
  if (blocker) {
    // The full archive leaves out git-ignored build and dependency directories. A repository inside
    // one is not archived on its own here, so its unpushed work would go with the copy: keep it.
    const hidden = repos.find((r) => r !== clonePath && path.relative(clonePath, r).split(path.sep).some((seg) => ARCHIVE_EXCLUDES.includes(seg) || BOT_SCAN_SKIP_NAMES.has(seg)));
    if (hidden) throw new Error(`cannot safely archive ${clonePath}: repository in a skipped directory (${hidden}) cannot go into the full archive; keeping checkout`);
    if (journalPath) journalRecord(journalPath, { event: "archive-full-fallback", path: clonePath, reason: blocker.reason });
    return archiveCloneFull(clonePath, archiveRoot, env);
  }
  const stage = fs.mkdtempSync(path.join(fs.existsSync(archiveRoot) ? archiveRoot : (fs.mkdirSync(archiveRoot, { recursive: true }), archiveRoot), ".bundle-"));
  const archivePath = path.join(archiveRoot, `${path.basename(clonePath)}-${crypto.randomUUID()}.tar.gz`);
  try {
    const manifest = [];
    for (const repo of repos) {
      const rel = path.relative(clonePath, repo);
      const nested = repos.filter((r) => r !== repo && r.startsWith(`${repo}${path.sep}`));
      // The checkout's own repository keeps flat member names; inner ones go under repos/<path>.
      const members = compactRepo(repo, rel ? path.join(stage, "repos", rel) : stage, nested, journalPath, clonePath, envFor(repo));
      if (members.length) manifest.push({ path: rel || ".", members });
    }
    if (!manifest.length) {
      fs.rmSync(archivePath, { force: true });
      return null;
    }
    fs.writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify({ clone: path.basename(clonePath), repos: manifest }, null, 2)}\n`);
    runArchiveTool("tar", ["-czf", archivePath, "-C", stage, "."], `archive for ${clonePath}`);
    runArchiveTool("tar", ["-tzf", archivePath], `archive verification for ${archivePath}`, { stdio: "ignore" });
    return archivePath;
  } catch (err) {
    fs.rmSync(archivePath, { force: true });
    throw err;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Previous full archive (the whole checkout, minus git-ignored build output). Used only where the
// compact archive is impossible; archiveClone journals why.
function archiveCloneFull(clonePath, archiveRoot, env) {
  if (!fs.existsSync(archiveRoot)) fs.mkdirSync(archiveRoot, { recursive: true });
  const name = path.basename(clonePath);
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-").slice(0, 15);
  const hasZstd = spawnSync("zstd", ["--version"], { stdio: "ignore" }).status === 0;
  const extension = hasZstd ? "tar.zst" : "tar.gz";
  const archivePath = path.join(archiveRoot, `${name}-${ts}.${extension}`);
  // What an install or a build recreates is not worth archiving: a 13 GB task folder (three
  // repo copies with node_modules) never fit the timeout, an archive without it is ~0.5 GB.
  // Only build and dependency dirs that git reports as ignored are left out, as exact paths
  // (--anchored, --no-wildcards: a name with `*` or `[` matches literally, nowhere else).
  // Unpushed commits (.git), working files and anything git does not ignore stay in.
  const excludes = ["--no-wildcards", "--anchored", ...archiveExcludes(clonePath, env)];
  // Per-archive limit, 10 min by default. The test hook is the env var (finite, > 0).
  const envTimeoutS = Number(process.env.HOST_GC_ARCHIVE_TIMEOUT_SECONDS);
  const timeoutS = Number.isFinite(envTimeoutS) && envTimeoutS > 0 ? envTimeoutS : 600;
  // `timeout` kills the whole pipeline (tar and zstd included) when the time is up, so no orphan keeps
  // writing into a file we delete; spawnSync's own limit is only a backstop for `timeout` itself.
  const limit = ["--kill-after=10s", `${timeoutS}s`];
  const spawnOpts = { timeout: (timeoutS + 30) * 1000 };
  let result;
  let verify;
  if (hasZstd) {
    // Prefer zstd, but do not make archival depend on an optional host binary.
    // pipefail: a failing tar must not be masked by zstd's exit code. Paths go in as arguments, not into the script text.
    result = spawnSync("timeout", [...limit, "bash", "-c", `set -o pipefail; tar -cf - "\${@:4}" -C "$1" "$2" | zstd -q -o "$3"`, "archive", path.dirname(clonePath), name, archivePath, ...excludes], spawnOpts);
    verify = ["bash", ["-c", `zstd -q -d -c "${archivePath}" | tar -tf - > /dev/null`]];
  } else {
    result = spawnSync("timeout", [...limit, "tar", "-czf", archivePath, ...excludes, "-C", path.dirname(clonePath), name], spawnOpts);
    verify = ["tar", ["-tzf", archivePath]];
  }
  if (result.status !== 0) {
    // A failed run leaves a partial archive of 1-2 GB behind on every pass; remove exactly this file.
    fs.rmSync(archivePath, { force: true });
    // stderr is often empty (a killed or timed-out child), so say why in words.
    // 124 = `timeout` fired; 137 = it had to KILL the pipeline after --kill-after.
    const timedOut = result.error?.code === "ETIMEDOUT" || result.status === 124 || result.status === 137;
    const reason = timedOut
      ? `timed out after ${timeoutS} s`
      : `exit code ${result.status}, signal ${result.signal}${result.error ? `, error ${result.error.message}` : ""}`;
    throw new Error(`archive failed for ${clonePath}: ${reason}: ${String(result.stderr ?? "").trim()}`);
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
  applyMode = !args.dryRun;
  if (applyMode && process.env.HOST_GC_TEST_ALLOW_LOCAL_REMOTES !== undefined) {
    journalRecord(args.journal, { event: "test-hook-ignored", level: "warn", variable: "HOST_GC_TEST_ALLOW_LOCAL_REMOTES", reason: "ignored under --apply" });
  }

  const gcRequest = applyMode ? consumeGcRequest(args.requestFile) : null;
  if (gcRequest) journalRecord(args.journal, { event: "gc-request", ...gcRequest });

  const lock = acquireLock(args.lock);
  if (!lock.ok) {
    console.error(JSON.stringify({ ok: false, reason: lock.reason }));
    process.exit(1);
  }

  try {
    const root = args.root || "/srv/myrmidon-bots";
    const cloneTtlMs = args.cloneTtlHours * HOUR_MS;
    const cacheTtlMs = args.cacheTtlHours * HOUR_MS;
    const usedPercent = diskUsedPercent(root);
    if (gcRequest && (usedPercent === null || usedPercent < args.pressurePercent)) {
      args.scratchTtlHours = Math.min(args.scratchTtlHours, PRESSURE_SCRATCH_TTL_HOURS);
    }
    if (usedPercent !== null && usedPercent >= args.pressurePercent) {
      args.scratchTtlHours = Math.min(args.scratchTtlHours, PRESSURE_SCRATCH_TTL_HOURS);
      journalRecord(args.journal, { event: "disk-pressure", usedPercent, thresholdPercent: args.pressurePercent, scratchTtlHours: args.scratchTtlHours });
      if (usedPercent >= args.criticalPercent) {
        journalRecord(args.journal, { event: "disk-critical", usedPercent, thresholdPercent: args.criticalPercent });
      }
    }

    const plan = { clones: [], caches: [], scratch: [], botData: [], runCopies: [], staleOmpRunners: [], runnerTaskFolders: [], runnerNpmCaches: [], runnerTmp: [], runnerUnrecognized: [], idleOpenClones: [], reviewClones: [], kept: [], removed: [], archived: [], boardProjects: [] };

    const boardHome = process.env.PAPERCLIP_HOME || process.env.MYRMIDON_HOME;
    if (!boardHome) journalRecord(args.journal, { event: "board-project-home-missing", reason: "PAPERCLIP_HOME is not configured on the host" });
    plan.boardProjects = await scanBoardProjectWorkspaces(boardHome, now, {
      gitActive: () => boardGitActive(args.procDir),
      onEvent: (event) => journalRecord(args.journal, event),
    });

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
      assessClone(c);
      // A nested repository may be ignored by its parent and contain unpublished work:
      // archiveClone handles every git root of the clone on its own.
      // The walk covers every depth and every skipped directory: an unseen `.git` means no plain removal.
      const tree = c.safeToRemove ? scanGitTree(c.path) : null;
      if (tree && tree.complete && tree.roots.every((repo) => repo === c.path)) {
        plan.clones.push({ ...c, action: "remove" });
      } else {
        plan.clones.push({ ...c, action: "archive-remove" });
      }
    }

    // 1b. Idle clones of open tasks (OPE-13411): in_review, blocked and backlog clones have no end
    // date; free the clean pushed ones with no live run. Kept ones are journaled with the reason.
    {
      const idle = await scanIdleOpenClones(root, now, {
        idleHours: args.idleOpenCloneHours,
        onEvent: (event) => journalRecord(args.journal, event),
      });
      if (idle.freePercent !== null && idle.freePercent < LOW_FREE_PERCENT) {
        journalRecord(args.journal, { event: "disk-low-free", freePercent: Math.round(idle.freePercent * 10) / 10, thresholdPercent: LOW_FREE_PERCENT, idleOpenCloneHours: idle.thresholdHours });
      }
      for (const item of idle.items) {
        if (item.action === "remove") {
          plan.idleOpenClones.push(item);
          if (args.dryRun) journalRecord(args.journal, { event: "idle-open-clone-would-remove", path: item.path, identifier: item.identifier, status: item.status, sizeBytes: item.sizeBytes, ageHours: Math.round(item.ageMs / HOUR_MS), thresholdHours: item.thresholdHours });
        } else {
          plan.kept.push({ path: item.path, action: "keep", reason: `idle-open:${item.reason}` });
        }
      }
    }

    // 1c. Copies of bots that are not the task's assignee (leads, reviewers; OPE-13411): any task status,
    // 10 minutes idle, no run of the bot itself.
    {
      const planned = new Set([...plan.clones.map((c) => c.path), ...plan.idleOpenClones.map((c) => c.path)]);
      const review = await scanReviewerClones(root, now, { onEvent: (event) => journalRecord(args.journal, event) });
      for (const item of review.items) {
        if (planned.has(item.path)) continue; // another rule frees it already
        if (item.action === "remove") {
          plan.reviewClones.push(item);
          if (args.dryRun) journalRecord(args.journal, { event: "review-clone-would-remove", path: item.path, identifier: item.identifier, status: item.status, sizeBytes: item.sizeBytes, ageMinutes: Math.round(item.ageMs / MINUTE_MS) });
        }
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
      // The deployed wrapper invokes GC separately for each bot's workspace.
      if (path.basename(path.resolve(root)) === "workspace" && lstatSafe(root).st?.isDirectory()) {
        const botDir = path.dirname(path.resolve(root));
        scratchDirs.push(...discoverBotScratchDirs(path.dirname(botDir)).filter((dir) =>
          path.dirname(path.dirname(path.dirname(dir))) === botDir));
      }
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
        } else {
          plan.kept.push({ path: item.path, action: "keep", reason: `bot-data:${item.reason}` });
        }
      }
    } else {
      journalRecord(args.journal, { event: "bot-data-gc-unavailable", reason: botData.reason });
      console.error(JSON.stringify({ ok: false, reason: `bot-data-gc-unavailable: ${botData.reason}` }));
    }

    if (args.runnerRoots.length > 0) {
      for (const runnersRoot of args.runnerRoots) {
        const stale = await planStaleOmpRunners(runnersRoot, {
          docker: args.docker,
          namePrefix: args.runnerContainerPrefix,
          fetchAdapter: (agentId) => fetchAgentAdapter(agentId),
        });
        if (!stale.ok) {
          journalRecord(args.journal, { event: "stale-omp-runner-scan-unavailable", reason: stale.reason, root: runnersRoot });
          console.error(JSON.stringify({ ok: false, event: "stale-omp-runner-scan-unavailable", reason: stale.reason, root: runnersRoot }));
          continue;
        }
        for (const item of stale.plan) {
          if (item.action === "keep") {
            plan.kept.push(item);
            journalRecord(args.journal, { event: "stale-omp-runner-kept", name: item.name, reason: item.reason });
          } else {
            plan.staleOmpRunners.push(item);
          }
        }
      }
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

    // Expire only regular archive files under the configured GC roots; never follow links.
    plan.expiredArchives = [];
    plan.archiveBytes = 0;
    for (const archiveRoot of new Set([root, ...args.runnerRoots].map((r) => path.join(r, ".gc-archive")))) {
      let entries;
      try {
        if (!fs.lstatSync(archiveRoot).isDirectory()) continue;
        entries = fs.readdirSync(archiveRoot, { withFileTypes: true });
      } catch (err) {
        if (!isAbsent(err)) journalRecord(args.journal, { event: "archive-scan-failed", path: archiveRoot, error: err.message });
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(?:tar\.gz|tar\.zst)$/.test(entry.name)) continue;
        const archive = path.join(archiveRoot, entry.name);
        try {
          const st = fs.lstatSync(archive);
          if (st.isFile()) {
            plan.archiveBytes += st.size;
            if (now - st.mtimeMs >= DAY_MS) plan.expiredArchives.push({ path: archive, root: archiveRoot });
          }
        } catch (err) {
          if (!isAbsent(err)) journalRecord(args.journal, { event: "archive-scan-failed", path: archive, error: err.message });
        }
      }
    }

    // 4. Execute or report
    if (args.dryRun) {
      journalRecord(args.journal, {
        event: "dry-run",
        archiveBytes: plan.archiveBytes,
        clones: plan.clones.length,
        idleOpenClones: plan.idleOpenClones.length,
        reviewClones: plan.reviewClones.length,
        caches: plan.caches.length,
        scratch: plan.scratch.length,
        staleOmpRunners: plan.staleOmpRunners.length,
        runCopies: plan.runCopies.length,
        runnerTaskFolders: plan.runnerTaskFolders.length,
        runnerNpmCaches: plan.runnerNpmCaches.length,
        runnerTmp: plan.runnerTmp.length,
        runnerUnrecognized: plan.runnerUnrecognized.length,
        kept: plan.kept.length,
      });
      console.log(JSON.stringify({ ok: true, dryRun: true, plan }, null, 2));
    } else {
      await pruneBoardProjectWorkspaces(plan.boardProjects, args.journal, { gitActive: () => boardGitActive(args.procDir) });
      let staleOmpRunnersStopped = 0;
      for (const archive of plan.expiredArchives) {
        try {
          const st = fs.lstatSync(archive.path);
          if (!st.isFile() || now - st.mtimeMs < DAY_MS) continue;
          atomicDrop(archive.path, archive.root);
          journalRecord(args.journal, { event: "archive-expired", path: archive.path, sizeBytes: st.size });
        } catch (err) {
          if (!isAbsent(err)) journalRecord(args.journal, { event: "archive-expire-failed", path: archive.path, error: err.message });
        }
      }
      // Apply: process archives first, then removals
      const archiveRoot = path.join(root, ".gc-archive");
      for (const c of plan.clones.filter((x) => x.action === "archive-remove")) {
        try {
          const archivePath = archiveClone(c.path, archiveRoot, args.journal, c.adminDir ? { adminDir: c.adminDir, commonDir: c.commonDir } : null);
          // A mapped linked worktree also leaves its own admin dir under the git-base: the drop
          // frees the copy and exactly that admin dir (removeWorktreeClone), never the common dir.
          const drop = () => (c.adminDir ? removeWorktreeClone(c, root) : atomicDrop(c.path, root));
          if (!archivePath) {
            // Everything is pushed (every git root): nothing to keep.
            drop();
            plan.removed.push({ path: c.path });
            journalRecord(args.journal, { event: "clone-removed", path: c.path, reason: "all-pushed" });
            continue;
          }
          journalRecord(args.journal, { event: "clone-archived", path: c.path, archive: archivePath, sizeBytes: c.sizeBytes });
          drop();
          plan.archived.push({ path: c.path, archive: archivePath });
          journalRecord(args.journal, { event: "clone-removed-after-archive", path: c.path, archive: archivePath });
        } catch (err) {
          journalRecord(args.journal, { event: "clone-archive-failed", path: c.path, error: err.message });
        }
      }
      for (const c of plan.clones.filter((x) => x.action === "remove")) {
        try {
          // A mapped linked worktree also leaves its own admin dir under the git-base: freeing
          // only the checkout would strand it (removeWorktreeClone drops exactly it).
          if (c.adminDir) removeWorktreeClone(c, root);
          else atomicDrop(c.path, root);
          plan.removed.push({ path: c.path });
          journalRecord(args.journal, { event: "clone-removed", path: c.path, reason: c.reason });
        } catch (err) {
          journalRecord(args.journal, { event: "clone-remove-failed", path: c.path, error: err.message });
        }
      }
      const idleOpenGone = await pruneIdleOpenClones(plan.idleOpenClones, root, args.journal);
      for (const gone of idleOpenGone) plan.removed.push({ path: gone });
      const reviewGone = await pruneReviewerClones(plan.reviewClones, root, args.journal);
      for (const gone of reviewGone) plan.removed.push({ path: gone });
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
      staleOmpRunnersStopped = 0;
      let staleOmpRunnerDataRemoved = 0;
      for (const runner of plan.staleOmpRunners) {
        if (runner.action === "stop-remove") {
          if (!stopOmpRunner(runner.name, { docker: args.docker })) {
            journalRecord(args.journal, { event: "stale-omp-runner-stop-failed", name: runner.name, reason: runner.reason });
            continue;
          }
          staleOmpRunnersStopped++;
          journalRecord(args.journal, { event: "stale-omp-runner-stopped", name: runner.name, reason: runner.reason });
        }
        for (const child of ["workspace", "home", "tmp", "scratch"]) {
          const target = path.join(runner.path, child);
          try {
            if (!fs.existsSync(target)) continue;
            atomicDrop(target, runner.runnersRoot);
            staleOmpRunnerDataRemoved++;
            journalRecord(args.journal, { event: "stale-omp-runner-data-removed", name: runner.name, path: target });
          } catch (err) {
            journalRecord(args.journal, { event: "stale-omp-runner-data-remove-failed", name: runner.name, path: target, error: err.message });
          }
        }
        if (!["workspace", "home", "tmp", "scratch"].some((child) => fs.existsSync(path.join(runner.path, child)))) {
          try {
            atomicDrop(runner.path, runner.runnersRoot);
            journalRecord(args.journal, { event: "stale-omp-runner-root-removed", name: runner.name, path: runner.path });
          } catch (err) {
            journalRecord(args.journal, { event: "stale-omp-runner-root-remove-failed", name: runner.name, path: runner.path, error: err.message });
          }
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
      // A folder of a task under review (idle-open rule) is judged again just before it goes: the board
      // is asked once more and the folder must still be idle.
      const stillIdle = async (f) => {
        const why = await runnerFolderKeepReason(f, Date.now());
        if (why) journalRecord(args.journal, { event: "runner-task-folder-skipped", path: f.path, identifier: f.identifier, runner: f.runner, reason: why });
        return !why;
      };
      for (const f of plan.runnerTaskFolders.filter((x) => x.action === "archive-remove")) {
        try {
          if (!(await stillIdle(f))) continue;
          const archivePath = archiveClone(f.path, path.join(f.runnersRoot, ".gc-archive"), args.journal);
          if (!archivePath) {
            atomicDrop(f.path, f.runnersRoot);
            plan.removed.push({ path: f.path });
            journalRecord(args.journal, { event: "runner-task-folder-removed", path: f.path, reason: "all-pushed", runner: f.runner, ageHours: Math.round(f.ageMs / HOUR_MS) });
            runnerTaskFoldersRemoved++;
            continue;
          }
          journalRecord(args.journal, { event: "runner-task-folder-archived", path: f.path, archive: archivePath, reason: f.reason, ...(f.idleOpen ? { idleOpenStatus: f.status } : {}) });
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
          if (!(await stillIdle(f))) continue;
          atomicDrop(f.path, f.runnersRoot);
          plan.removed.push({ path: f.path });
          journalRecord(args.journal, { event: "runner-task-folder-removed", path: f.path, reason: f.reason, runner: f.runner, ageHours: Math.round(f.ageMs / HOUR_MS), ...(f.idleOpen ? { idleOpenStatus: f.status } : {}) });
          runnerTaskFoldersRemoved++;
        } catch (err) {
          journalRecord(args.journal, { event: "runner-task-folder-remove-failed", path: f.path, error: err.message });
        }
      }
      journalRecord(args.journal, {
        event: "apply-complete",
        archiveBytesBeforeCleanup: plan.archiveBytes,
        removed: plan.removed.length,
        idleOpenClonesRemoved: idleOpenGone.length,
        reviewClonesRemoved: reviewGone.length,
        archived: plan.archived.length,
        scratchPruned: plan.scratch.length,
        botDataRemoved: plan.botData.length,
        staleOmpRunnersStopped,
        staleOmpRunnerDataRemoved,
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
        archiveBytesBeforeCleanup: plan.archiveBytes,
        removed: plan.removed.length,
        idleOpenClonesRemoved: idleOpenGone.length,
        reviewClonesRemoved: reviewGone.length,
        archived: plan.archived.length,
        scratchPruned: plan.scratch.length,
        botDataRemoved: plan.botData.length,
        staleOmpRunnersStopped,
        staleOmpRunnerDataRemoved,
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
