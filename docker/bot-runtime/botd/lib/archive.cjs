"use strict";

/**
 * myrmidon(1.6.5 BOT-DISK-H3c): archive class F — bundle/patch/untracked.tar
 * of a workspace copy plus retention of the archive directory.
 *
 * Contract: epic OPE-5306 document `contracts`, section C1 (layout) and the
 * design document `design` (class F: 30 days or 2 GiB per bot, oldest first).
 * Machine constants live in `packages/shared/src/myrmidon-bot-workspace.ts`
 * (`WS_ARCHIVE_DIR`); botd runs inside the bot container where Node.js is the
 * runtime of the tooling around hermes, so this module is plain Node.
 *
 * Layout of one archive entry (all files share the `<KEY>-<ts>` stem):
 *
 *   <KEY>-<ts>.bundle          git bundle of every ref not reachable from any
 *                              origin/* ref of the copy (unpushed commits)
 *   <KEY>-<ts>.patch           `git diff` of the worktree against its merge
 *                              base with origin (staged + unstaged + stash)
 *   <KEY>-<ts>.untracked.tar   untracked files, ignored ones excluded; absent
 *                              when the stream would exceed the untracked cap
 *   <KEY>-<ts>.manifest.json   {key, createdAt, sizeBytes, truncatedUntracked}
 *
 * `archiveCopy()` verifies the bundle (`git bundle verify`) BEFORE reporting
 * ok: the caller deletes the copy only on `{ok:true}`. A failed verify deletes
 * the partial archive and returns `{ok:false, error}` — the copy must stay.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Contract constants (kept in sync with packages/shared/myrmidon-bot-workspace.ts). */
const WS_ARCHIVE_DIR_DEFAULT = "/data/hermes/.myrmidon/archive";

/** Cap of the untracked.tar stream (contract: 200 МБ). */
const UNTRACKED_CAP_BYTES_DEFAULT = 200 * 1024 * 1024;

/** Retention of class F: 30 days or 2 GiB per bot, oldest first (design class F). */
const RETENTION_MAX_AGE_MS_DEFAULT = 30 * 24 * 60 * 60 * 1000;
const RETENTION_CAP_BYTES_DEFAULT = 2 * 1024 * 1024 * 1024;

const GIT_TIMEOUT_MS = 120_000;
const TAR_TIMEOUT_MS = 600_000;

/**
 * Timestamp for archive filenames: ISO-ish, filesystem-safe, second precision.
 * @param {Date} now
 */
function archiveTimestamp(now) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
}

/**
 * Run a command; never throws. @returns {{status:number, stdout:string, stderr:string, error?:string}}
 */
function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
  if (res.error) {
    return { status: -1, stdout: "", stderr: "", error: String(res.error.message || res.error) };
  }
  return { status: res.status == null ? -1 : res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
}

/**
 * git in the copy; returns the run result. All git invocations go through this
 * so the timeout and the -C path stay in one place.
 */
function git(copyPath, args, opts) {
  return run("git", ["-C", copyPath, ...args], { timeout: GIT_TIMEOUT_MS, ...opts });
}

/**
 * List refs of the copy that hold commits not reachable from any origin/* ref.
 * Returns {ok, refs:[{ref, sha}], error?}.
 */
function unpushedRefs(copyPath) {
  // Local heads and the stash ref, minus everything origin already knows.
  const heads = git(copyPath, ["for-each-ref", "--format=%(refname)%09%(objectname)", "refs/heads", "refs/stash"]);
  if (heads.status !== 0) return { ok: false, refs: [], error: `git for-each-ref: ${heads.stderr.trim()}` };
  const refs = [];
  for (const line of heads.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [ref, sha] = line.split("\t");
    refs.push({ ref, sha });
  }
  if (refs.length === 0) return { ok: true, refs: [] };
  // A ref is "unpushed" when it has commits origin/* does not reach. `git
  // rev-list <ref> --not --remotes=origin` non-empty means unpushed.
  const kept = [];
  for (const r of refs) {
    const rl = git(copyPath, ["rev-list", "--max-count=1", r.ref, "--not", "--remotes=origin"]);
    if (rl.status !== 0) return { ok: false, refs: [], error: `git rev-list ${r.ref}: ${rl.stderr.trim()}` };
    if (rl.stdout.trim() !== "") kept.push(r);
  }
  return { ok: true, refs: kept };
}

