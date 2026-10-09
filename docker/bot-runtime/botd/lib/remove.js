// myrmidon(1.6.5-BOT-DISK-H): guarded removal for botd (extracted from the
// entry point so it is testable). Idempotent by policy:
//   * ENOENT means DONE — the directory is not there, which is exactly what the
//     removal wanted; return "already gone" instead of raising;
//   * EACCES/EPERM means the path belongs to someone else: nothing is removed and
//     the error carries `deferred` (the caller signals attention once and leaves
//     the path in place — the owner decides, ownership is never changed here).
// A path is removable only when it is a real (non-link) entry strictly inside one
// of the allowed roots.

import fs from "node:fs";
import path from "node:path";

export function inside(root, p) {
  const rel = path.relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Owner uid of `p` for the attention text; null when even the stat fails. */
export function uidOf(p) {
  try {
    return fs.lstatSync(p).uid;
  } catch {
    return null;
  }
}

/** Wraps a permission failure into a deferred error; anything else passes through. */
function deferredIfPermission(err, p) {
  if (!err || (err.code !== "EACCES" && err.code !== "EPERM")) return err;
  const wrapped = new Error(`${err.code}: ${String(err.message).slice(0, 300)}`);
  wrapped.deferred = "foreign-uid";
  wrapped.code = err.code;
  wrapped.uid = uidOf(p);
  return wrapped;
}

/**
 * Removes `p` when it is a real (non-link) entry strictly inside one of `roots`.
 * @returns {"removed"|"already gone"} — ENOENT is success, not an error
 * @throws Error (deferred=undefined) for a symlink/outside-roots refusal,
 *         Error with `.deferred === "foreign-uid"` and `.uid` on EACCES/EPERM
 *         after having removed nothing
 */
export function guardedRemove(p, roots) {
  const abs = path.resolve(p);
  if (!roots.some((r) => inside(path.resolve(r), abs))) throw new Error("path is outside the allowed roots");
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === "ENOENT") return "already gone";
    throw deferredIfPermission(err, abs);
  }
  if (st.isSymbolicLink()) throw new Error("refusing to remove a symlink");
  // Permission first: rmSync({recursive:true}) removes the accessible entries of a
  // tree BEFORE it fails on a foreign-owned one, leaving a half-removed directory.
  // A write+execute probe on the target itself fails up front (nothing removed);
  // foreign files deeper inside an owned tree still fail mid-removal, and the error
  // is the same deferred one (the survivors stay for the next pass and the owner).
  try {
    fs.accessSync(abs, fs.constants.W_OK | fs.constants.X_OK);
  } catch (err) {
    throw deferredIfPermission(err, abs);
  }
  try {
    fs.rmSync(abs, { recursive: true, force: true });
  } catch (err) {
    // force:true only ignores ENOENT; a permission failure leaves the path in place
    throw deferredIfPermission(err, abs);
  }
  return "removed";
}
