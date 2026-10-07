// myrmidon(1.6.5-BOT-DISK-H3c): botd class-F archive of unpushed work and its
// retention (design §2.3 row F, contract C1 layout).
//
// Layout (read by `myr-ws restore`, lib/restore.js):
//   <archiveRoot>/<KEY>-<ts>.bundle          branch of the copy (+ stash) not on origin
//   <archiveRoot>/<KEY>-<ts>.patch           `git diff HEAD --binary` at archive time
//   <archiveRoot>/<KEY>-<ts>.untracked.tar   untracked files, ignored ones excluded
//   <archiveRoot>/manifest.json              {version:1, archives:[entry]}
//   entry = {key, repo?, bundle, patch, untrackedTar?, createdAt, sizeBytes,
//            truncatedUntracked}  (paths absolute, inside archiveRoot)
// <ts> is the compact UTC time of createdAt: 20261006T140100Z.
//
// `archive()` returns `{ ok: true, entry }` only after the bundle passed
// `git bundle verify` and the tar was listed back; otherwise `{ ok: false,
// reason }`, every file it wrote is removed and the manifest is untouched. The
// caller (botd) must NOT delete the copy unless it got ok:true.
//
// Plain Node (no dependencies), synchronous: one botd process, one copy at a time.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_ARCHIVE_ROOT = "/data/hermes/.myrmidon/archive";
export const UNTRACKED_CAP_BYTES = 200 * 1024 * 1024;
export const RETENTION_DAYS = 30;
export const RETENTION_CAP_BYTES = 2 * 1024 * 1024 * 1024;
export const MANIFEST_NAME = "manifest.json";

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;
// Legacy (non-registry) directories keep their own name as the archive key; it only has to be
// a safe file-name stem. Issue keys are a subset of it.
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_BUFFER = 1024 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function gitBin(opts) {
  return opts.gitBin || process.env.MYRMIDON_GIT_REAL || "git";
}

function run(cmd, args, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
  });
  if (r.error) throw new Error(`${cmd} ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} failed (${r.status}): ${String(r.stderr).trim().slice(0, 300)}`);
  }
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

export function compactTs(date) {
  return date.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
}

/** `owner/name` from an origin URL, never keeping credentials; undefined if unknown. */
export function repoFromUrl(url) {
  const m = /^(?:https?:\/\/(?:[^@/]*@)?|ssh:\/\/(?:[^@/]*@)?|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url).trim());
  if (!m) return undefined;
  const repo = `${m[1]}/${m[2]}`;
  return REPO_RE.test(repo) ? repo : undefined;
}

// --- manifest --------------------------------------------------------------

export function manifestPath(archiveRoot) {
  return path.join(archiveRoot, MANIFEST_NAME);
}

/** Reads the manifest. A broken one is moved aside (its files stay on disk) and an empty one is returned. */
export function readManifest(archiveRoot, now = new Date()) {
  const p = manifestPath(archiveRoot);
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, archives: [] };
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.archives)) return parsed;
  } catch {
    // fall through to quarantine
  }
  fs.renameSync(p, `${p}.corrupt-${compactTs(now)}`);
  return { version: 1, archives: [] };
}

