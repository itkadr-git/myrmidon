"use strict";
// myrmidon(1.6.5 BOT-DISK-H2d): `myr-ws close <KEY> [--force] [--json]`.
//
// A clean copy whose commits are all on origin is removed: `git worktree
// remove`, the branch bot/<KEY> deleted from the base, the registry entry
// dropped, `git worktree prune` on the base. A dirty copy or one with
// unpushed commits is refused with exit code 7 and nothing is touched; with
// --force the archive module (botd, `archive(copyPath, key)`, task H3b) runs
// first and the copy is removed only when it reported ok. Contract C2:
// docs/myrmidon/bot-disk-contract (myr-ws-close.json, ws-registry.json).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// The shared error type lives in lib/errors.js (BOT-DISK-H2a). This module is
// built against the contract and must load before that file is merged, so it
// falls back to an identical class; once errors.js exists the shared one wins.
let MyrWsError;
try {
  ({ MyrWsError } = require("./errors.js"));
} catch (e) {
  if (e && e.code !== "MODULE_NOT_FOUND") throw e;
  MyrWsError = class MyrWsError extends Error {
    constructor(exitCode, message) {
      super(message);
      this.name = "MyrWsError";
      this.exitCode = exitCode;
    }
  };
}

// Mirrors of the contract (C1/C2); the test compares them with the shared file.
const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const DEFAULT_HOME = "/data/hermes/.myrmidon";
const WORKSPACE_ROOT = "/workspace";
const SCRATCH_ROOT = "/scratch";
const TASK_BRANCH_PREFIX = "bot/";
const ENV = { home: "MYRMIDON_WS_HOME", gitReal: "MYRMIDON_GIT_REAL" };
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function usage(message) {
  return new MyrWsError(EXIT.usage, message);
}

function makeCtx(deps = {}) {
  const env = deps.env || process.env;
  return {
    env,
    home: deps.home || env[ENV.home] || DEFAULT_HOME,
    workspaceRoot: deps.workspaceRoot || WORKSPACE_ROOT,
    scratchRoot: deps.scratchRoot || SCRATCH_ROOT,
    archive: deps.archive || null,
  };
}

// --- registry (C1 ws-registry.json), same file and lock as `open` -----------

function registryPath(ctx) {
  return path.join(ctx.home, "ws-registry.json");
}

