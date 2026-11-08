"use strict";
// myrmidon(1.6.5 BOT-DISK-H2c): inventory of the bot's working copies and
// class-D bases — the single function behind `myr-ws list` (lib/list.js) and
// the copies/bases sections of the botd disk report (wsDiskReportSchema).
// Field names, classes and the nullability of clean/pushed follow the H0
// interface contract (packages/shared/src/myrmidon-bot-workspace.ts):
//   list entry  — {key, path, class, repo?, branch?, openedAt, clean, pushed}
//   report copy — that plus {sizeBytes, ageSec}; a registry entry whose
//                 directory is gone reports {missing: true, clean: null,
//                 pushed: null} (in-contract fields stay null; `missing` is
//                 the marker the contract's wsReportCopySchema tolerates via
//                 unknown keys).
// State root is MYRMIDON_WS_HOME (tests) or /data/hermes/.myrmidon; workspace
// and scratch roots are the C1 constants. Everything here is local: git
// worktree list / status / log against the copy and its base, never network.

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MYRMIDON_HOME_DEFAULT = "/data/hermes/.myrmidon";
const WS_WORKSPACE_ROOT = "/workspace";
const WS_SCRATCH_ROOT = "/scratch";
const WS_TASK_BRANCH_PREFIX = "bot/";

/** Realpath when the path exists, else the path as given (dedupe key helper). */
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve the layout roots; MYRMIDON_WS_HOME overrides the state root (tests). */
function wsLayout(env = process.env) {
  const home = env.MYRMIDON_WS_HOME || MYRMIDON_HOME_DEFAULT;
  return {
    home,
    registryPath: path.join(home, "ws-registry.json"),
    gitBaseDir: path.join(home, "git-base"),
    // Test-only root overrides next to MYRMIDON_WS_HOME; production keeps the
    // C1 absolute container paths.
    workspaceRoot: env.MYRMIDON_WS_WORKSPACE_ROOT || WS_WORKSPACE_ROOT,
    scratchRoot: env.MYRMIDON_WS_SCRATCH_ROOT || WS_SCRATCH_ROOT,
  };
}

/** Read ws-registry.json; a missing or malformed file is an empty registry. */
function readRegistry(registryPath) {
  let raw;
  try {
    raw = fs.readFileSync(registryPath, "utf8");
  } catch {
    return { version: 1, entries: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
      return { version: 1, entries: parsed.entries.filter((e) => e && typeof e.path === "string" && e.key) };
    }
  } catch {
    /* fall through */
  }
  return { version: 1, entries: [] };
}

/** True when the directory is a git copy: a plain clone (.git dir) or a worktree (.git file). */
function isGitCopy(dir) {
  try {
    const st = fs.lstatSync(path.join(dir, ".git"));
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

/**
 * git with a network kill-switch and the bot's own HOME stripped of config
 * surprises. `git -C <dir>` fails (throws) when the directory is gone.
 */
function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(dir, args) {
  try {
    return git(dir, args);
  } catch {
    return null;
  }
}

/**
 * clean: `git status --porcelain` empty. Untracked files count as dirty — the
 * close path decides whether untracked work is worth archiving, so list must
 * not hide it.
 */
function isClean(dir) {
  const out = tryGit(dir, ["status", "--porcelain"]);
  if (out === null) return null;
  return out.length === 0;
}

/**
 * pushed: every commit of the copy's branch is reachable from some
 * refs/remotes/origin/* ref — i.e. `git branch -r --contains <head>` is
 * non-empty (equivalently `git cherry` finds no '+'). A detached HEAD or a
 * branch nobody fetched yet answers false; a copy without commits answers
 * true (nothing to lose).
 */
function isPushed(dir, branch) {
  const head = tryGit(dir, ["rev-parse", "--verify", "HEAD"]);
  if (!head) return true; // unborn branch: no commit, nothing unpushed
  const containing = tryGit(dir, ["branch", "-r", "--contains", "HEAD", "--format=%(refname)"]);
  if (containing === null) return null;
  const refs = containing.split("\n").map((l) => l.trim()).filter(Boolean);
  if (refs.length > 0) return true;
  if (branch) {
    // A branch the base never fetched (no remote ref under any name) cannot be
    // pushed either — but keep the reachable-check answer authoritative.
    return false;
  }
  return false;
}

/** Current branch of the copy, or null when detached. */
function headBranch(dir) {
  const b = tryGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return b || null;
}

/**
 * Visible size estimate (bytes) of a directory — the contract calls this the
 * "видимый, как оценка" size, not the XFS-quota physics. Implemented as a
 * du-equivalent walk (allocated 512-byte blocks like du, i.e. st_blocks*512)
 * so reflink/hardlink sharing shows up as apparent size, matching du -sb
 * semantics closely enough for the report. Returns null when the tree cannot
 * be walked.
 */
function visibleSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  let ok = true;
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      ok = false;
      continue;
    }
    for (const ent of entries) {
      const p = path.join(cur, ent.name);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else {
        total += (st.blocks || Math.ceil(st.size / 512)) * 512;
      }
    }
  }
  return ok ? total : null;
}

