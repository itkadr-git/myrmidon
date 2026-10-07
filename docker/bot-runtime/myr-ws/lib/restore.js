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
// Archive layout (contract C1, written by botd H3 — no manifest.json exists
// in the contract or the design; the archive set is discovered by name):
//   <home>/archive/<KEY>-<ts>.bundle          — branches not on origin
//   <home>/archive/<KEY>-<ts>.patch           — worktree diff at archive time
//   <home>/archive/<KEY>-<ts>.untracked.tar   — untracked files (no ignored)
// The latest archive of <KEY> is the one with the greatest <ts> in the
// filename. The repository the copy belongs to comes from the open-copy
// registry <home>/ws-registry.json (contract C1/C4: the registry is the
// source of `repo` per key); without a registry entry the restore refuses
// with exit 6 — the base to rebuild the worktree from cannot be chosen
// safely.
//
// The new worktree is created through the `open` interface (lib/open.js, H2b)
// injected as `deps.open`, so registry updates, disk-pressure rules and the
// class-D base stay in one place. Restore never overwrites an existing copy:
// if <workspaceRoot>/<KEY> exists (whatever the registry says), the command
// fails with exit 6 and touches nothing. Idempotence: a copy that already
// holds the archived branch tip is reported back with reused:true instead of
// failing. Inside the fresh worktree the bot/<KEY> ref is written with
// compare-and-swap (`git update-ref <ref> <new> <old>`): if the base already
// has bot/<KEY> at a different commit the restore refuses (exit 6) and the
// fresh copy is rolled back.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { MyrWsError } = require("./errors.js");

// --- contract constants (C1/C2); drift here is caught by the unit test ---
const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const DEFAULT_HOME = "/data/hermes/.myrmidon";
const WORKSPACE_ROOT = "/workspace";
const TASK_BRANCH_PREFIX = "bot/";
const ENV = { home: "MYRMIDON_WS_HOME", gitReal: "MYRMIDON_GIT_REAL" };

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// <KEY>-<ts>.bundle; ts is any run of digits/T/Z/-/:/. (ISO-8601-ish), no dots.
const TS_RE = /^[0-9TtZz:._-]+$/;

function usage(message) {
  return new MyrWsError(EXIT.usage, message);
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

// --- archive discovery by bundle name (C1; no manifest in the contract) ---

/**
 * The latest archive of <key> in ctx.archiveRoot, found by scanning the
 * directory for `<key>-<ts>.bundle` files (contract C1 layout). Throws
 * MyrWsError(6) when there is none; nothing on disk is touched in that case.
 * Sibling files (<stem>.patch, <stem>.untracked.tar) are attached only when
 * present and regular.
 */
function findArchive(ctx, key) {
  let names;
  try {
    names = fs.readdirSync(ctx.archiveRoot);
  } catch (e) {
    if (e.code === "ENOENT") throw new MyrWsError(EXIT.notFound, `no archive of ${key} in ${ctx.archiveRoot}`);
    throw e;
  }
  const prefix = `${key}-`;
  const found = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".bundle")) continue;
    const ts = name.slice(prefix.length, -".bundle".length);
    if (!ts || !TS_RE.test(ts)) continue;
    const bundle = path.join(ctx.archiveRoot, name);
    let st;
    try {
      st = fs.statSync(bundle);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    found.push({ ts, bundle });
  }
  if (found.length === 0) throw new MyrWsError(EXIT.notFound, `no archive of ${key} in ${ctx.archiveRoot}`);
  found.sort((a, b) => b.ts.localeCompare(a.ts));
  const latest = found[0];
  const stem = latest.bundle.slice(0, -".bundle".length);
  const archive = { key, bundle: latest.bundle };
  const patch = `${stem}.patch`;
  if (fs.existsSync(patch) && fs.statSync(patch).isFile()) archive.patch = patch;
  const untrackedTar = `${stem}.untracked.tar`;
  if (fs.existsSync(untrackedTar) && fs.statSync(untrackedTar).isFile()) archive.untrackedTar = untrackedTar;
  return archive;
}

