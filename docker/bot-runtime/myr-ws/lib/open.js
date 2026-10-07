"use strict";
// docker/bot-runtime/myr-ws/lib/open.js
//
// myrmidon(1.6.5-BOT-DISK-H2b): `myr-ws open <KEY> [owner/repo] [--base <ref>]
// [--scratch [<name>]] [--json]`. A task copy is a git worktree of the bot's
// class-D base (`/workspace/<KEY>`, branch `bot/<KEY>`, no object store of its
// own); a scratch copy is a worktree of the same base on a detached head, or an
// empty directory when no repository is given (`/scratch/<name>`).
//
// Everything outside this file comes through the interface of
// docs/myrmidon/bot-disk-contract (packages/shared/src/myrmidon-bot-workspace.ts,
// section C2): exit codes (MYR_WS_EXIT), the quota message prefix, the --json
// result shape, the registry file and the disk-state file. The base repository
// is obtained from `ensureBase(owner/repo)` (lib/base.js, H2a) through `deps`,
// so tests inject a fake and this file never builds a base itself.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// --- contract constants (C1/C2); a drift here is caught by the unit test ---
const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const QUOTA_PREFIX = "BOT_DISK_QUOTA_EXCEEDED:";
const DEFAULT_HOME = "/data/hermes/.myrmidon";
const WORKSPACE_ROOT = "/workspace";
const SCRATCH_ROOT = "/scratch";
const TASK_BRANCH_PREFIX = "bot/";
const ENV = { home: "MYRMIDON_WS_HOME", gitReal: "MYRMIDON_GIT_REAL" };
// botd rewrites disk-state.json every pass (60 s); "older than two ticks" is stale.
const DISK_STATE_STALE_SEC = 120;
const HINT_COPIES = 5;

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const SCRATCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_REF_RE = /^[^\s~^:?*[\]\\]+$/;

class WsError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "WsError";
    this.exitCode = exitCode;
  }
}

function usage(message) {
  return new WsError(EXIT.usage, message);
}

// --- arguments ---------------------------------------------------------

