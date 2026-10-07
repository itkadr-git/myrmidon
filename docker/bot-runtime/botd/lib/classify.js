// myrmidon(1.6.5 BOT-DISK-H3d): botd classifier of everything under the bot's
// working roots. Walks /workspace, /scratch and /data/hermes/cache/scratch and
// puts every top-level directory into a class of the bot-disk contract (C1/C4):
//
//   E  task copy: a worktree of a class-D base, or a copy the registry lists
//   G  scratch: lives under a scratch root, removed by TTL
//   X  foreign: something the bot made around the lifecycle, with a `sign`
//      promisor | token | no-remote | trash | full-clone   (wsForeignSignSchema)
//
// Safety rules of this file:
//  * a bot's repository is never run through git for reading: a repository's own
//    config can name programs git then executes (core.fsmonitor, sshCommand,
//    aliases). Facts are read by parsing `.git/config` as text. The only git
//    call is `remote set-url`, on explicit paths, with a scrubbed environment.
//  * a secret never leaves this module: a URL userinfo is reduced to the flag
//    `sign: "token"`; the URL itself is not stored, logged or returned, and git's
//    own stderr is never copied into a result.
//  * nothing is deleted here. The module answers "what is it and what should the
//    rules do"; the rules (H3) act. The one write is the userinfo-free
//    `remote.origin.url` of the first pass (`fixTokenUrls`), which loses nothing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ROOTS = Object.freeze([
  "/workspace",
  "/scratch",
  "/data/hermes/cache/scratch",
]);
export const DEFAULT_GIT_BASE_DIR = "/data/hermes/.myrmidon/git-base";
export const DEFAULT_SCRATCH_TTL_SEC = 24 * 3600;
export const DEFAULT_FOREIGN_GRACE_SEC = 24 * 3600;
/** Upper bound of filesystem entries visited per directory; beyond it sizeBytes is null. */
export const WALK_ENTRY_LIMIT = 300000;

/** The task-copy root (C1 WS_WORKSPACE_ROOT); every other root is a scratch root. */
const WORKSPACE_ROOT_NAME = "/workspace";

// ---------------------------------------------------------------------------
// git config, read as text
// ---------------------------------------------------------------------------

/**
 * Minimal reader of a git config file: returns a list of
 * `{ section, sub, key, value }` with lower-cased section and key. Enough for
 * `[remote "origin"] url = …`, `promisor`, `partialclonefilter`, `[extensions]`.
 */
export function parseGitConfig(text) {
  const out = [];
  let section = null;
  let sub = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === "#" || line[0] === ";") continue;
    const head = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (head) {
      section = head[1].toLowerCase();
      sub = head[2] === undefined ? null : head[2].replace(/\\(.)/g, "$1");
      continue;
    }
    if (section === null) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    let value = kv[2] === undefined ? "true" : kv[2].trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    out.push({ section, sub, key: kv[1].toLowerCase(), value });
  }
  return out;
}

/**
 * True when `url` carries credentials in its authority: http(s)/ftp with any
 * userinfo, or another scheme whose userinfo has a password part. `git@host:o/r`
 * and `ssh://git@host/o/r` are not secrets.
 */
export function urlHasUserinfo(url) {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(String(url).trim());
  if (!m) return false;
  const at = m[2].lastIndexOf("@");
  if (at < 0) return false;
  const userinfo = m[2].slice(0, at);
  if (/^(https?|ftps?)$/i.test(m[1])) return userinfo.length > 0;
  return userinfo.includes(":");
}

/** The same URL without its userinfo; unchanged when it has none. */
export function stripUserinfo(url) {
  const s = String(url).trim();
  const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/s.exec(s);
  if (!m) return s;
  const at = m[2].lastIndexOf("@");
  return at < 0 ? s : m[1] + m[2].slice(at + 1) + m[3];
}

// ---------------------------------------------------------------------------
// repository facts (text only)
// ---------------------------------------------------------------------------

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Locate a repository directly inside `dir`: `.git` as a directory (a clone) or
 * as a file `gitdir: …` (a linked worktree). Returns null for anything else
 * (including a symbolic link, which is never followed).
 */
export function locateRepo(dir) {
  const dot = path.join(dir, ".git");
  let st;
  try {
    st = fs.lstatSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) return { kind: "clone", gitDir: dot, commonDir: dot };
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dot) ?? "");
    if (!m) return null;
    const gitDir = path.resolve(dir, m[1]);
    const rel = (readText(path.join(gitDir, "commondir")) ?? "").trim();
    const commonDir = rel ? path.resolve(gitDir, rel) : gitDir;
    return { kind: "worktree", gitDir, commonDir };
  }
  return null;
}