/**
 * The merge base of HEAD with the best-matching origin ref (origin/HEAD first,
 * else the first origin/* that shares history). null when none exists.
 */
function originMergeBase(copyPath) {
  const head = git(copyPath, ["rev-parse", "--verify", "HEAD"]);
  if (head.status !== 0) return null;
  const tryRefs = ["origin/HEAD"];
  const remotes = git(copyPath, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (remotes.status === 0) {
    for (const r of remotes.stdout.split("\n")) {
      const t = r.trim();
      if (t && t !== "origin/HEAD") tryRefs.push(t);
    }
  }
  for (const ref of tryRefs) {
    const mb = git(copyPath, ["merge-base", "HEAD", ref]);
    if (mb.status === 0 && mb.stdout.trim()) return mb.stdout.trim();
  }
  return null;
}

/**
 * Write the patch file: worktree diff against the origin merge base, including
 * staged and unstaged changes. Stash diffs are appended when present. Returns
 * {ok, error?}.
 */
function writePatch(copyPath, patchPath) {
  const base = originMergeBase(copyPath);
  const fd = fs.openSync(patchPath, "w");
  try {
    const args = base ? ["diff", "--binary", base] : ["diff", "--binary", "HEAD"];
    const diff = spawnSync("git", ["-C", copyPath, ...args], { timeout: GIT_TIMEOUT_MS });
    if (diff.status !== 0) return { ok: false, error: `git diff: ${String(diff.stderr).trim()}` };
    fs.writeSync(fd, diff.stdout);
    // Staged changes on top of HEAD (or base) are covered by diffing against
    // the base; but an unborn/edge case: also append `git diff --cached` when
    // HEAD exists and base was used, since `git diff <base>` ignores the index.
    if (base) {
      const staged = spawnSync("git", ["-C", copyPath, "diff", "--binary", "--cached", base], { timeout: GIT_TIMEOUT_MS });
      if (staged.status === 0 && staged.stdout.length > 0) fs.writeSync(fd, staged.stdout);
    }
    // Stash entries: one diff per stash against its first parent.
    const stash = git(copyPath, ["stash", "list", "--format=%H"]);
    if (stash.status === 0) {
      for (const sha of stash.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const sd = spawnSync("git", ["-C", copyPath, "diff", "--binary", `${sha}^`, sha], { timeout: GIT_TIMEOUT_MS });
        if (sd.status === 0 && sd.stdout.length > 0) fs.writeSync(fd, sd.stdout);
      }
    }
    return { ok: true };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write the bundle of unpushed refs. An empty ref list is a valid archive of
 * a copy whose only unpushed work is in the worktree/stash (bundle carries
 * nothing; patch carries the diff), so we record HEAD explicitly — bundle
 * creation requires at least one ref, and verify must still prove the file
 * reads back. Returns {ok, error?}.
 */
function writeBundle(copyPath, bundlePath, refs) {
  const args = ["bundle", "create", bundlePath];
  const names = refs.map((r) => r.ref);
  if (names.length === 0) {
    const head = git(copyPath, ["rev-parse", "--verify", "HEAD"]);
    if (head.status !== 0) return { ok: false, error: "no refs to bundle and HEAD is unborn" };
    names.push("HEAD");
  }
  args.push(...names);
  const res = git(copyPath, args);
  if (res.status !== 0) return { ok: false, error: `git bundle create: ${res.stderr.trim()}` };
  return { ok: true };
}

/**
 * Stream untracked (non-ignored) files into <stem>.untracked.tar with a byte
 * cap. Returns {ok, truncated, error?}: truncated=true means the cap was hit
 * and NO tar file was kept (contract: on overflow only bundle+patch stay).
 */
function writeUntrackedTar(copyPath, tarPath, capBytes) {
  const list = git(copyPath, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: 64 * 1024 * 1024 });
  if (list.status !== 0) return { ok: false, truncated: false, error: `git ls-files: ${list.stderr.trim()}` };
  const files = list.stdout.split("\0").filter(Boolean);
  if (files.length === 0) return { ok: true, truncated: false };
  // Estimate size first (cheap stat), so the common oversized case never runs tar.
  let total = 0;
  for (const f of files) {
    try {
      const st = fs.lstatSync(path.join(copyPath, f));
      if (st.isFile()) total += st.size;
    } catch {
      /* vanished between ls-files and stat — tar will complain if it matters */
    }
    if (total > capBytes) return { ok: true, truncated: true };
  }
  // List file for tar: NUL-terminated paths, relative to the copy.
  const listFile = `${tarPath}.files`;
  fs.writeFileSync(listFile, Buffer.concat(files.map((f) => Buffer.from(f + "\0", "utf8"))));
  const tar = spawnSync(
    "tar",
    ["-cf", tarPath, "--null", "--files-from", listFile],
    { cwd: copyPath, timeout: TAR_TIMEOUT_MS, encoding: "buffer" },
  );
  try { fs.unlinkSync(listFile); } catch { /* best effort */ }
  if (tar.error) return { ok: false, truncated: false, error: `tar: ${String(tar.error.message || tar.error)}` };
  if (tar.status !== 0) {
    try { fs.unlinkSync(tarPath); } catch { /* best effort */ }
    return { ok: false, truncated: false, error: `tar: ${String(tar.stderr).toString("utf8").trim()}` };
  }
  try {
    if (fs.statSync(tarPath).size > capBytes) {
      fs.unlinkSync(tarPath);
      return { ok: true, truncated: true };
    }
  } catch (e) {
    return { ok: false, truncated: false, error: `tar stat: ${e.message}` };
  }
  return { ok: true, truncated: false };
}

/**
 * Verify a bundle file. When the copy is already half-torn-down the caller may
 * pass another repository path (or the bare base) as verifyRepo.
 * Returns {ok, error?}.
 */
function verifyBundle(bundlePath, verifyRepo) {
  const res = git(verifyRepo, ["bundle", "verify", bundlePath]);
  if (res.status !== 0) return { ok: false, error: `git bundle verify: ${res.stderr.trim() || res.stdout.trim()}` };
  return { ok: true };
}

function removeIfExists(p) {
  try { fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

/**
 * Archive one workspace copy into the class-F directory.
 *
 * @param {string} copyPath absolute path of the copy (a git worktree/clone)
 * @param {string} key issue key (PREFIX-123); used in the file stem only
 * @param {object} [opts]
 * @param {string} [opts.archiveDir] class-F directory (contract default)
 * @param {number} [opts.untrackedCapBytes] cap of untracked.tar (default 200 МБ)
 * @param {Date} [opts.now] clock injection for tests
 * @returns {{ok:true, key:string, stem:string, manifest:object, paths:object} | {ok:false, error:string}}
 */
function archiveCopy(copyPath, key, opts = {}) {
  const archiveDir = opts.archiveDir || process.env.MYRMIDON_ARCHIVE_DIR || WS_ARCHIVE_DIR_DEFAULT;
  const cap = opts.untrackedCapBytes || UNTRACKED_CAP_BYTES_DEFAULT;
  const now = opts.now || new Date();

  if (!fs.existsSync(path.join(copyPath, ".git"))) {
    return { ok: false, error: `${copyPath}: not a git repository` };
  }
  fs.mkdirSync(archiveDir, { recursive: true });

  const stem = `${key}-${archiveTimestamp(now)}`;
  const paths = {
    bundle: path.join(archiveDir, `${stem}.bundle`),
    patch: path.join(archiveDir, `${stem}.patch`),
    untracked: path.join(archiveDir, `${stem}.untracked.tar`),
    manifest: path.join(archiveDir, `${stem}.manifest.json`),
  };
  const written = [];

  const cleanup = () => {
    for (const p of written) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
  };

  const up = unpushedRefs(copyPath);
  if (!up.ok) return { ok: false, error: up.error };

  const b = writeBundle(copyPath, paths.bundle, up.refs);
  if (!b.ok) { cleanup(); return { ok: false, error: b.error }; }
  written.push(paths.bundle);

  const p = writePatch(copyPath, paths.patch);
  if (!p.ok) { cleanup(); return { ok: false, error: p.error }; }
  written.push(paths.patch);

  const t = writeUntrackedTar(copyPath, paths.untracked, cap);
  if (!t.ok) { cleanup(); return { ok: false, error: t.error }; }
  if (!t.truncated && fs.existsSync(paths.untracked)) written.push(paths.untracked);

  // Verify BEFORE ok: a bundle that does not read back is no archive at all —
  // the caller must keep the copy.
  const v = verifyBundle(paths.bundle, copyPath);
  if (!v.ok) { cleanup(); return { ok: false, error: v.error }; }

  let sizeBytes = 0;
  for (const pth of [paths.bundle, paths.patch, ...(t.truncated ? [] : [paths.untracked])]) {
    try { sizeBytes += fs.statSync(pth).size; } catch { /* counted best-effort */ }
  }
  const manifest = {
    key,
    createdAt: now.toISOString(),
    sizeBytes,
    truncatedUntracked: t.truncated,
  };
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  written.push(paths.manifest);
  sizeBytes += fs.statSync(paths.manifest).size;
  manifest.sizeBytes = sizeBytes;
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  return { ok: true, key, stem, manifest, paths };
}

/**
 * List archive entries (grouped by stem) with total size and age.
 * @returns {Array<{stem:string, key:string, createdAt:string|null, sizeBytes:number, files:string[]}>}
 */
function listArchives(archiveDir) {
  let names;
  try {
    names = fs.readdirSync(archiveDir);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const stems = new Map();
  for (const name of names) {
    const m = name.match(/^(.+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)\.(bundle|patch|untracked\.tar|manifest\.json)$/);
    if (!m) continue;
    const [, stem] = m;
    if (!stems.has(stem)) stems.set(stem, []);
    stems.get(stem).push(path.join(archiveDir, name));
  }
  const entries = [];
  for (const [stem, files] of stems) {
    let sizeBytes = 0;
    let createdAt = null;
    let key = stem.replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/, "");
    for (const f of files) {
      try { sizeBytes += fs.statSync(f).size; } catch { /* race with a cleaner */ }
      if (f.endsWith(".manifest.json")) {
        try {
          const mf = JSON.parse(fs.readFileSync(f, "utf8"));
          if (mf.createdAt) createdAt = mf.createdAt;
          if (mf.key) key = mf.key;
        } catch { /* corrupt manifest — keep filename-derived values */ }
      }
    }
    if (!createdAt) {
      const ts = stem.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z$/);
      if (ts) createdAt = `${ts[1]}-${ts[2]}-${ts[3]}T${ts[4]}:${ts[5]}:${ts[6]}.000Z`;
    }
    entries.push({ stem, key, createdAt, sizeBytes, files: files.sort() });
  }
  entries.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  return entries;
}

/**
 * Retention of class F (design: 30 сут или cap 2 ГиБ на бота, старые первыми).
 * Deletes whole stems (all files of one archive), oldest first, until both the
 * age and the size budget hold.
 *
 * @param {object} [opts]
 * @param {string} [opts.archiveDir]
 * @param {number} [opts.maxAgeMs] default 30 days
 * @param {number} [opts.capBytes] default 2 GiB
 * @param {Date} [opts.now]
 * @returns {{ok:true, removed:string[], kept:string[], freedBytes:number}}
 */
function pruneArchives(opts = {}) {
  const archiveDir = opts.archiveDir || process.env.MYRMIDON_ARCHIVE_DIR || WS_ARCHIVE_DIR_DEFAULT;
  const maxAgeMs = opts.maxAgeMs || RETENTION_MAX_AGE_MS_DEFAULT;
  const capBytes = opts.capBytes || RETENTION_CAP_BYTES_DEFAULT;
  const now = opts.now || new Date();

  const entries = listArchives(archiveDir); // oldest first
  const removed = [];
  const kept = [];
  let freedBytes = 0;

  let total = entries.reduce((s, e) => s + e.sizeBytes, 0);
  for (const e of entries) {
    const ageMs = e.createdAt ? now.getTime() - Date.parse(e.createdAt) : Number.POSITIVE_INFINITY;
    const overAge = ageMs > maxAgeMs;
    const overCap = total > capBytes;
    if (overAge || overCap) {
      for (const f of e.files) {
        try { fs.unlinkSync(f); } catch { /* best effort */ }
      }
      removed.push(e.stem);
      freedBytes += e.sizeBytes;
      total -= e.sizeBytes;
    } else {
      kept.push(e.stem);
    }
  }
  return { ok: true, removed, kept, freedBytes };
}

module.exports = {
  archiveCopy,
  pruneArchives,
  listArchives,
  verifyBundle,
  archiveTimestamp,
  WS_ARCHIVE_DIR_DEFAULT,
  UNTRACKED_CAP_BYTES_DEFAULT,
  RETENTION_MAX_AGE_MS_DEFAULT,
  RETENTION_CAP_BYTES_DEFAULT,
};