function parseOpenArgs(argv) {
  const out = { positional: [], base: null, scratch: false, scratchName: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--base") {
      const v = argv[++i];
      if (v === undefined) throw usage("--base needs a ref");
      out.base = v;
    } else if (a.startsWith("--base=")) out.base = a.slice("--base=".length);
    else if (a === "--scratch") out.scratch = true;
    else if (a.startsWith("--scratch=")) {
      out.scratch = true;
      out.scratchName = a.slice("--scratch=".length);
    } else if (a.startsWith("-")) throw usage(`unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}

/** Validate arguments; returns {key, repo, base, scratch}. Path injection is impossible past this point. */
function resolveOpenRequest(args) {
  let repo = null;
  const names = [];
  for (const p of args.positional) {
    if (p.includes("/")) {
      if (repo !== null) throw usage("only one owner/repo is allowed");
      repo = p;
    } else names.push(p);
  }
  if (repo !== null && (!REPO_RE.test(repo) || repo.split("/").some((s) => s === "." || s === ".."))) {
    throw usage(`repository must look like owner/name, got ${JSON.stringify(repo)}`);
  }
  if (args.base !== null) {
    let b = args.base.replace(/^(refs\/remotes\/)?origin\//, "");
    if (!b || b.startsWith("-") || b.includes("..") || !BASE_REF_RE.test(b) || b.length > 200) {
      throw usage(`invalid --base ${JSON.stringify(args.base)}`);
    }
    args = { ...args, base: b };
  }
  let key;
  if (args.scratch) {
    if (args.scratchName !== null) names.unshift(args.scratchName);
    if (names.length !== 1) throw usage("open --scratch needs exactly one <name>");
    key = names[0];
    if (!SCRATCH_NAME_RE.test(key) || key.includes("..")) {
      throw usage(`invalid scratch name ${JSON.stringify(key)} (letters, digits, . _ -; no '/' or '..')`);
    }
  } else {
    if (names.length !== 1) throw usage("usage: myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch <name>] [--json]");
    key = names[0];
    if (!ISSUE_KEY_RE.test(key)) throw usage(`invalid issue key ${JSON.stringify(key)} (expected PREFIX-123)`);
  }
  return { key, repo, base: args.base, scratch: args.scratch };
}

// --- registry (C1 ws-registry.json) --------------------------------------

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
    throw new WsError(EXIT.usage, `${registryPath(ctx)} is not valid JSON; refusing to overwrite it`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new WsError(EXIT.usage, `${registryPath(ctx)} has an unknown format; refusing to overwrite it`);
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
      if (Date.now() > deadline) throw new WsError(EXIT.usage, "ws-registry.json is locked by another myr-ws");
      sleepMs(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// --- disk pressure (C1 disk-state.json) ------------------------------------

/** Pressure file; absent, unreadable or stale means "none" (botd is the writer, not us). */
function readDiskState(ctx) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ctx.home, "disk-state.json"), "utf8"));
    if (!s || s.version !== 1 || !["none", "soft", "hard"].includes(s.pressure)) return null;
    const at = Date.parse(`${String(s.updatedAt).replace(/Z$/, "")}Z`);
    if (!Number.isFinite(at) || ctx.now() - at > ctx.diskStateStaleSec * 1000) return null;
    return s;
  } catch {
    return null;
  }
}

function defaultSizeOf(p) {
  const r = spawnSync("du", ["-sb", "--", p], { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0 && !r.stdout) return null;
  const n = Number.parseInt(String(r.stdout).split(/\s/)[0], 10);
  return Number.isFinite(n) ? n : null;
}

function humanBytes(n) {
  if (n === null || n === undefined) return "size unknown";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

function quotaRefusal(ctx, state, reg) {
  const sized = reg.entries.map((e) => ({ e, size: ctx.sizeOf(e.path) }));
  sized.sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
  const top = sized.slice(0, HINT_COPIES);
  const pct = (v) => (v === null || v === undefined ? "n/a" : `${v}%`);
  let msg = `${QUOTA_PREFIX} disk pressure is hard (bot quota ${pct(state.quotaPercent)}, partition ${pct(state.partitionPercent)}); no new copy is created.`;
  if (top.length === 0) {
    msg += " The registry lists no copies; the space is held outside myr-ws (ask the operator).";
  } else {
    msg += ` Free space first, largest copies (myr-ws close <KEY>): ${top
      .map(({ e, size }) => `${e.key} ${e.path} ${humanBytes(size)}`)
      .join("; ")}.`;
  }
  return new WsError(EXIT.quotaExceeded, msg);
}

// --- git -------------------------------------------------------------------

function makeGit(ctx) {
  const bin = ctx.env[ENV.gitReal] || "git";
  return function git(cwd, args, { allowFail = false } = {}) {
    const r = spawnSync(bin, args, {
      cwd,
      encoding: "utf8",
      env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) throw new WsError(EXIT.network, `cannot run git: ${r.error.message}`);
    if (r.status !== 0 && !allowFail) {
      throw new WsError(EXIT.network, `git ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
    }
    return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

function resolveBaseRef(git, basePath, wanted) {
  const has = (ref) => git(basePath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFail: true }).status === 0;
  if (wanted) {
    if (!has(`refs/remotes/origin/${wanted}`)) throw usage(`base ref origin/${wanted} does not exist in the repository`);
    return wanted;
  }
  const head = git(basePath, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (head.status === 0 && head.stdout.startsWith("refs/remotes/origin/")) {
    const b = head.stdout.slice("refs/remotes/origin/".length);
    if (has(`refs/remotes/origin/${b}`)) return b;
  }
  for (const b of ["main", "master"]) if (has(`refs/remotes/origin/${b}`)) return b;
  const any = git(basePath, ["for-each-ref", "--count=1", "--format=%(refname:strip=3)", "refs/remotes/origin/"], { allowFail: true });
  if (any.stdout) return any.stdout;
  throw usage("the repository has no branches to base a copy on");
}

function isWorktreeOf(dir) {
  try {
    return fs.statSync(path.join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

// --- open ------------------------------------------------------------------

function makeCtx(deps = {}) {
  const env = deps.env || process.env;
  return {
    env,
    home: deps.home || env[ENV.home] || DEFAULT_HOME,
    workspaceRoot: deps.workspaceRoot || WORKSPACE_ROOT,
    scratchRoot: deps.scratchRoot || SCRATCH_ROOT,
    now: deps.now || (() => Date.now()),
    diskStateStaleSec: deps.diskStateStaleSec ?? DISK_STATE_STALE_SEC,
    sizeOf: deps.sizeOf || defaultSizeOf,
    ensureBase: deps.ensureBase || null,
  };
}

async function loadBase(ctx, repo) {
  const ensureBase = ctx.ensureBase || require("./base").ensureBase;
  const res = await ensureBase(repo, { home: ctx.home, env: ctx.env });
  const basePath = typeof res === "string" ? res : res && (res.path || res.basePath);
  if (!basePath) throw new WsError(EXIT.network, "ensureBase returned no base path");
  return basePath;
}

/** Create or reuse a copy. Returns the myrWsOpenResult object; throws WsError. */
async function open(request, deps = {}) {
  const ctx = makeCtx(deps);
  const { key, repo, scratch } = request;
  const dir = path.join(scratch ? ctx.scratchRoot : ctx.workspaceRoot, key);
  const klass = scratch ? "G" : "E";
  const branch = scratch ? undefined : `${TASK_BRANCH_PREFIX}${key}`;
  const git = makeGit(ctx);

  // 1. Idempotence: a copy that is registered and present is returned as is.
  const reg = readRegistry(ctx);
  const known = reg.entries.find((e) => e.path === dir || (e.key === key && e.class === klass));
  if (known && fs.existsSync(known.path)) {
    if (repo && known.repo && repo !== known.repo) {
      throw usage(`${key} is already open for ${known.repo} at ${known.path}; close it before opening ${repo}`);
    }
    return stripUndefined({
      ok: true,
      key,
      path: known.path,
      class: known.class,
      repo: known.repo,
      branch: known.branch,
      base: request.base ? `origin/${request.base}` : undefined,
      reused: true,
    });
  }

  // 2. A worktree that exists on disk but is missing from the registry (the
  //    registry was lost or a previous open died before writing it) is adopted.
  if (!scratch && fs.existsSync(dir) && isWorktreeOf(dir)) {
    const url = git(dir, ["remote", "get-url", "origin"], { allowFail: true }).stdout;
    const adoptedRepo = repo || (url.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/) || [])[1];
    const entry = stripUndefined({ key, repo: adoptedRepo, path: dir, class: klass, branch, openedAt: isoNow(ctx) });
    withRegistryLock(ctx, () => {
      const r = readRegistry(ctx);
      r.entries = r.entries.filter((e) => e.path !== dir);
      r.entries.push(entry);
      writeRegistry(ctx, r);
    });
    return stripUndefined({ ok: true, key, path: dir, class: klass, repo: adoptedRepo, branch, reused: true });
  }
  if (fs.existsSync(dir)) {
    const empty = fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
    if (!empty) throw usage(`${dir} exists and is not a copy opened by myr-ws; refusing to touch it`);
  }

  // 3. Pressure: only creating a copy consumes disk, so reuse above is not refused.
  const state = readDiskState(ctx);
  if (state && state.pressure === "hard") throw quotaRefusal(ctx, state, reg);

  if (!scratch && !repo) throw usage(`no copy of ${key} is open; give the repository: myr-ws open ${key} owner/repo`);

  // 4. Create.
  let baseRef;
  if (repo) {
    const basePath = await loadBase(ctx, repo);
    baseRef = resolveBaseRef(git, basePath, request.base);
    git(basePath, ["worktree", "prune"]);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) fs.rmdirSync(dir); // empty leftover dir: worktree add wants to make it
    const target = `refs/remotes/origin/${baseRef}`;
    if (scratch) {
      git(basePath, ["worktree", "add", "--detach", dir, target]);
    } else {
      const haveBranch = git(basePath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).status === 0;
      // A branch left by an earlier copy of this task keeps its commits: reattach it, do not reset it.
      if (haveBranch) git(basePath, ["worktree", "add", dir, branch]);
      else git(basePath, ["worktree", "add", "--no-track", "-b", branch, dir, target]);
    }
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }

  const entry = stripUndefined({ key, repo: repo || undefined, path: dir, class: klass, branch, openedAt: isoNow(ctx) });
  withRegistryLock(ctx, () => {
    const r = readRegistry(ctx);
    r.entries = r.entries.filter((e) => e.path !== dir);
    r.entries.push(entry);
    writeRegistry(ctx, r);
  });
  return stripUndefined({
    ok: true,
    key,
    path: dir,
    class: klass,
    repo: repo || undefined,
    branch,
    base: baseRef ? `origin/${baseRef}` : undefined,
    reused: false,
  });
}

function isoNow(ctx) {
  return new Date(ctx.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * CLI entry for the `open` verb: argv excludes the verb. Returns
 * {exitCode, stdout, stderr}; the caller (lib/cli.js) prints them. With --json
 * a failure prints the C2 error shape on stdout and the message on stderr.
 */
async function runOpen(argv, deps = {}) {
  let json = argv.includes("--json");
  try {
    const args = parseOpenArgs(argv);
    json = args.json;
    const result = await open(resolveOpenRequest(args), deps);
    return { exitCode: EXIT.ok, stdout: json ? `${JSON.stringify(result)}\n` : `${result.path}\n`, stderr: "" };
  } catch (e) {
    if (!(e instanceof WsError) && typeof e.exitCode !== "number") throw e;
    const exitCode = e.exitCode;
    return {
      exitCode,
      stdout: json ? `${JSON.stringify({ ok: false, error: e.message, exitCode })}\n` : "",
      stderr: `myr-ws: ${e.message}\n`,
    };
  }
}

module.exports = {
  EXIT,
  QUOTA_PREFIX,
  WsError,
  parseOpenArgs,
  resolveOpenRequest,
  readRegistry,
  writeRegistry,
  withRegistryLock,
  readDiskState,
  open,
  runOpen,
};