/**
 * Facts about the repository config, as flags: `remotes` (names), `promisor`,
 * `hasUserinfoUrl`, `originHasUserinfo`. URL values are not kept.
 */
export function readRepoFacts(repo) {
  const text = readText(path.join(repo.commonDir, "config"));
  const facts = {
    configReadable: text !== null,
    remotes: [],
    promisor: false,
    hasUserinfoUrl: false,
    originHasUserinfo: false,
    originPushHasUserinfo: false,
  };
  if (text === null) return facts;
  const names = new Set();
  for (const { section, sub, key, value } of parseGitConfig(text)) {
    if (section === "remote" && sub !== null) {
      if (key === "url" || key === "pushurl") {
        names.add(sub);
        if (urlHasUserinfo(value)) {
          facts.hasUserinfoUrl = true;
          if (sub === "origin") {
            if (key === "url") facts.originHasUserinfo = true;
            else facts.originPushHasUserinfo = true;
          }
        }
      }
      if (key === "promisor" && /^(true|yes|on|1)$/i.test(value)) facts.promisor = true;
      if (key === "partialclonefilter" && value) facts.promisor = true;
    }
    if (section === "extensions" && key === "partialclone" && value) facts.promisor = true;
  }
  facts.remotes = [...names];
  return facts;
}

// ---------------------------------------------------------------------------
// size and age: one bounded walk, symbolic links not followed
// ---------------------------------------------------------------------------

const SKIP_AGE_DIRS = new Set(["node_modules", ".pnpm-store"]);

/**
 * `{ sizeBytes, newestMs }` of a directory tree. `sizeBytes` is apparent size
 * with hard-linked files counted once (null when the walk hit the entry limit);
 * `newestMs` is the latest mtime/ctime of anything outside node_modules (a
 * hard-linked file is judged by mtime only: another link bumps its ctime).
 */
export function measureTree(root, limit = WALK_ENTRY_LIMIT) {
  let size = 0;
  let newest = 0;
  let count = 0;
  let truncated = false;
  const seen = new Set();
  const stack = [{ p: root, skipAge: false }];
  const touch = (st, skipAge) => {
    if (skipAge) return;
    const t = st.nlink > 1 && !st.isDirectory() ? st.mtimeMs : Math.max(st.mtimeMs, st.ctimeMs);
    if (t > newest) newest = t;
  };
  while (stack.length) {
    const { p, skipAge } = stack.pop();
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (++count > limit) {
      truncated = true;
      break;
    }
    touch(st, skipAge);
    if (st.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(p);
      } catch {
        continue;
      }
      for (const n of names) {
        stack.push({ p: path.join(p, n), skipAge: skipAge || SKIP_AGE_DIRS.has(n) });
      }
    } else if (st.isFile()) {
      if (st.nlink > 1) {
        const id = `${st.dev}:${st.ino}`;
        if (seen.has(id)) continue;
        seen.add(id);
      }
      size += st.size;
    }
  }
  return { sizeBytes: truncated ? null : size, newestMs: newest };
}

// ---------------------------------------------------------------------------
// the one git call: drop userinfo from remote.origin.url
// ---------------------------------------------------------------------------

function scrubbedGitEnv() {
  const env = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  return env;
}

/**
 * Rewrite `remote.origin.url` (and `remote.origin.pushurl`) without userinfo with
 * `git remote set-url`. The new value goes in as one argv element (no shell);
 * `GIT_DIR` points at the repository so no discovery runs. Returns
 * `{ ok, changed }`; neither the old nor the new URL is returned, and git's
 * output is dropped.
 */