function writeManifest(archiveRoot, manifest) {
  const p = manifestPath(archiveRoot);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

function entryFiles(entry) {
  return [entry.bundle, entry.patch, entry.untrackedTar, entry.dirTar].filter((f) => typeof f === "string" && f);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// --- archive ---------------------------------------------------------------

/**
 * `git bundle verify` only checks the header and prerequisites, so it also
 * passes a truncated pack. The pack itself is checked by unbundling into a
 * throwaway bare repo that borrows the copy's objects (alternates): index-pack
 * validates every object and nothing is written into the copy's repository.
 */
function verifyBundle(git, copyPath, bundle, scratchRoot) {
  run(git, ["-C", copyPath, "bundle", "verify", bundle]);
  const common = path.resolve(copyPath, run(git, ["-C", copyPath, "rev-parse", "--git-common-dir"]).stdout.trim());
  const tmp = fs.mkdtempSync(path.join(scratchRoot, ".verify-"));
  try {
    run(git, ["init", "-q", "--bare", tmp]);
    fs.writeFileSync(path.join(tmp, "objects", "info", "alternates"), `${path.join(common, "objects")}\n`);
    run(git, ["-C", tmp, "bundle", "unbundle", bundle]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function listUntracked(copyPath, opts) {
  const out = run(gitBin(opts), ["-C", copyPath, "ls-files", "--others", "--exclude-standard", "-z"]).stdout;
  return out.split("\0").filter(Boolean);
}

function totalSize(copyPath, files) {
  let sum = 0;
  for (const f of files) {
    try {
      sum += fs.lstatSync(path.join(copyPath, f)).size;
    } catch {
      // vanished between ls-files and lstat: not part of the archive
    }
  }
  return sum;
}

/**
 * Archives the unpushed work of a task copy.
 * @param {string} copyPath worktree/clone directory
 * @param {string} key issue key (ABC-101)
 * @param {{archiveRoot?:string, repo?:string, now?:Date, untrackedCapBytes?:number, gitBin?:string, looseKey?:boolean}} [opts]
 *   `looseKey`: accept any safe file-name stem as the key (legacy directories that are not named after an issue)
 * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
 */
export function archive(copyPath, key, opts = {}) {
  const archiveRoot = opts.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  const cap = opts.untrackedCapBytes ?? UNTRACKED_CAP_BYTES;
  const now = opts.now || new Date();
  const keyRe = opts.looseKey ? SAFE_KEY_RE : ISSUE_KEY_RE;
  if (typeof key !== "string" || !keyRe.test(key)) return { ok: false, reason: `invalid issue key ${JSON.stringify(key)}` };
  if (typeof copyPath !== "string" || !fs.existsSync(path.join(copyPath, ".git"))) {
    return { ok: false, reason: `${copyPath} is not a git working copy` };
  }
  const written = [];
  try {
    fs.mkdirSync(archiveRoot, { recursive: true });
    const git = gitBin(opts);

    let ts = new Date(now.getTime());
    let base;
    for (;;) {
      base = path.join(archiveRoot, `${key}-${compactTs(ts)}`);
      if (!fs.existsSync(`${base}.bundle`) && !fs.existsSync(`${base}.patch`)) break;
      ts = new Date(ts.getTime() + 1000);
    }
    const bundle = `${base}.bundle`;
    const patch = `${base}.patch`;
    const tar = `${base}.untracked.tar`;

    // 1. bundle: the copy's branch (and the key's task branch, and the stash)
    //    minus everything already on origin.
    const branch = run(git, ["-C", copyPath, "symbolic-ref", "-q", "--short", "HEAD"], { allowFail: true }).stdout.trim();
    const tips = [];
    const addRef = (ref) => {
      if (!tips.includes(ref) && run(git, ["-C", copyPath, "rev-parse", "-q", "--verify", ref], { allowFail: true }).status === 0) tips.push(ref);
    };
    if (branch) addRef(`refs/heads/${branch}`);
    else addRef("HEAD");
    addRef(`refs/heads/bot/${key}`);
    addRef("refs/stash");
    written.push(bundle);
    const created = run(git, ["-C", copyPath, "bundle", "create", bundle, ...tips, "--not", "--remotes=origin"], { allowFail: true });
    let hasBundle = created.status === 0;
    if (!hasBundle) {
      // "empty bundle": nothing beyond origin. Anything else is a real failure.
      if (!/empty bundle/i.test(created.stderr)) throw new Error(`bundle create failed: ${created.stderr.trim().slice(0, 300)}`);
      fs.rmSync(bundle, { force: true });
    }

    // 2. patch: tracked changes, staged and unstaged, against HEAD.
    written.push(patch);
    const diff = run(git, ["-C", copyPath, "diff", "HEAD", "--binary"]).stdout;
    fs.writeFileSync(patch, diff);

    // 3. untracked files without ignored ones; over the cap only bundle+patch.
    const untracked = listUntracked(copyPath, opts);
    let untrackedTar;
    let truncatedUntracked = false;
    if (untracked.length > 0) {
      if (totalSize(copyPath, untracked) > cap) {
        truncatedUntracked = true;
      } else {
        written.push(tar);
        run("tar", ["-cf", tar, "-C", copyPath, "--null", "-T", "-"], { input: untracked.join("\0") + "\0" });
        untrackedTar = tar;
      }
    }

    // 4. readability check BEFORE ok.
    if (hasBundle) verifyBundle(git, copyPath, bundle, archiveRoot);
    if (untrackedTar) {
      const listed = run("tar", ["-tf", untrackedTar]).stdout.split("\n").filter(Boolean).length;
      if (listed < untracked.length) throw new Error(`untracked.tar lists ${listed} of ${untracked.length} files`);
    }

    // 5. manifest last: an entry exists only for an archive that verified.
    const repo = opts.repo || repoFromUrl(run(git, ["-C", copyPath, "remote", "get-url", "origin"], { allowFail: true }).stdout);
    const files = [hasBundle ? bundle : undefined, patch, untrackedTar].filter(Boolean);
    const entry = {
      key,
      ...(repo ? { repo } : {}),
      ...(hasBundle ? { bundle } : {}),
      patch,
      ...(untrackedTar ? { untrackedTar } : {}),
      createdAt: now.toISOString(),
      sizeBytes: files.reduce((s, f) => s + sizeOf(f), 0),
      truncatedUntracked,
    };
    const manifest = readManifest(archiveRoot, now);
    manifest.archives.push(entry);
    writeManifest(archiveRoot, manifest);
    return { ok: true, entry };
  } catch (e) {
    for (const f of written) fs.rmSync(f, { force: true });
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Archives a directory that is not a git working copy (a legacy task directory
 * without `.git`) as one tar. `.git` is never part of it. Layout:
 * `<archiveRoot>/<name>-<ts>.dir.tar`, manifest entry `{key, dirTar, createdAt,
 * sizeBytes, truncatedUntracked:false}`. Same contract as `archive()`: ok:true only
 * after the tar was listed back; otherwise nothing is left behind.
 * @returns {{ok:true, entry:object}|{ok:false, reason:string}}
 */
export function archiveTree(dirPath, key, opts = {}) {
  const archiveRoot = opts.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  const now = opts.now || new Date();
  if (typeof key !== "string" || !SAFE_KEY_RE.test(key)) return { ok: false, reason: `invalid archive key ${JSON.stringify(key)}` };
  let tar;
  try {
    if (!fs.statSync(dirPath).isDirectory()) return { ok: false, reason: `${dirPath} is not a directory` };
    fs.mkdirSync(archiveRoot, { recursive: true });
    let ts = new Date(now.getTime());
    for (;;) {
      tar = path.join(archiveRoot, `${key}-${compactTs(ts)}.dir.tar`);
      if (!fs.existsSync(tar)) break;
      ts = new Date(ts.getTime() + 1000);
    }
    run("tar", ["-cf", tar, "--exclude=.git", "-C", dirPath, "."]);
    run("tar", ["-tf", tar]);
    const entry = { key, dirTar: tar, createdAt: now.toISOString(), sizeBytes: sizeOf(tar), truncatedUntracked: false };
    const manifest = readManifest(archiveRoot, now);
    manifest.archives.push(entry);
    writeManifest(archiveRoot, manifest);
    return { ok: true, entry };
  } catch (e) {
    if (tar) fs.rmSync(tar, { force: true });
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Re-checks an existing archive entry: bundle verifies against `copyPath`'s
 * repository (or any repo that has the prerequisites), tar is listable.
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function verifyEntry(entry, opts = {}) {
  try {
    for (const f of entryFiles(entry)) if (!fs.existsSync(f)) return { ok: false, reason: `${f} is missing` };
    if (entry.bundle) {
      if (!opts.repoPath) return { ok: false, reason: "repoPath is required to verify a bundle" };
      verifyBundle(gitBin(opts), opts.repoPath, entry.bundle, path.dirname(entry.bundle));
    }
    if (entry.untrackedTar) run("tar", ["-tf", entry.untrackedTar]);
    if (entry.dirTar) run("tar", ["-tf", entry.dirTar]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// --- retention -------------------------------------------------------------

/**
 * Retention of one bot's archive directory: entries older than `maxAgeDays`
 * go first, then the oldest ones while the total exceeds `capBytes`.
 * `keep` (entry paths of bundles/patches or keys+createdAt) protects the entry
 * that was just created: the only copy of someone's work is never evicted by the cap.
 * Entries whose files are all gone are dropped from the manifest.
 * @param {string} archiveRoot
 * @param {{now?:Date, maxAgeDays?:number, capBytes?:number, keepCreatedAt?:string[]}} [opts]
 * @returns {{ok:true, removed:object[], remainingBytes:number, remaining:number}|{ok:false, reason:string}}
 */
export function retain(archiveRoot, opts = {}) {
  const now = opts.now || new Date();
  const maxAge = (opts.maxAgeDays ?? RETENTION_DAYS) * DAY_MS;
  const capBytes = opts.capBytes ?? RETENTION_CAP_BYTES;
  const keep = new Set(opts.keepCreatedAt || []);
  try {
    const manifest = readManifest(archiveRoot, now);
    const removed = [];
    const drop = (entry, why) => {
      for (const f of entryFiles(entry)) fs.rmSync(f, { force: true });
      removed.push({ key: entry.key, createdAt: entry.createdAt, sizeBytes: entry.sizeBytes, reason: why });
    };
    const withSize = (e) => ({ e, size: entryFiles(e).reduce((s, f) => s + sizeOf(f), 0) });

    let alive = [];
    for (const entry of manifest.archives) {
      if (!entry || !entry.createdAt || entryFiles(entry).every((f) => !fs.existsSync(f))) continue; // nothing left on disk
      const age = now.getTime() - Date.parse(entry.createdAt);
      if (age > maxAge && !keep.has(entry.createdAt)) drop(entry, "age");
      else alive.push(withSize(entry));
    }
    alive.sort((a, b) => Date.parse(a.e.createdAt) - Date.parse(b.e.createdAt));
    let total = alive.reduce((s, x) => s + x.size, 0);
    const rest = [];
    for (const x of alive) {
      if (total > capBytes && !keep.has(x.e.createdAt)) {
        drop(x.e, "cap");
        total -= x.size;
      } else rest.push(x);
    }
    alive = rest;
    if (removed.length > 0 || alive.length !== manifest.archives.length) {
      writeManifest(archiveRoot, { version: 1, archives: alive.map((x) => x.e) });
    }
    return { ok: true, removed, remainingBytes: total, remaining: alive.length };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
