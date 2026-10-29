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
const { MyrWsError } = require("./errors.js");

const EXIT = { ok: 0, usage: 2, quotaExceeded: 3, baseLimit: 4, network: 5, notFound: 6, unpushed: 7 };
const FETCH_STAMP = "myr-ws-fetched";

function gitReal(env) {
  if (env && env[L.ENV.gitReal]) return env[L.ENV.gitReal];
  if (fs.existsSync(L.DEFAULT_GIT_REAL)) return L.DEFAULT_GIT_REAL;
  if (fs.existsSync("/usr/bin/git")) return "/usr/bin/git";
  return "git";
}

function runGit(env, cwd, args, opts = {}) {
  const r = spawnSync(gitReal(env), args, {
    cwd,
    encoding: "utf8",
    timeout: opts.timeoutMs || 600_000,
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
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

function findMirror(parsed, env) {
  const root = env.MYRMIDON_GIT_MIRROR_ROOT || "/cache/git";
  const candidates = [
    path.join(root, `${parsed.owner}/${parsed.repo}.git`),
    path.join(root, `${parsed.slug}.git`),
  ];

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "HEAD")) && fs.existsSync(path.join(c, "objects"))) {
      return c;
    }
  }
  return null;
}

function withSyncLock(dir, fn) {
  const lockPath = path.join(dir, "sync-mirror.lock");
  let fd = null;
  const startTime = Date.now();
  while (Date.now() - startTime < 5000) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 30000) {
            fs.rmSync(lockPath, { force: true });
            continue;
          }
        } catch {
          // ignore
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      } else {
        break;
      }
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    }
  }
}

function syncMirrorAlternates(env, dir, parsed) {
  try {
    const mirror = findMirror(parsed, env);
    if (!mirror) return null;
    const objectsDir = path.join(mirror, "objects");
    if (!fs.existsSync(objectsDir)) return null;

    const targetObjectsDir = fs.existsSync(path.join(dir, ".git", "objects"))
      ? path.join(dir, ".git", "objects")
      : path.join(dir, "objects");

    const alternatesFile = path.join(targetObjectsDir, "info", "alternates");
    const targetLine = `${objectsDir}\n`;
    let existing = "";
    try {
      existing = fs.readFileSync(alternatesFile, "utf8");
    } catch {
      // does not exist yet
    }
    const lines = existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && fs.existsSync(l));
    const cleanExisting = lines.join("\n");
    if (!lines.includes(objectsDir)) {
      return withSyncLock(dir, () => {
        fs.mkdirSync(path.dirname(alternatesFile), { recursive: true });
        const revertAlternates = () => {
          try {
            if (cleanExisting) {
              fs.writeFileSync(alternatesFile, cleanExisting + "\n", "utf8");
            } else {
              fs.rmSync(alternatesFile, { force: true });
            }
          } catch {
            // ignore revert error
          }
        };
        fs.writeFileSync(
          alternatesFile,
          cleanExisting ? `${cleanExisting}\n${targetLine}` : targetLine,
          "utf8",
        );
        try {
          mustGit(env, dir, ["repack", "-a", "-d", "-l", "--keep-unreachable"], EXIT.usage);
        } catch (err) {
          revertAlternates();
          // Degrade gracefully on mirror repack failure
          return null;
        }
        return mirror;
      });
    }
    return mirror;
  } catch {
    // Degrade gracefully
    return null;
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
  let fetched = false;
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
      fetchBase(env, dir);
      fetched = true;
      try {
        syncMirrorAlternates(env, dir, parsed);
      } catch {
        // Graceful degradation: mirror sync failure does not break base creation
      }
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    created = true;
  } else {
    try {
      syncMirrorAlternates(env, dir, parsed);
    } catch {
      // Graceful degradation
    }
  }

  // refresh 0 means "always fetch": the stamp is written after the fetch, so
  // `now` taken at call start can precede its mtime and the difference go negative.
  const sec = refreshSec(env);
  const stale = !fetched && (sec === 0 || now - lastFetchMs(dir) >= sec * 1000);
  if (stale) {
    try {
      fetchBase(env, dir);
      fetched = true;
    } catch (e) {
      throw e;
    }
  }
  return { path: dir, repo: parsed.slug, created, fetched };
}

module.exports = { ensureBase, listBases, findMirror, syncMirrorAlternates, MyrWsError, EXIT, FETCH_STAMP };