export function setOriginUrlWithoutUserinfo(repo, facts, gitBin = "git") {
  const text = readText(path.join(repo.commonDir, "config"));
  if (text === null) return { ok: false, changed: false };
  const entries = parseGitConfig(text).filter(
    (e) => e.section === "remote" && e.sub === "origin" && (e.key === "url" || e.key === "pushurl"),
  );
  let ok = true;
  let changed = false;
  for (const e of entries) {
    if (!urlHasUserinfo(e.value)) continue;
    const args = ["remote", "set-url"];
    if (e.key === "pushurl") args.push("--push");
    args.push("origin", stripUserinfo(e.value));
    const r = spawnSync(gitBin, args, {
      env: { ...scrubbedGitEnv(), GIT_DIR: repo.commonDir },
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 20000,
    });
    if (r.status === 0) changed = true;
    else ok = false;
  }
  return { ok, changed };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Classify one directory. Returns `{ class, sign, repo, facts }` (no sizes).
 * Order of the signs, first match wins: trash, promisor, token, no-remote,
 * full-clone. `full-clone` applies only in the task-copy root: in a scratch root
 * a clone is an ordinary scratch copy.
 */
export function classifyDir(dir, ctx) {
  const name = path.basename(dir);
  const inWorkspace = path.dirname(dir) === ctx.workspaceRoot;
  if (name.startsWith(".trash-")) return { class: "X", sign: "trash", repo: null, facts: null };

  const repo = locateRepo(dir);
  const facts = repo ? readRepoFacts(repo) : null;
  if (repo && facts) {
    if (facts.promisor) return { class: "X", sign: "promisor", repo, facts };
    if (facts.hasUserinfoUrl) return { class: "X", sign: "token", repo, facts };
    if (facts.configReadable && facts.remotes.length === 0 && repo.kind === "clone") {
      return { class: "X", sign: "no-remote", repo, facts };
    }
  }

  if (inWorkspace) {
    const registered = ctx.registry.some((e) => e.class === "E" && path.resolve(e.path) === dir);
    const inBase = repo?.kind === "worktree" && isInside(repo.commonDir, ctx.gitBaseDir);
    if (registered || inBase) return { class: "E", sign: null, repo, facts };
    if (repo?.kind === "clone") return { class: "X", sign: "full-clone", repo, facts };
    // a task directory with no repository of its own: scratch rules (TTL)
    return { class: "G", sign: null, repo, facts };
  }
  return { class: "G", sign: null, repo, facts };
}

function listTopLevel(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    const p = path.join(root, n);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue; // never follow links
    if (n.startsWith(".") && !n.startsWith(".trash-")) continue; // .pnpm-store, .cache, …
    out.push(p);
  }
  return out;
}

/**
 * Walk the roots and classify every top-level directory.
 *
 * opts:
 *   roots            default DEFAULT_ROOTS
 *   registry         ws-registry.json `entries` (default [])
 *   desired          GET /bots/me/workspaces answer (`workspaces`, `grace`); null = board unreachable
 *   workspaceRoot    task-copy root (default /workspace; tests only)
 *   gitBaseDir       class-D root (default DEFAULT_GIT_BASE_DIR)
 *   now              ms epoch (default Date.now())
 *   scratchTtlSec    default grace.scratchTtlHours*3600 or 24 h
 *   foreignGraceSec  default grace.orphanHours*3600 or 24 h
 *   fixTokenUrls     rewrite remote.origin.url without userinfo (default false)
 *   gitBin           git binary for set-url (default "git")
 *
 * Returns `{ items, actions, fixedUrls, fixFailed }` where `items` are
 * `{ path, class, sign, ageSec, sizeBytes }` (sign null unless class X) and
 * `actions` are the instructions for the rules, one per item:
 *   `{ path, action: "keep"|"hold"|"remove", card, archive, reason }`
 * `card`: raise the foreign card now; `archive`: look for unpushed work and
 * archive it before removing (the directory is a repository).
 */
export function classifyAll(opts = {}) {
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const now = opts.now ?? Date.now();
  const desired = opts.desired ?? null;
  const grace = desired?.grace ?? {};
  const scratchTtlSec = opts.scratchTtlSec ?? (grace.scratchTtlHours ? grace.scratchTtlHours * 3600 : DEFAULT_SCRATCH_TTL_SEC);
  const foreignGraceSec = opts.foreignGraceSec ?? (grace.orphanHours ? grace.orphanHours * 3600 : DEFAULT_FOREIGN_GRACE_SEC);
  const ctx = {
    workspaceRoot: path.resolve(opts.workspaceRoot ?? WORKSPACE_ROOT_NAME),
    registry: opts.registry ?? [],
    gitBaseDir: path.resolve(opts.gitBaseDir ?? DEFAULT_GIT_BASE_DIR),
  };
  const live = new Map((desired?.workspaces ?? []).map((w) => [w.key, w]));

  const items = [];
  const actions = [];
  let fixedUrls = 0;
  let fixFailed = 0;

  for (const root of roots) {
    for (const dir of listTopLevel(path.resolve(root))) {
      const c = classifyDir(dir, ctx);

      if (opts.fixTokenUrls && c.repo && c.facts && (c.facts.originHasUserinfo || c.facts.originPushHasUserinfo)) {
        const r = setOriginUrlWithoutUserinfo(c.repo, c.facts, opts.gitBin);
        if (r.changed) fixedUrls += 1;
        if (!r.ok) fixFailed += 1;
      }

      const m = measureTree(dir);
      const ageSec = Math.max(0, Math.floor((now - m.newestMs) / 1000));
      items.push({
        path: dir,
        class: c.class,
        sign: c.sign,
        ageSec,
        sizeBytes: m.sizeBytes,
        mtimeMs: m.newestMs,
        isGit: c.repo !== null,
        inWorkspace: path.dirname(dir) === ctx.workspaceRoot,
      });
      actions.push(decide(dir, c, ageSec, { live, scratchTtlSec, foreignGraceSec, board: desired !== null }));
    }
  }
  return { items, actions, fixedUrls, fixFailed };
}

