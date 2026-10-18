// myrmidon(1.6.5-BOT-DISK-H): botd helpers for directories that are NOT in the
// myr-ws registry (legacy task directories, class G and the foreign class X under
// /workspace). Pure of botd's closures so they can be tested on fixtures.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SKIP_NESTED_DIRS = new Set(["node_modules", ".pnpm-store", ".git"]);
const NESTED_MAX_DEPTH = 3;

/**
 * True when `dir` holds a usable git repository: `git rev-parse --git-dir` passes there.
 * A `.git` that fails it (a hollowed-out directory left by an old cleanup) is not a
 * repository and carries no git data; its files are plain files of the tree.
 * @param {string} dir
 * @param {string} [gitBin]
 */
export function isUsableRepo(dir, gitBin = process.env.MYRMIDON_BOTD_GIT || "git") {
  const r = spawnSync(gitBin, ["-C", dir, "rev-parse", "--git-dir"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)), LC_ALL: "C" },
  });
  return !r.error && r.status === 0;
}

/**
 * Repositories below `root` (not `root` itself): directories whose own `.git`
 * (directory or file) sits at most `maxDepth` levels down and passes `isRepo`
 * (a broken `.git` is not a repository). Links are not followed and
 * `node_modules` / `.pnpm-store` / `.git` are not entered.
 * @returns {string[]} absolute paths of the working trees, sorted
 */
export function findNestedGit(root, maxDepth = NESTED_MAX_DEPTH, isRepo = isUsableRepo) {
  const found = [];
  const walk = (dir, depth) => {
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && names.some((d) => d.name === ".git") && isRepo(dir)) found.push(dir);
    if (depth >= maxDepth) return;
    for (const d of names) {
      if (!d.isDirectory() || d.isSymbolicLink() || SKIP_NESTED_DIRS.has(d.name)) continue;
      walk(path.join(dir, d.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort();
}

const safeStem = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "x").slice(0, 80);

/**
 * Scratch part of the rules inventory: registry class-G copies plus every
 * class-G and class-X directory the classifier saw that the registry does not
 * list. X goes in with G so the rules apply the TTL/grace and the `activeKeys`
 * protection (a live task with the same key is never touched).
 * `mtime` comes from the classifier's age, which ignores `.git/`.
 * @param {object[]} entries `myr-ws list` entries
 * @param {object[]} items   `classifyAll().items`
 * @param {number} nowMs
 * @param {(p: string) => boolean} hasDotGit
 */
export function scratchInventory(entries, items, nowMs, hasDotGit) {
  const known = new Set(entries.map((e) => e.path));
  return [
    ...entries
      .filter((e) => e.class === "G")
      .map((e) => ({ name: e.key, path: e.path, mtime: e.openedAt, isGit: e.clean !== null, clean: e.clean, pushed: e.pushed })),
    ...items
      .filter((it) => (it.class === "G" || it.class === "X") && !known.has(it.path))
      .map((it) => ({
        name: path.basename(it.path),
        path: it.path,
        mtime: Number.isFinite(it.mtimeMs) ? it.mtimeMs : nowMs - (it.ageSec || 0) * 1000,
        isGit: hasDotGit(it.path) || (Array.isArray(it.nestedGit) && it.nestedGit.length > 0),
        nestedGit: Array.isArray(it.nestedGit) ? it.nestedGit : [],
        sizeBytes: it.sizeBytes ?? null,
        clean: null,
        pushed: null,
      })),
  ];
}

/** True when the registry (`ws-registry.json` entries) lists this exact path. */
export function inRegistry(registryEntries, p) {
  const abs = path.resolve(p);
  return (registryEntries || []).some((e) => e && typeof e.path === "string" && path.resolve(e.path) === abs);
}

/**
 * Archives first, then removes a directory the registry does not own. Every part must
 * archive and verify (ok:true, nothing truncated) before anything is removed: a failed,
 * missing or truncated archive of ANY part leaves the whole directory in place.
 * Parts: each nested repository (key `<KEY>--<relpath>`: bundle + patch + untracked),
 * the directory's own repository, and the rest of the tree as one tar without `.git`
 * (a `.git` that is not a repository is neither: its files go into the tree tar; always for a non-git directory, and next to the repositories when it has nested ones).
 * The writability probe runs BEFORE the first archive: a removal that would defer
 * (a foreign owner) must not spend an hour re-creating the same archive every pass.
 * @param {{path:string, key?:string}} a
 * @param {{archiveMod:object|null, isGit:(p:string)=>boolean, remove:(p:string)=>void, probe?:(p:string)=>void, archiveRoot?:string, nestedGit?:(p:string)=>string[], isRepo?:(p:string)=>boolean}} deps
 *   `probe` (optional): throws `{deferred, detail}` when the removal would defer; called before archiving
 * @returns {string} detail
 */
export function archiveThenRemove(a, deps) {
  const { archiveMod, isGit, remove, archiveRoot } = deps;
  if (!archiveMod || typeof archiveMod.archive !== "function") throw new Error("archive-incomplete: archive module is not in this image: not removed");
  if (typeof deps.probe === "function") {
    const refused = deps.probe(a.path);
    if (refused && refused.deferred) return { deferred: refused.deferred, detail: refused.detail };
  }
  const key = a.key || path.basename(a.path);
  const opts = { looseKey: true, ...(archiveRoot ? { archiveRoot } : {}) };
  const nested = (deps.nestedGit ?? findNestedGit)(a.path);
  const own = isGit(a.path) && (deps.isRepo ?? isUsableRepo)(a.path);
  const check = (what, r) => {
    if (!r || r.ok !== true) throw new Error(`archive-incomplete: ${what}: ${String((r && r.reason) || "unknown").slice(0, 300)}, not removed`);
    if (r.entry && r.entry.truncatedUntracked === true) {
      throw new Error(`archive-incomplete: ${what}: untracked files over the cap were not archived, not removed`);
    }
  };
  for (const n of nested) {
    const rel = path.relative(a.path, n) || ".";
    check(`nested repository ${rel}`, archiveMod.archive(n, safeStem(`${key}--${rel}`), opts));
  }
  if (own) check("repository", archiveMod.archive(a.path, key, opts));
  if (!own || nested.length > 0) {
    if (typeof archiveMod.archiveTree !== "function") throw new Error("archive-incomplete: archive module cannot archive a directory tree: not removed");
    check("directory tree", archiveMod.archiveTree(a.path, key, opts));
  }
  const res = remove(a.path);
  if (res && res.deferred) return { deferred: res.deferred, detail: res.detail };
  return nested.length > 0 ? `archived (${nested.length} nested repositories), removed` : "archived, removed";
}
