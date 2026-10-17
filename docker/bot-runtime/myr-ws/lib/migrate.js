"use strict";
// myrmidon(1.6.5 BOT-DISK-H2f): one-shot, idempotent migration of the old
// object mirror <home>/git-objects/<owner>/<repo>.git (refspec
// +refs/heads/*:refs/heads/*) into the class-D base <home>/git-base/<owner>/<repo>.git
// (standard refspec, contract C1).
//
// The mirror is only read: objects are hardlinked (copied across devices) into
// the base, so old clones whose objects/info/alternates point at the mirror keep
// working. Branch heads become refs/remotes/origin/*. After
// `git fsck --connectivity-only` passes the mirror gets a `.migrated` marker; it is
// never deleted here (botd removes it later by its rules). On a failed fsck the
// mirror is not marked and the call throws MyrWsError (exit code != 0).

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("./layout.js");
const { MyrWsError } = require("./errors.js");

// Exit codes: MYR_WS_EXIT of contract C2 (mirrored, as in base.js).
const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const MIGRATED_MARKER = ".migrated";
const MIRROR_DIR = "git-objects";

function gitReal(env) {
  return env[L.ENV.gitReal] || L.DEFAULT_GIT_REAL;
}

function git(env, cwd, args, input) {
  return spawnSync(gitReal(env), args, {
    cwd,
    encoding: "utf8",
    input,
    timeout: 600_000,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function why(r) {
  return (r.error && r.error.message) || String(r.stderr || "").trim().split("\n").slice(-3).join(" | ");
}

function mustGit(env, cwd, args, input) {
  const r = git(env, cwd, args, input);
  if (r.error || r.status !== 0) throw new MyrWsError(EXIT.usage, `git ${args[0]} failed: ${why(r)}`);
  return r;
}

function mirrorRoot(env) {
  return path.join(L.homeDir(env), MIRROR_DIR);
}

function mirrorPath(parsed, env) {
  return path.join(mirrorRoot(env), parsed.owner, `${parsed.repo}.git`);
}

/** Mirrors on disk: [{ slug, owner, repo, dir, migrated }]. */
function listMirrors(env = process.env) {
  const root = mirrorRoot(env);
  const out = [];
  let owners = [];
  try {
    owners = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const o of owners) {
    if (!o.isDirectory()) continue;
    let repos = [];
    try {
      repos = fs.readdirSync(path.join(root, o.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const r of repos) {
      if (!r.isDirectory() || !r.name.endsWith(".git")) continue;
      const parsed = L.parseRepo(`${o.name}/${r.name}`);
      if (!parsed) continue;
      const dir = path.join(root, o.name, r.name);
      if (!fs.existsSync(path.join(dir, "HEAD"))) continue;
      out.push({ ...parsed, dir, migrated: fs.existsSync(path.join(dir, MIGRATED_MARKER)) });
    }
  }
  return out;
}

function listBases(env) {
  const root = L.gitBaseRoot(env);
  const out = [];
  let owners = [];
  try {
    owners = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const o of owners) {
    if (!o.isDirectory()) continue;
    for (const r of fs.readdirSync(path.join(root, o.name), { withFileTypes: true })) {
      if (r.isDirectory() && r.name.endsWith(".git") && fs.existsSync(path.join(root, o.name, r.name, "HEAD"))) {
        out.push(`${o.name}/${r.name.slice(0, -4)}`);
      }
    }
  }
  return out;
}

/** Hardlinks src into dst (copy when linking is not possible); existing files stay. */
function linkTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) linkTree(s, d);
    else if (e.isFile() && !fs.existsSync(d)) {
      try {
        fs.linkSync(s, d);
      } catch {
        fs.copyFileSync(s, d);
      }
    }
  }
}

function configureBase(env, dir, parsed) {
  const root = (env[L.ENV.remoteBase] || L.DEFAULT_REMOTE_BASE).replace(/\/+$/, "");
  // The mirror's own remote URL is never reused: it may carry credentials.
  mustGit(env, dir, ["remote", "add", "origin", `${root}/${parsed.owner}/${parsed.repo}.git`]);
  mustGit(env, dir, ["config", "--replace-all", "remote.origin.fetch", L.WS_GIT_BASE_REFSPEC]);
  mustGit(env, dir, ["config", "fetch.prune", "true"]);
  mustGit(env, dir, ["config", "gc.auto", "0"]);
  mustGit(env, dir, ["config", "gc.pruneExpire", "never"]);
}

function countRefs(env, dir) {
  const r = mustGit(env, dir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin"]);
  return r.stdout.split("\n").filter((l) => l && l !== "refs/remotes/origin/HEAD").length;
}

function result(parsed, base, refs) {
  return { repo: parsed.slug, basePath: base, refs };
}

/**
 * Migrates the mirror of owner/repo. Returns the contract result
 * { repo, basePath, refs } (the CLI adds ok:true). Idempotent: a marked mirror
 * whose base exists is a no-op. Throws MyrWsError: 2 invalid name or failed
 * integrity check, 4 base limit, 6 no mirror (and no base).
 */
function migrate(repoInput, opts = {}) {
  const env = opts.env || process.env;
  const parsed = L.parseRepo(repoInput);
  if (!parsed) throw new MyrWsError(EXIT.usage, `invalid repository "${String(repoInput)}": expected owner/repo`);
  const mirror = mirrorPath(parsed, env);
  const base = L.basePath(parsed, env);
  const baseRoot = path.resolve(L.gitBaseRoot(env));
  if (!path.resolve(base).startsWith(baseRoot + path.sep)) {
    throw new MyrWsError(EXIT.usage, `invalid repository "${String(repoInput)}"`);
  }
  const baseExists = fs.existsSync(path.join(base, "HEAD"));
  const mirrorExists = fs.existsSync(path.join(mirror, "HEAD"));

  if (mirrorExists && fs.existsSync(path.join(mirror, MIGRATED_MARKER)) && baseExists) {
    return result(parsed, base, countRefs(env, base)); // already done: no-op
  }
  if (!mirrorExists) {
    if (baseExists) return result(parsed, base, countRefs(env, base)); // nothing to migrate
    throw new MyrWsError(EXIT.notFound, `no mirror ${mirror} and no base for ${parsed.slug}`);
  }

  // Build in a sibling directory and rename, so a failure leaves no half base.
  let target = base;
  let fresh = false;
  if (!baseExists) {
    const existing = listBases(env);
    if (existing.length >= L.WS_GIT_BASE_LIMIT) {
      throw new MyrWsError(
        EXIT.baseLimit,
        `base limit reached (${existing.length} of ${L.WS_GIT_BASE_LIMIT}): remove a base under ${L.gitBaseRoot(env)} before migrating ${parsed.slug}; existing: ${existing.join(", ")}`,
      );
    }
    target = `${base}.migrating`;
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(base), { recursive: true });
    mustGit(env, undefined, ["init", "--bare", "--quiet", target]);
    configureBase(env, target, parsed);
    fresh = true;
  }

  try {
    // Objects: packs and loose objects. info/alternates is not copied: the
    // base must be self-contained (fsck below proves it).
    const srcObjects = path.join(mirror, "objects");
    for (const e of fs.readdirSync(srcObjects, { withFileTypes: true })) {
      if (e.name === "info") continue;
      if (e.isDirectory()) linkTree(path.join(srcObjects, e.name), path.join(target, "objects", e.name));
    }
    if (fs.existsSync(path.join(mirror, "shallow")) && !fs.existsSync(path.join(target, "shallow"))) {
      fs.copyFileSync(path.join(mirror, "shallow"), path.join(target, "shallow"));
    }

    // Refs: heads of the mirror -> refs/remotes/origin/*; existing refs of the base win.
    const heads = mustGit(env, mirror, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"]).stdout
      .split("\n")
      .filter(Boolean);
    const cmds = [];
    for (const line of heads) {
      const [sha, ref] = line.split(" ");
      const name = ref.slice("refs/heads/".length);
      const dst = `refs/remotes/origin/${name}`;
      if (git(env, target, ["rev-parse", "--verify", "--quiet", dst]).status === 0) continue;
      cmds.push(`create ${dst} ${sha}\n`);
    }
    if (cmds.length) mustGit(env, target, ["update-ref", "--stdin"], cmds.join(""));

    const fsck = git(env, target, ["fsck", "--connectivity-only"]);
    if (fsck.error || fsck.status !== 0) {
      throw new MyrWsError(EXIT.usage, `integrity check of ${parsed.slug} failed, mirror left unmarked: ${why(fsck)}`);
    }
    if (fresh) fs.renameSync(target, base);
  } catch (e) {
    if (fresh) fs.rmSync(target, { recursive: true, force: true });
    throw e;
  }

  fs.writeFileSync(path.join(mirror, MIGRATED_MARKER), `${new Date().toISOString()}\n`);
  return result(parsed, base, countRefs(env, base));
}

/** Migrates every unmarked mirror; resolves to { results, errors:[{repo,exitCode,error}] }. */
function migrateAll(opts = {}) {
  const env = opts.env || process.env;
  const results = [];
  const errors = [];
  for (const m of listMirrors(env)) {
    if (m.migrated && fs.existsSync(path.join(L.basePath(m, env), "HEAD"))) continue;
    try {
      results.push(migrate(m.slug, { env }));
    } catch (e) {
      errors.push({ repo: m.slug, exitCode: Number.isInteger(e && e.exitCode) ? e.exitCode : 1, error: (e && e.message) || String(e) });
    }
  }
  return { results, errors };
}

/** CLI handler: `myr-ws migrate <owner/repo>` (cli.js wires it as COMMANDS.migrate). */
function command({ positionals, env }) {
  if (positionals.length !== 1) throw new MyrWsError(EXIT.usage, "usage: myr-ws migrate <owner/repo> [--json]");
  return migrate(positionals[0], { env });
}

module.exports = { migrate, migrateAll, listMirrors, command, MIGRATED_MARKER, MIRROR_DIR, MyrWsError };
