"use strict";
// myrmidon(1.6.5 BOT-DISK-H2a): class-D base repositories — one bare repository
// per (bot, owner/repo) under <home>/git-base/<owner>/<repo>.git.
//
// ensureBase(): git init --bare, origin without userinfo (credentials come from
// git-credential-paperclip, never from the URL or the config), the standard
// refspec, fetch.prune, gc.auto=0, gc.pruneExpire=never; fetch at most every
// MYRMIDON_WS_REFRESH_SEC (default 900 s). A new base beyond the limit of 8 is
// refused with exit code 4. The real git is MYRMIDON_GIT_REAL.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const L = require("./layout.js");

const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const FETCH_STAMP = "myr-ws-fetched";

class MyrWsError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "MyrWsError";
    this.exitCode = exitCode;
  }
}

function gitReal(env) {
  return env[L.ENV.gitReal] || L.DEFAULT_GIT_REAL;
}

function runGit(env, cwd, args, opts = {}) {
  const r = spawnSync(gitReal(env), args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs || 600_000,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
  });
  return r;
}

function mustGit(env, cwd, args, exitCode) {
  const r = runGit(env, cwd, args);
  if (r.error || r.status !== 0) {
    const why = (r.error && r.error.message) || String(r.stderr || "").trim().split("\n").slice(-3).join(" | ");
    throw new MyrWsError(exitCode, `git ${args[0]} failed: ${why}`);
  }
  return r;
}

function refreshSec(env) {
  const raw = env[L.ENV.refreshSec];
  if (raw === undefined || raw === "") return L.WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : L.WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC;
}

/** Bases already on disk: <root>/<owner>/<repo>.git directories. */
function listBases(env = process.env) {
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
      if (r.isDirectory() && r.name.endsWith(".git")) out.push(`${o.name}/${r.name.slice(0, -4)}`);
    }
  }
  return out;
}

function originUrl(parsed, env) {
  const root = (env[L.ENV.remoteBase] || L.DEFAULT_REMOTE_BASE).replace(/\/+$/, "");
  return `${root}/${parsed.owner}/${parsed.repo}.git`;
}

function configureBase(env, dir, url) {
  const set = (k, v) => mustGit(env, dir, ["config", k, v], EXIT.usage);
  mustGit(env, dir, ["remote", "add", "origin", url], EXIT.usage);
  // remote add writes the default heads->heads refspec; replace it.
  mustGit(env, dir, ["config", "--replace-all", "remote.origin.fetch", L.WS_GIT_BASE_REFSPEC], EXIT.usage);
  set("fetch.prune", "true");
  set("gc.auto", "0");
  set("gc.pruneExpire", "never");
}

function fetchBase(env, dir) {
  const r = runGit(env, dir, ["fetch", "--prune", "origin"]);
  if (r.error || r.status !== 0) {
    const why = (r.error && r.error.message) || String(r.stderr || "").trim().split("\n").slice(-3).join(" | ");
    throw new MyrWsError(EXIT.network, `fetch failed: ${why}`);
  }
  fs.writeFileSync(path.join(dir, FETCH_STAMP), `${Date.now()}\n`);
}

function lastFetchMs(dir) {
  try {
    return fs.statSync(path.join(dir, FETCH_STAMP)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Creates the base of owner/repo when absent and fetches it when stale.
 * Returns { path, repo, created, fetched }. Throws MyrWsError (exitCode 2
 * invalid repo, 4 limit, 5 fetch failure).
 */
function ensureBase(repoInput, opts = {}) {
  const env = opts.env || process.env;
  const now = opts.now ? opts.now() : Date.now();
  const parsed = L.parseRepo(repoInput);
  if (!parsed) throw new MyrWsError(EXIT.usage, `invalid repository "${String(repoInput)}": expected owner/repo`);
  const dir = L.basePath(parsed, env);
  // Defence in depth: the resolved path must stay inside the base root.
  const root = path.resolve(L.gitBaseRoot(env));
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    throw new MyrWsError(EXIT.usage, `invalid repository "${String(repoInput)}"`);
  }

  let created = false;
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    const existing = listBases(env);
    if (existing.length >= L.WS_GIT_BASE_LIMIT) {
      throw new MyrWsError(
        EXIT.baseLimit,
        `base limit reached (${existing.length} of ${L.WS_GIT_BASE_LIMIT}): remove a base under ${L.gitBaseRoot(env)} before adding ${parsed.slug}; existing: ${existing.join(", ")}`,
      );
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    try {
      mustGit(env, undefined, ["init", "--bare", "--quiet", dir], EXIT.usage);
      configureBase(env, dir, originUrl(parsed, env));
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    created = true;
  }

  const stale = now - lastFetchMs(dir) >= refreshSec(env) * 1000;
  let fetched = false;
  if (created || stale) {
    try {
      fetchBase(env, dir);
      fetched = true;
    } catch (e) {
      // A base that never fetched holds nothing and must not eat the limit.
      if (created) fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  return { path: dir, repo: parsed.slug, created, fetched };
}

module.exports = { ensureBase, listBases, MyrWsError, EXIT, FETCH_STAMP };
