// myrmidon(1.6.5-BOT-DISK-H): botd helpers for directories that are NOT in the
// myr-ws registry (legacy task directories, class G and the foreign class X under
// /workspace). Pure of botd's closures so they can be tested on fixtures.

import path from "node:path";

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
        isGit: hasDotGit(it.path),
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
 * Archive first, then remove a directory the registry does not own. A failed
 * archive (ok:false, or no archive module) leaves the directory in place.
 * @param {{path:string, key?:string}} a
 * @param {{archiveMod:object|null, isGit:(p:string)=>boolean, remove:(p:string)=>void, archiveRoot?:string}} deps
 * @returns {string} detail
 */
export function archiveThenRemove(a, deps) {
  const { archiveMod, isGit, remove, archiveRoot } = deps;
  if (!archiveMod || typeof archiveMod.archive !== "function") throw new Error("archive module is not in this image: not removed");
  const key = a.key || path.basename(a.path);
  const opts = { looseKey: true, ...(archiveRoot ? { archiveRoot } : {}) };
  let r;
  if (isGit(a.path)) r = archiveMod.archive(a.path, key, opts);
  else if (typeof archiveMod.archiveTree === "function") r = archiveMod.archiveTree(a.path, key, opts);
  else throw new Error("archive module cannot archive a non-git directory: not removed");
  if (!r || r.ok !== true) throw new Error(`archive failed, not removed: ${String((r && r.reason) || "unknown").slice(0, 300)}`);
  remove(a.path);
  return "archived, removed";
}