// ADVISORY ONLY. These per-item hints (card, hold) exist for the foreign card
// and the report; the decision to delete belongs to the rules (rules.js, H3b),
// fed through toInventory(). The executor must act on the rules' actions, never
// on `action: "remove"` from here.
function decide(dir, c, ageSec, p) {
  const archive = c.repo !== null;
  if (c.class === "E") return { path: dir, action: "keep", card: false, archive: false, reason: "task copy" };
  if (c.class === "G") {
    if (ageSec >= p.scratchTtlSec) {
      return { path: dir, action: "remove", card: false, archive, reason: "scratch past TTL" };
    }
    return { path: dir, action: "keep", card: false, archive: false, reason: "scratch within TTL" };
  }
  // X: the card is raised at once; removal waits for the board
  const key = path.basename(dir);
  const task = p.live.get(key);
  if (task && task.state === "active") {
    return { path: dir, action: "hold", card: true, archive: false, reason: `foreign (${c.sign}); live task, hold until closing` };
  }
  if (!p.board) {
    return { path: dir, action: "hold", card: true, archive: false, reason: `foreign (${c.sign}); board unreachable, nothing is removed` };
  }
  if (ageSec >= p.foreignGraceSec) {
    return { path: dir, action: "remove", card: true, archive, reason: `foreign (${c.sign}) past grace` };
  }
  return { path: dir, action: "keep", card: true, archive: false, reason: `foreign (${c.sign}) within grace` };
}

/**
 * Contract view (C4): `copies` (wsReportCopySchema) and `foreign`
 * (wsReportForeignSchema) of the disk report built from the items. The copy
 * key is the directory name; `clean`/`pushed` stay null (not read here).
 */
export function toReportParts(items, actions = []) {
  const reasonOf = new Map(actions.map((a) => [a.path, a.reason]));
  const copies = items.map((it) => {
    const copy = {
      path: it.path,
      class: it.class,
      key: path.basename(it.path),
      clean: null,
      pushed: null,
      sizeBytes: it.sizeBytes,
      ageSec: it.ageSec,
    };
    if (it.class === "X") copy.reason = String(reasonOf.get(it.path) ?? `foreign (${it.sign})`).slice(0, 500);
    return copy;
  });
  const foreign = items.filter((it) => it.class === "X").map((it) => ({ path: it.path, sign: it.sign }));
  return { copies, foreign };
}

/**
 * Adapter to the inventory of the deletion rules (rules.js, H3b):
 * `{ worktrees, scratch, bases, archives }`.
 *
 *  - class E -> `worktrees` (key = directory name);
 *  - class G and X -> `scratch` (the rules apply the TTL; the X card is
 *    raised by classifyAll's own actions, not by the rules);
 *  - `clean` / `pushed` are NOT computed (reading them needs git on a bot's
 *    repository, which this module never runs) and stay null: the rules treat
 *    null as "unsafe", so a repository is archived before it is removed;
 *  - `isGit` is true for a repository and for ANY directory in the task-copy
 *    root (a task directory without `.git` may hold work: archive it too);
 *  - `bases` / `archives` are not seen by the classifier: empty arrays.
 *
 * @param {object[]} items  `classifyAll(...).items`
 * @param {{ now?: number }} [opts]  only used when an item has no `mtimeMs`
 */
export function toInventory(items, opts = {}) {
  const now = opts.now ?? Date.now();
  const iso = (it) => {
    const ms = Number.isFinite(it.mtimeMs) ? it.mtimeMs : now - (it.ageSec ?? 0) * 1000;
    return new Date(ms).toISOString();
  };
  const worktrees = [];
  const scratch = [];
  for (const it of items ?? []) {
    const key = path.basename(it.path);
    if (it.class === "E") {
      worktrees.push({ key, path: it.path, dirMissing: false, clean: null, pushed: null, openedAt: iso(it) });
    } else {
      scratch.push({
        name: key,
        path: it.path,
        mtime: iso(it),
        isGit: it.isGit === true || it.inWorkspace === true,
        clean: null,
        pushed: null,
      });
    }
  }
  return { worktrees, scratch, bases: [], archives: [] };
}