/** ageSec: seconds since the newest mtime in the copy's top level (cheap, no walk). */
function ageSeconds(dir, now = Date.now()) {
  try {
    const st = fs.statSync(dir);
    return Math.max(0, Math.floor((now - st.mtimeMs) / 1000));
  } catch {
    return 0;
  }
}

/** owner/repo of a class-D base from its path git-base/<owner>/<repo>.git. */
function baseRepoFromPath(gitBaseDir, basePath) {
  const rel = path.relative(gitBaseDir, basePath);
  const m = rel.match(/^([^/]+)\/([^/]+)\.git$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Last fetch of a base: the mtime of FETCH_HEAD, else of the packed refs. */
function baseLastFetchAt(basePath) {
  for (const f of ["FETCH_HEAD", "packed-refs", "HEAD"]) {
    try {
      const st = fs.statSync(path.join(basePath, f));
      return st.mtime.toISOString().replace(/\.\d{3}Z$/, "Z");
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Worktree paths recorded by a base (git worktree list --porcelain). */
function baseWorktrees(basePath) {
  const out = tryGit(basePath, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length));
}

/**
 * The full inventory.
 *
 * Copies come from three sources, merged by path:
 *  - the registry (class E task copies, class G scratch) — authoritative for
 *    key/class/openedAt; an entry whose directory vanished is reported
 *    missing (clean/pushed null), never silently dropped;
 *  - `git worktree list --porcelain` of every base — a worktree of a base
 *    that the registry does not know still shows up (class E when it lives
 *    under the workspace root and its branch matches bot/<KEY>, else X);
 *  - stray directories under the workspace/scratch roots the registry and the
 *    bases both miss — class X (foreign), so botd can report them.
 *
 * Bases are the bare repositories directly under git-base/<owner>/<repo>.git.
 *
 * @returns {{copies: Array, bases: Array}} copies carry every field of both
 *          the list entry and the report copy (superset; callers pick).
 */
function inventory(options = {}) {
  const env = options.env || process.env;
  const layout = wsLayout(env);
  if (options.workspaceRoot) layout.workspaceRoot = options.workspaceRoot;
  if (options.scratchRoot) layout.scratchRoot = options.scratchRoot;
  const now = options.now || Date.now();
  const withSizes = options.sizes !== false;

  const registry = readRegistry(layout.registryPath);
  // Dedupe key is the canonical path: `git worktree list` reports realpaths
  // while the registry or a root may sit behind a symlink (same directory,
  // two spellings). The displayed path stays the one its source recorded.
  const byPath = new Map();

  // 1. Registry entries.
  for (const entry of registry.entries) {
    const present = fs.existsSync(entry.path) && isGitCopy(entry.path);
    if (!present) {
      byPath.set(canonical(entry.path), {
        key: entry.key,
        path: entry.path,
        class: entry.class,
        ...(entry.repo ? { repo: entry.repo } : {}),
        ...(entry.branch ? { branch: entry.branch } : {}),
        openedAt: entry.openedAt,
        clean: null,
        pushed: null,
        sizeBytes: null,
        ageSec: 0,
        missing: true,
      });
      continue;
    }
    const branch = entry.branch || headBranch(entry.path);
    byPath.set(canonical(entry.path), {
      key: entry.key,
      path: entry.path,
      class: entry.class,
      ...(entry.repo ? { repo: entry.repo } : {}),
      ...(branch ? { branch } : {}),
      openedAt: entry.openedAt,
      clean: isClean(entry.path),
      pushed: isPushed(entry.path, branch),
      sizeBytes: withSizes ? visibleSizeBytes(entry.path) : null,
      ageSec: ageSeconds(entry.path, now),
      missing: false,
    });
  }

  // 2. Bases and their worktrees.
  const bases = [];
  let owners = [];
  try {
    owners = fs.readdirSync(layout.gitBaseDir, { withFileTypes: true });
  } catch {
    owners = [];
  }
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    let repos = [];
    try {
      repos = fs.readdirSync(path.join(layout.gitBaseDir, owner.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const r of repos) {
      if (!r.isDirectory() || !r.name.endsWith(".git")) continue;
      const basePath = path.join(layout.gitBaseDir, owner.name, r.name);
      const repo = baseRepoFromPath(layout.gitBaseDir, basePath);
      bases.push({
        repo,
        path: basePath,
        sizeBytes: withSizes ? visibleSizeBytes(basePath) : null,
        lastFetchAt: baseLastFetchAt(basePath),
      });
      // Worktrees of this base the registry does not know about.
      for (const wt of baseWorktrees(basePath)) {
        if (byPath.has(canonical(wt))) {
          // Registry entry exists: backfill the repo when the entry lacks it.
          const known = byPath.get(canonical(wt));
          if (!known.repo && repo) known.repo = repo;
          continue;
        }
        if (!fs.existsSync(wt) || !isGitCopy(wt)) continue; // stale worktree record
        const branch = headBranch(wt);
        // A bot/<KEY> branch marks a task copy (class E) wherever it sits;
        // other worktrees of a base outside the workspace root are foreign.
        const inWorkspace =
          path.dirname(wt) === layout.workspaceRoot ||
          (branch !== null && branch.startsWith(WS_TASK_BRANCH_PREFIX));
        const key =
          branch && branch.startsWith(WS_TASK_BRANCH_PREFIX)
            ? branch.slice(WS_TASK_BRANCH_PREFIX.length)
            : path.basename(wt);
        byPath.set(canonical(wt), {
          key,
          path: wt,
          class: inWorkspace ? "E" : "X",
          ...(repo ? { repo } : {}),
          ...(branch ? { branch } : {}),
          openedAt: openedAtFromFs(wt),
          clean: isClean(wt),
          pushed: isPushed(wt, branch),
          sizeBytes: withSizes ? visibleSizeBytes(wt) : null,
          ageSec: ageSeconds(wt, now),
          missing: false,
        });
      }
    }
  }

  // 3. Stray directories under the workspace/scratch roots (class X).
  for (const root of [layout.workspaceRoot, layout.scratchRoot]) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root absent (e.g. no /scratch outside the container)
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(root, ent.name);
      if (byPath.has(canonical(p))) continue;
      if (!isGitCopy(p)) continue; // non-git leftovers are botd's foreign scan, not list
      const branch = headBranch(p);
      byPath.set(canonical(p), {
        key: ent.name,
        path: p,
        class: "X",
        ...(branch ? { branch } : {}),
        openedAt: openedAtFromFs(p),
        clean: isClean(p),
        pushed: isPushed(p, branch),
        sizeBytes: withSizes ? visibleSizeBytes(p) : null,
        ageSec: ageSeconds(p, now),
        missing: false,
      });
    }
  }

  const copies = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  bases.sort((a, b) => a.path.localeCompare(b.path));
  return { copies, bases };
}

/** openedAt for a copy the registry never recorded: directory ctime. */
function openedAtFromFs(dir) {
  try {
    const st = fs.statSync(dir);
    return st.birthtimeMs > 0
      ? st.birthtime.toISOString().replace(/\.\d{3}Z$/, "Z")
      : st.ctime.toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return new Date(0).toISOString().replace(/\.\d{3}Z$/, "Z");
  }
}

/** The myr-ws list entry shape (contract myrWsListResultSchema). */
function toListEntry(copy) {
  const entry = {
    key: copy.key,
    path: copy.path,
    class: copy.class === "G" ? "G" : "E",
    ...(copy.repo ? { repo: copy.repo } : {}),
    ...(copy.branch ? { branch: copy.branch } : {}),
    openedAt: copy.openedAt,
    clean: copy.clean,
    pushed: copy.pushed,
  };
  if (copy.missing) entry.missing = true;
  return entry;
}

module.exports = { MYRMIDON_HOME_DEFAULT, WS_WORKSPACE_ROOT, WS_SCRATCH_ROOT, WS_TASK_BRANCH_PREFIX, wsLayout, readRegistry, visibleSizeBytes, inventory, toListEntry };