// --- registry (C1 ws-registry.json; the source of `repo` per key) ---------

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
    throw new MyrWsError(EXIT.notFound, `${registryPath(ctx)} is not valid JSON; cannot determine the repository of an archive safely`);
  }
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new MyrWsError(EXIT.notFound, `${registryPath(ctx)} has an unknown format; cannot determine the repository of an archive safely`);
  }
  return parsed;
}

/** The repo an archived copy of <key> belonged to, from the registry (C1/C4). */
function repoOf(ctx, key) {
  const entry = readRegistry(ctx).entries.find((e) => e && e.key === key && typeof e.repo === "string");
  if (!entry) {
    throw new MyrWsError(
      EXIT.notFound,
      `no registry entry for ${key} in ${registryPath(ctx)}; the repository of the archive is unknown — re-open the copy with myr-ws open ${key} owner/repo first`,
    );
  }
  if (!REPO_RE.test(entry.repo)) {
    throw new MyrWsError(EXIT.notFound, `registry entry of ${key} has an invalid repo ${JSON.stringify(entry.repo)}`);
  }
  return entry.repo;
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
    if (r.error) throw new MyrWsError(EXIT.network, `cannot run git: ${r.error.message}`);
    if (r.status !== 0 && !allowFail) {
      throw new MyrWsError(EXIT.network, `git ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
    }
    return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
  };
}

/** <home>/git-base/<owner>/<repo>.git (contract C1 layout of class-D bases). */
function basePath(ctx, repo) {
  const [owner, name] = repo.split("/");
  return path.join(ctx.home, "git-base", owner, `${name.replace(/\.git$/, "")}.git`);
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
    throw new MyrWsError(EXIT.network, `myr-ws open returned no copy for ${request.key}`);
  }
  return res;
}

/**
 * Restores the latest archive of <key>. Returns the contract result object
 * ({ ok:true, key, path, branch, restoredFrom } plus reused:true when the copy
 * was already restored). Throws MyrWsError; exit 6 failures leave every
 * existing working copy untouched.
 */
async function restore(request, deps = {}) {
  const ctx = makeCtx(deps);
  const { key } = request;
  const branch = `${TASK_BRANCH_PREFIX}${key}`;
  const dir = path.join(ctx.workspaceRoot, key);
  const git = makeGit(ctx);

  // 1. Pick the archive first: a broken/absent archive must not touch anything.
  const archive = findArchive(ctx, key);
  const repo = repoOf(ctx, key);

  // 2. Verify the bundle before any mutation: list-heads validates the file
  //    structure without needing a repository (a broken bundle -> exit 6,
  //    nothing touched). The full prerequisite check (`bundle verify`) runs
  //    inside the fresh worktree at step 5, where a repository exists.
  const headsR = git(ctx.archiveRoot, ["bundle", "list-heads", archive.bundle], { allowFail: true });
  if (headsR.status !== 0) {
    const why = (headsR.stderr || headsR.stdout || "unknown error").trim().split("\n").slice(-2).join(" | ");
    throw new MyrWsError(EXIT.notFound, `archive bundle of ${key} is broken: ${why}`);
  }
  const bundleRef = `refs/heads/${branch}`;
  const heads = {};
  for (const line of headsR.stdout.split("\n")) {
    const m = line.match(/^([0-9a-f]{40})\s+(\S+)$/);
    if (m) heads[m[2]] = m[1];
  }
  const headSha = heads[bundleRef];
  if (!headSha) {
    throw new MyrWsError(EXIT.notFound, `archive bundle of ${key} does not contain ${bundleRef}; cannot restore`);
  }

  // 3. An existing copy is never overwritten. Idempotence: if the copy
  //    already holds the archived branch tip, report reused:true regardless
  //    of worktree cleanliness — the patch/untracked are part of the
  //    restored state and must not be re-applied.
  if (fs.existsSync(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      const tip = git(dir, ["rev-parse", "--verify", "--quiet", bundleRef], { allowFail: true });
      if (tip.status === 0 && tip.stdout === headSha) {
        return { ok: true, key, path: dir, branch, restoredFrom: archive.bundle, reused: true };
      }
    }
    throw new MyrWsError(
      EXIT.notFound,
      `${dir} already exists; restore never overwrites an existing copy — inspect it or run myr-ws close ${key} first`,
    );
  }

  // 4. A bot/<KEY> branch already in the base at a DIFFERENT commit than the
  //    archive head belongs to a copy botd closed without archiving (or an
  //    older archive) — refuse before open creates anything (exit 6, nothing
  //    touched). The same commit is fine: open reattaches it and the CAS in
  //    step 5 is a no-op. A missing branch is the normal case: open creates it
  //    from the origin base ref and step 5 moves it onto the archive head.
  const base = basePath(ctx, repo);
  if (fs.existsSync(base)) {
    const existing = git(base, ["rev-parse", "--verify", "--quiet", bundleRef], { allowFail: true });
    if (existing.status === 0 && existing.stdout !== headSha) {
      throw new MyrWsError(
        EXIT.notFound,
        `branch ${branch} already exists in the base at ${existing.stdout.slice(0, 12)}, the archive holds ${headSha.slice(0, 12)}; refusing to overwrite — inspect it or remove the ref first`,
      );
    }
  }

  // 5. Rebuild the copy through the open interface (base, worktree, registry).
  const opened = await callOpen(ctx, { key, repo, scratch: false });

  // 6. unbundle + CAS the branch + patch + untracked. Any failure removes the
  //    fresh copy and rethrows (nothing pre-existing is touched).
  try {
    git(opened.path, ["bundle", "verify", archive.bundle]);
    git(opened.path, ["bundle", "unbundle", archive.bundle]);
    // Compare-and-swap: move refs/heads/bot/<KEY> onto the archive head only
    // when its current value is exactly what this restore just observed —
    // either the tip of the reattached branch (equal to headSha, per step 4)
    // or the origin base ref open just created the branch from. A concurrent
    // writer moving the ref between the two makes the CAS fail and the fresh
    // copy is rolled back; the branch itself is never clobbered.
    const cur = git(opened.path, ["rev-parse", "--verify", "--quiet", bundleRef], { allowFail: true });
    const oldSha = cur.status === 0 ? cur.stdout : "0000000000000000000000000000000000000000";
    const cas = git(opened.path, ["update-ref", bundleRef, headSha, oldSha], { allowFail: true });
    if (cas.status !== 0) {
      throw new MyrWsError(
        EXIT.notFound,
        `branch ${branch} moved while restoring (held ${cur.status === 0 ? cur.stdout.slice(0, 12) : "nothing"}, expected ${headSha.slice(0, 12)}); nothing was overwritten — retry the restore`,
      );
    }
    git(opened.path, ["symbolic-ref", "HEAD", bundleRef]);
    git(opened.path, ["reset", "--hard", bundleRef]);
    if (archive.patch && fs.statSync(archive.patch).size > 0) {
      const applied = git(opened.path, ["apply", "--whitespace=nowarn", archive.patch], { allowFail: true });
      if (applied.status !== 0) {
        throw new MyrWsError(EXIT.network, `archive patch of ${key} does not apply: ${applied.stderr.slice(0, 300)}`);
      }
    }
    if (archive.untrackedTar) {
      const r = spawnSync("tar", ["-xf", archive.untrackedTar, "-C", opened.path], { encoding: "utf8" });
      if (r.status !== 0) {
        throw new MyrWsError(EXIT.network, `archive untracked.tar of ${key} failed to unpack: ${(r.stderr || "").trim().slice(0, 300)}`);
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
    if (!(e instanceof MyrWsError) && typeof e.exitCode !== "number") throw e;
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
  MyrWsError,
  parseRestoreArgs,
  resolveRestoreRequest,
  readRegistry,
  repoOf,
  findArchive,
  restore,
  runRestore,
};