function readRegistry(ctx) {
  let raw;
  try {
    raw = fs.readFileSync(registryPath(ctx), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, entries: [] };
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usage(`${registryPath(ctx)} is not valid JSON; refusing to touch it`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw usage(`${registryPath(ctx)} has an unknown format; refusing to touch it`);
  }
  return parsed;
}

function writeRegistry(ctx, reg) {
  const file = registryPath(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process lock around read-modify-write of the registry (O_EXCL file, stale after 30 s). */
function withRegistryLock(ctx, fn) {
  const lock = `${registryPath(ctx)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.rmSync(lock, { force: true });
      } catch {
        /* raced with the owner */
      }
      if (Date.now() > deadline) throw usage("ws-registry.json is locked by another myr-ws");
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function dropEntry(ctx, entry) {
  withRegistryLock(ctx, () => {
    const r = readRegistry(ctx);
    r.entries = r.entries.filter((e) => !(e.path === entry.path && e.key === entry.key));
    writeRegistry(ctx, r);
  });
}

// --- git ---------------------------------------------------------------

function makeGit(ctx) {
  const bin = ctx.env[ENV.gitReal] || "git";
  return function git(cwd, args) {
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) throw new MyrWsError(1, `cannot run git: ${r.error.message}`);
    return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

function mustGit(git, cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) {
    throw new MyrWsError(1, `git ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
  }
  return r;
}

/** The registry is bot-writable: only paths inside the two copy roots may be removed. */
function insideRoots(ctx, p) {
  const real = (x) => {
    try {
      return fs.realpathSync(x);
    } catch {
      return path.resolve(x);
    }
  };
  const target = path.resolve(p);
  return [ctx.workspaceRoot, ctx.scratchRoot].some((root) => {
    const r = real(root);
    return target.startsWith(r + path.sep) || target.startsWith(path.resolve(root) + path.sep);
  });
}

function isWorktree(dir) {
  try {
    return fs.statSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/** What would be lost: { dirty, unpushed } of a git copy. */
function inspectCopy(git, dir, branch) {
  const status = mustGit(git, dir, ["status", "--porcelain", "--untracked-files=all"]);
  const dirty = status.stdout.length > 0;
  // Commits of the copy that no origin ref holds. The task branch when it
  // exists (the copy may sit on another head), else HEAD (scratch, detached).
  const tip = branch && git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0 ? `refs/heads/${branch}` : "HEAD";
  const ahead = git(dir, ["rev-list", "--count", tip, "--not", "--remotes=origin"]);
  // An unreadable answer counts as "unpushed": never delete on a doubt.
  const n = ahead.status === 0 ? Number.parseInt(ahead.stdout, 10) : Number.NaN;
  const unpushed = !Number.isFinite(n) || n > 0;
  return { dirty, unpushed, ahead: Number.isFinite(n) ? n : null };
}

function commonDir(git, dir) {
  const r = git(dir, ["rev-parse", "--git-common-dir"]);
  if (r.status !== 0 || !r.stdout) return null;
  return path.resolve(dir, r.stdout);
}

function archiveFn(ctx) {
  if (ctx.archive) return ctx.archive;
  // In the image botd sits next to myr-ws (/opt/paperclip/{myr-ws,botd}); same layout in the repo.
  try {
    const mod = require(path.join(__dirname, "..", "..", "botd", "lib", "archive.js"));
    const fn = typeof mod === "function" ? mod : mod && mod.archive;
    if (typeof fn === "function") return fn;
  } catch {
    /* fall through */
  }
  throw new MyrWsError(1, "archive module is unavailable; the copy was not removed");
}

function describeLoss(state) {
  const parts = [];
  if (state.dirty) parts.push("uncommitted or untracked changes");
  if (state.unpushed) parts.push(state.ahead ? `${state.ahead} commit(s) not on origin` : "commits not on origin");
  return parts.join(" and ");
}

// --- close -------------------------------------------------------------

/**
 * Removes the copy registered under `key`. Returns the myrWsCloseResult body
 * (without `ok`, the CLI frame adds it). Throws MyrWsError: 2 bad arguments,
 * 6 no such copy, 7 unpushed/dirty without --force, 1 anything else.
 */
async function closeCopy(request, deps = {}) {
  const ctx = makeCtx(deps);
  const { key } = request;
  const force = request.force === true;
  if (typeof key !== "string" || !KEY_RE.test(key) || key.includes("..")) throw usage(`invalid copy key ${JSON.stringify(key)}`);

  const reg = readRegistry(ctx);
  const matches = reg.entries.filter((e) => e.key === key);
  const entry = matches.find((e) => e.class === "E") || matches[0];
  if (!entry) throw new MyrWsError(EXIT.notFound, `no open copy ${key}`);
  if (!insideRoots(ctx, entry.path)) {
    throw usage(`registry path ${JSON.stringify(entry.path)} of ${key} is outside ${ctx.workspaceRoot} and ${ctx.scratchRoot}; refusing to remove it`);
  }
  const dir = entry.path;
  const git = makeGit(ctx);

  // Registered but already gone from the disk: drop the entry and the stale worktree record.
  if (!fs.existsSync(dir)) {
    pruneBaseOf(git, ctx, entry);
    dropEntry(ctx, entry);
    return { key, removed: false, archived: false };
  }

  const worktree = isWorktree(dir);
  let base = null;
  let state;
  if (worktree) {
    base = commonDir(git, dir);
    state = inspectCopy(git, dir, entry.branch);
  } else {
    // Plain directory (scratch without a repository): only an empty one holds nothing.
    state = { dirty: fs.readdirSync(dir).length > 0, unpushed: false, ahead: 0 };
  }

  let archived = false;
  let archivePath;
  if (state.dirty || state.unpushed) {
    if (!force) {
      throw new MyrWsError(EXIT.unpushed, `${key} holds ${describeLoss(state)}; nothing was removed. Push it, or close with --force to archive it first`);
    }
    const res = await archiveFn(ctx)(dir, key);
    if (!res || res.ok !== true) {
      const why = res && res.error ? `: ${res.error}` : "";
      throw new MyrWsError(1, `archive of ${key} failed${why}; the copy was not removed`);
    }
    archived = true;
    archivePath = res.archivePath || res.path || res.bundle || undefined;
  }

  if (worktree && base) {
    const rm = ["worktree", "remove", ...(state.dirty || force ? ["--force"] : []), dir];
    mustGit(git, base, rm);
    const branch = entry.class === "E" ? entry.branch || `${TASK_BRANCH_PREFIX}${key}` : null;
    if (branch && git(base, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status === 0) {
      mustGit(git, base, ["branch", "-D", branch]);
    }
    mustGit(git, base, ["worktree", "prune"]);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (fs.existsSync(dir)) throw new MyrWsError(1, `${dir} is still on disk after removal; registry entry kept`);

  dropEntry(ctx, entry);
  const out = { key, removed: true, archived };
  if (archivePath) out.archivePath = archivePath;
  return out;
}

function pruneBaseOf(git, ctx, entry) {
  if (!entry.repo) return;
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(entry.repo);
  if (!m || m[1] === ".." || m[2] === "..") return;
  const base = path.join(ctx.home, "git-base", m[1], `${m[2]}.git`);
  if (fs.existsSync(path.join(base, "HEAD"))) git(base, ["worktree", "prune"]);
}

/** CLI handler: ({ positionals, flags, env }) as lib/cli.js passes it; deps for tests. */
async function close(ctx, deps = {}) {
  const positionals = (ctx && ctx.positionals) || [];
  if (positionals.length !== 1) throw usage("usage: myr-ws close <KEY> [--force] [--json]");
  const flags = (ctx && ctx.flags) || {};
  return closeCopy({ key: positionals[0], force: flags.force === true }, { env: ctx && ctx.env, ...deps });
}

module.exports = { close, closeCopy, EXIT };
