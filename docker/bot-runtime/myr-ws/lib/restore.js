"use strict";
// docker/bot-runtime/myr-ws/lib/restore.js
//
// myrmidon(1.6.5 BOT-DISK-H2e): `myr-ws restore <KEY> [--json]` — recovers a
// task copy that botd removed with unpushed work from its class-F archive
// (epic OPE-5306, design §2.3 row F: `restore <KEY>` = new worktree +
// `git bundle unbundle` + apply).
//
// Contract (docs/myrmidon/bot-disk-contract, section C2, enforced by the test
// scripts/myrmidon/bot-runtime/myr-ws-restore.test.mjs against
// packages/shared/src/myrmidon-bot-workspace.ts):
//   result --json: { ok:true, key, path, branch, restoredFrom }
//   error  --json: { ok:false, error, exitCode }
//   exit codes: 0 ok; 2 invalid arguments; 5 git/network failure;
//   6 no such archive / archive broken (nothing is touched).
//
// Archive layout (contract C1, written by botd H3):
//   <home>/archive/<KEY>-<ts>.bundle          — branches not on origin
//   <home>/archive/<KEY>-<ts>.patch           — worktree diff at archive time
//   <home>/archive/<KEY>-<ts>.untracked.tar   — untracked files (no ignored)
//   <home>/archive/manifest.json              — {version:1, archives:[{key,
//     repo, bundle, patch?, untrackedTar?, createdAt}]}
// NOTE: manifest.json is not in the H0 contract schemas; the shape above is
// the minimal one this command consumes and is to be pinned via a contract
// comment on OPE-5342 (botd H3 must write the same fields).
//
// The new worktree is created through the `open` interface (lib/open.js, H2b)
// injected as `deps.open`, so registry updates, disk-pressure rules and the
// class-D base stay in one place. Restore never overwrites an existing copy:
// if <workspaceRoot>/<KEY> exists (whatever the registry says), the command
// fails with exit 6 and touches nothing. Idempotence: a copy that already
// holds the archived branch tip and has a clean worktree is reported back
// with reused:true instead of failing.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// --- contract constants (C1/C2); drift here is caught by the unit test ---
const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const DEFAULT_HOME = "/data/hermes/.myrmidon";
const WORKSPACE_ROOT = "/workspace";
const TASK_BRANCH_PREFIX = "bot/";
const ENV = { home: "MYRMIDON_WS_HOME", gitReal: "MYRMIDON_GIT_REAL" };

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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

