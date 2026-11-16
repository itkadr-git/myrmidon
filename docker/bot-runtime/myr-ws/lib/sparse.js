"use strict";
// docker/bot-runtime/myr-ws/lib/sparse.js
//
// myrmidon(1.6.9, OPE-13410 item 5): a new task copy checks out the drizzle snapshot
// folder `packages/db/src/migrations/meta` sparsely: `_journal.json` plus the latest
// snapshot only (263 snapshots of ~1.1 MB were 57% of a 500 MB copy). `drizzle-kit
// generate` reads exactly those two. The rest of the tree is checked out in full.
// The latest snapshot comes from the journal of the checked-out commit, never from a
// hard-coded name. A repository without such a journal gets a normal full checkout.
// To get the whole folder back in a copy: `git sparse-checkout disable`.

const META_DIR = "packages/db/src/migrations/meta";
const JOURNAL = `${META_DIR}/_journal.json`;

/** Name of the latest snapshot file named by the journal text, or null when it is unusable. */
function latestSnapshotFromJournal(text) {
  let journal;
  try {
    journal = JSON.parse(text);
  } catch {
    return null;
  }
  const entries = journal && Array.isArray(journal.entries) ? journal.entries : [];
  let max = -1;
  for (const e of entries) {
    if (e && Number.isInteger(e.idx) && e.idx > max) max = e.idx;
  }
  if (max < 0) return null;
  return `${String(max).padStart(4, "0")}_snapshot.json`;
}

/** Non-cone sparse-checkout patterns: everything, minus meta/*, plus the journal and one snapshot. */
function sparsePatterns(snapshotName) {
  return ["/*", `!/${META_DIR}/*`, `/${JOURNAL}`, `/${META_DIR}/${snapshotName}`];
}

/** `worktree add --no-checkout` skips the post-checkout hook that a plain open runs: run it here. */
function postCheckout(git, dir) {
  const head = git(dir, ["rev-parse", "HEAD"], { allowFail: true }).stdout;
  if (!head) return;
  git(dir, ["hook", "run", "--ignore-missing", "post-checkout", "--", "0".repeat(head.length), head, "1"], { allowFail: true });
}

/**
 * Turns a copy created with `worktree add --no-checkout` into a sparse checkout of HEAD.
 * Returns { sparse: true, snapshot } or { sparse: false, reason }; on any failure the copy
 * is checked out in full, so a copy is never left empty. `git` is the makeGit function of open.js.
 */
function checkoutTaskCopy(git, dir) {
  const full = (reason) => {
    git(dir, ["read-tree", "-m", "-u", "HEAD"]);
    postCheckout(git, dir);
    return { sparse: false, reason };
  };
  const journal = git(dir, ["show", `HEAD:${JOURNAL}`], { allowFail: true });
  if (journal.status !== 0) return full("no drizzle journal in this repository");
  const snapshot = latestSnapshotFromJournal(journal.stdout);
  if (!snapshot) return full("drizzle journal is unreadable");
  if (git(dir, ["cat-file", "-e", `HEAD:${META_DIR}/${snapshot}`], { allowFail: true }).status !== 0) {
    return full(`snapshot ${snapshot} named by the journal is not in the tree`);
  }
  const set = git(dir, ["sparse-checkout", "set", "--no-cone", "--", ...sparsePatterns(snapshot)], { allowFail: true });
  if (set.status === 0) {
    const rt = git(dir, ["read-tree", "-m", "-u", "HEAD"], { allowFail: true });
    if (rt.status === 0) {
      postCheckout(git, dir);
      return { sparse: true, snapshot };
    }
  }
  git(dir, ["sparse-checkout", "disable"], { allowFail: true });
  return full(`sparse-checkout failed: ${(set.stderr || "").slice(0, 200)}`);
}

module.exports = { META_DIR, JOURNAL, latestSnapshotFromJournal, sparsePatterns, checkoutTaskCopy };