function parseRestoreArgs(argv) {
  const out = { positional: [], json: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a.startsWith("-")) throw usage(`unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}

function resolveRestoreRequest(args) {
  if (args.positional.length !== 1) throw usage("usage: myr-ws restore <KEY> [--json]");
  const key = args.positional[0];
  if (!ISSUE_KEY_RE.test(key)) throw usage(`invalid issue key ${JSON.stringify(key)} (expected PREFIX-123)`);
  return { key };
}

// --- archive manifest -----------------------------------------------------

function manifestPath(ctx) {
  return path.join(ctx.archiveRoot, "manifest.json");
}

function readManifest(ctx) {
  let raw;
  try {
    raw = fs.readFileSync(manifestPath(ctx), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, archives: [] };
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WsError(EXIT.notFound, `${manifestPath(ctx)} is not valid JSON; cannot pick an archive safely`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.archives)) {
    throw new WsError(EXIT.notFound, `${manifestPath(ctx)} has an unknown format; cannot pick an archive safely`);
  }
  return parsed;
}

function isWithin(root, p) {
  return path.resolve(p).startsWith(path.resolve(root) + path.sep);
}

function checkArchiveFile(ctx, p, what) {
  if (typeof p !== "string" || !p) throw new WsError(EXIT.notFound, `archive entry lacks ${what}`);
  if (!isWithin(ctx.archiveRoot, p)) {
    throw new WsError(EXIT.notFound, `archive ${what} ${JSON.stringify(p)} points outside ${ctx.archiveRoot}; refusing`);
  }
  if (!fs.existsSync(p)) throw new WsError(EXIT.notFound, `archive ${what} ${p} is missing on disk`);
}

/**
 * The latest archive of <key> by manifest.json. Throws WsError(6) when there
 * is none or the entry is unusable; in both cases nothing on disk is touched.
 */
function findArchive(ctx, key) {
  const entries = readManifest(ctx).archives.filter((a) => a && a.key === key);
  if (entries.length === 0) throw new WsError(EXIT.notFound, `no archive of ${key} in ${manifestPath(ctx)}`);
  entries.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const latest = entries[0];
  if (latest.repo !== undefined && (typeof latest.repo !== "string" || !REPO_RE.test(latest.repo))) {
    throw new WsError(EXIT.notFound, `archive entry of ${key} has an invalid repo ${JSON.stringify(latest.repo)}`);
  }
  if (!latest.repo) throw new WsError(EXIT.notFound, `archive entry of ${key} has no repo; cannot rebuild a base`);
  checkArchiveFile(ctx, latest.bundle, "bundle");
  if (latest.patch !== undefined) checkArchiveFile(ctx, latest.patch, "patch");
  if (latest.untrackedTar !== undefined) checkArchiveFile(ctx, latest.untrackedTar, "untracked.tar");
  return latest;
}

// --- git / tar ---------------------------------------------------------------

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

function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function makeCtx(deps = {}) {
  const env = deps.env || process.env;
  const home = deps.home || env[ENV.home] || DEFAULT_HOME;
  return {
    env,
    home,
    archiveRoot: deps.archiveRoot || path.join(home, "archive"),
    workspaceRoot: deps.workspaceRoot || WORKSPACE_ROOT,
    open: deps.open || null,
    openDeps: deps.openDeps || null,
  };
}

async function callOpen(ctx, request) {
  const openFn = ctx.open || require("./open.js").open;
  const res = await openFn(request, {
    env: ctx.env,
    home: ctx.home,
    workspaceRoot: ctx.workspaceRoot,
    ...(ctx.openDeps || {}),
  });
  if (!res || res.ok !== true || typeof res.path !== "string") {
    throw new WsError(EXIT.network, `myr-ws open returned no copy for ${request.key}`);
  }
  return res;
}

function worktreeClean(git, dir) {
  return git(dir, ["status", "--porcelain=v1", "--untracked-files=no"]).stdout === "";
}

/**
 * Restores the latest archive of <key>. Returns the contract result object
 * ({ ok:true, key, path, branch, restoredFrom } plus reused:true when the copy
 * was already restored). Throws WsError; exit 6 failures leave every existing
 * working copy untouched.
 */
async function restore(request, deps = {}) {
  const ctx = makeCtx(deps);
  const { key } = request;
  const branch = `${TASK_BRANCH_PREFIX}${key}`;
  const dir = path.join(ctx.workspaceRoot, key);
  const git = makeGit(ctx);

  // 1. Pick the archive first: a broken/absent archive must not touch anything.
  const archive = findArchive(ctx, key);

  // 2. Verify the bundle before any mutation: list-heads validates the file
  //    structure without needing a repository (a broken bundle -> exit 6,
  //    nothing touched). The full prerequisite check (`bundle verify`) runs
  //    inside the fresh worktree at step 5, where a repository exists.
  const headsR = git(ctx.archiveRoot, ["bundle", "list-heads", archive.bundle], { allowFail: true });
  if (headsR.status !== 0) {
    const why = (headsR.stderr || headsR.stdout || "unknown error").trim().split("\n").slice(-2).join(" | ");
    throw new WsError(EXIT.notFound, `archive bundle of ${key} is broken: ${why}`);
  }
  const bundleRef = `refs/heads/${branch}`;
  const heads = {};
  for (const line of headsR.stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
    if (m) heads[m[2]] = m[1];
  }
  if (!heads[bundleRef]) {
    throw new WsError(EXIT.notFound, `archive bundle of ${key} does not contain ${bundleRef}; cannot restore`);
  }

  // 3. An existing copy is never overwritten. Idempotence: if the copy
  //    already holds the archived branch tip, report reused:true regardless
  //    of worktree cleanliness — the patch/untracked are part of the
  //    restored state and must not be re-applied.
  if (fs.existsSync(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      const tip = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
      if (tip.status === 0 && tip.stdout === heads[bundleRef]) {
        return { ok: true, key, path: dir, branch, restoredFrom: archive.bundle, reused: true };
      }
    }
    throw new WsError(
      EXIT.notFound,
      `${dir} already exists; restore never overwrites an existing copy — inspect it or run myr-ws close ${key} first`,
    );
  }

  // 4. Rebuild the copy through the open interface (base, worktree, registry).
  const opened = await callOpen(ctx, { key, repo: archive.repo, scratch: false });

  // 5. unbundle + patch + untracked. Any failure removes the fresh copy and
  //    rethrows (nothing pre-existing is touched; the failure code stays 5).
  try {
    git(opened.path, ["bundle", "verify", archive.bundle]);
    git(opened.path, ["bundle", "unbundle", archive.bundle]);
    const headSha = heads[bundleRef];
    git(opened.path, ["update-ref", bundleRef, headSha]);
    git(opened.path, ["symbolic-ref", "HEAD", bundleRef]);
    git(opened.path, ["reset", "--hard", bundleRef]);
    if (archive.patch && fs.statSync(archive.patch).size > 0) {
      const applied = git(opened.path, ["apply", "--whitespace=nowarn", archive.patch], { allowFail: true });
      if (applied.status !== 0) {
        throw new WsError(EXIT.network, `archive patch of ${key} does not apply: ${applied.stderr.slice(0, 300)}`);
      }
    }
    if (archive.untrackedTar) {
      const r = spawnSync("tar", ["-xf", archive.untrackedTar, "-C", opened.path], { encoding: "utf8" });
      if (r.status !== 0) {
        throw new WsError(EXIT.network, `archive untracked.tar of ${key} failed to unpack: ${(r.stderr || "").trim().slice(0, 300)}`);
      }
    }
  } catch (e) {
    fs.rmSync(opened.path, { recursive: true, force: true });
    throw e;
  }

  return { ok: true, key, path: opened.path, branch, restoredFrom: archive.bundle, reused: false };
}

/**
 * CLI entry for the `restore` verb: argv excludes the verb. Returns
 * {exitCode, stdout, stderr}; the caller (lib/cli.js) prints them. With --json
 * a failure prints the C2 error shape on stdout and the message on stderr.
 */
async function runRestore(argv, deps = {}) {
  let json = argv.includes("--json");
  try {
    const args = parseRestoreArgs(argv);
    json = args.json;
    const result = await restore(resolveRestoreRequest(args), deps);
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
  WsError,
  parseRestoreArgs,
  resolveRestoreRequest,
  readManifest,
  findArchive,
  restore,
  runRestore,
};
