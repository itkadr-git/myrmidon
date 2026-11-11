"use strict";
// docker/bot-runtime/myr-ws/lib/recover.js
//
// myrmidon(MYR-WS-RECOVER): a task copy that a run left half-way — a merge,
// rebase, cherry-pick, revert or `git am` in progress, unresolved index stages,
// a detached head, a branch other than the one the registry (or the caller)
// names — must not be handed to the next run as it is. `open` (reuse path) and
// `repair` (botd, no run attached) share the code below.
//
// Nothing is thrown away. Before any step that changes the copy the whole state
// (HEAD, the index including conflict stages as plain files, the working tree,
// untracked files) is written as a commit to refs/myr-ws/recovery/<KEY> (a
// numeric suffix when the ref is taken) in the base repository; only then the
// operation is aborted. If the abort does not clean the copy, the worktree is
// recreated on the same branch (the branch commits are untouched).

const fs = require("node:fs");
const path = require("node:path");
const { MyrWsError } = require("./errors.js");

const RECOVERY_REF_PREFIX = "refs/myr-ws/recovery/";
const IDENTITY = {
  GIT_AUTHOR_NAME: "myr-ws",
  GIT_AUTHOR_EMAIL: "myr-ws@localhost",
  GIT_COMMITTER_NAME: "myr-ws",
  GIT_COMMITTER_EMAIL: "myr-ws@localhost",
};

// kind -> [file or directory inside the git dir, abort command]
const IN_PROGRESS = [
  { kind: "merge_in_progress", marker: "MERGE_HEAD", abort: ["merge", "--abort"] },
  { kind: "rebase_in_progress", marker: "rebase-merge", abort: ["rebase", "--abort"] },
  { kind: "rebase_in_progress", marker: "rebase-apply/rebasing", abort: ["rebase", "--abort"] },
  { kind: "am_in_progress", marker: "rebase-apply/applying", abort: ["am", "--abort"] },
  { kind: "cherry_pick_in_progress", marker: "CHERRY_PICK_HEAD", abort: ["cherry-pick", "--abort"] },
  { kind: "revert_in_progress", marker: "REVERT_HEAD", abort: ["revert", "--abort"] },
];

function gitDirOf(git, dir) {
  const r = git(dir, ["rev-parse", "--absolute-git-dir"], { allowFail: true });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

function commonDirOf(git, dir) {
  const r = git(dir, ["rev-parse", "--git-common-dir"], { allowFail: true });
  return r.status === 0 && r.stdout ? path.resolve(dir, r.stdout) : null;
}

/** Operations that are in progress in this copy: [{kind, abort}] (deduplicated by kind). */
function operationsInProgress(gitDir) {
  const out = [];
  for (const op of IN_PROGRESS) {
    if (out.some((o) => o.kind === op.kind)) continue;
    if (fs.existsSync(path.join(gitDir, op.marker))) out.push({ kind: op.kind, abort: op.abort });
  }
  return out;
}

function unmergedPaths(git, dir) {
  const r = git(dir, ["ls-files", "-u", "-z"], { allowFail: true });
  if (r.status !== 0 || !r.stdout) return [];
  const names = new Set();
  for (const rec of r.stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab >= 0) names.add(rec.slice(tab + 1));
  }
  return [...names];
}

/**
 * Looks at a copy. `expectedBranch` (registry or caller) enables the branch
 * checks; omit it for a pure "left half-way" check.
 * Returns {broken, gitDir, branch, problems:[{kind, detail, abort?}]}.
 */
function inspectCopy(git, dir, { expectedBranch } = {}) {
  const gitDir = gitDirOf(git, dir);
  if (!gitDir) return { broken: true, gitDir: null, branch: null, problems: [{ kind: "broken_git", detail: "git cannot read this copy" }] };
  const problems = [];
  for (const op of operationsInProgress(gitDir)) problems.push({ kind: op.kind, detail: op.kind.replace(/_/g, " "), abort: op.abort });
  const unmerged = unmergedPaths(git, dir);
  if (unmerged.length > 0) problems.push({ kind: "unmerged_paths", detail: `${unmerged.length} unresolved path(s)`, count: unmerged.length });
  const head = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  const branch = head.status === 0 && head.stdout ? head.stdout : null;
  if (expectedBranch) {
    if (branch === null) problems.push({ kind: "detached_head", detail: `HEAD is detached, expected ${expectedBranch}` });
    else if (branch !== expectedBranch) problems.push({ kind: "branch_mismatch", detail: `on ${branch}, expected ${expectedBranch}`, actual: branch, expected: expectedBranch });
  }
  return { broken: false, gitDir, branch, problems };
}

/** Problems of an interrupted operation (what `repair` looks at, no branch policy). */
function isHalfWay(problem) {
  return problem.kind !== "branch_mismatch" && problem.kind !== "detached_head" && problem.kind !== "broken_git";
}

function uniqueRecoveryRef(git, dir, key) {
  const exists = (ref) => git(dir, ["show-ref", "--verify", "--quiet", ref], { allowFail: true }).status === 0;
  const first = `${RECOVERY_REF_PREFIX}${key}`;
  if (!exists(first)) return first;
  for (let i = 2; i < 1000; i++) {
    const ref = `${first}-${i}`;
    if (!exists(ref)) return ref;
  }
  throw new MyrWsError(1, `${key}: too many recovery refs under ${first}`);
}

/**
 * Writes the state of the copy to a recovery ref and returns the ref name. The
 * copy itself (index, files, in-progress markers) is not touched: a temporary
 * index is used, so unmerged stages are stored as the files on disk (conflict
 * markers included).
 */
function snapshotCopy(git, dir, key, gitDir, reason) {
  const tmpIndex = path.join(gitDir, `myr-ws-recovery-index.${process.pid}`);
  try {
    if (fs.existsSync(path.join(gitDir, "index"))) fs.copyFileSync(path.join(gitDir, "index"), tmpIndex);
    const env = { ...IDENTITY, GIT_INDEX_FILE: tmpIndex };
    git(dir, ["add", "-A", "--", "."], { env });
    const tree = git(dir, ["write-tree"], { env }).stdout;
    const parents = [];
    const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFail: true });
    if (head.status === 0 && head.stdout) parents.push(head.stdout);
    for (const f of ["MERGE_HEAD", "CHERRY_PICK_HEAD"]) {
      try {
        for (const sha of fs.readFileSync(path.join(gitDir, f), "utf8").split(/\s+/).filter(Boolean)) {
          if (git(dir, ["cat-file", "-e", `${sha}^{commit}`], { allowFail: true }).status === 0 && !parents.includes(sha)) parents.push(sha);
        }
      } catch {
        /* marker absent */
      }
    }
    const args = ["commit-tree", tree];
    for (const p of parents) args.push("-p", p);
    args.push("-m", `myr-ws recovery ${key}: ${reason}`);
    const commit = git(dir, args, { env }).stdout;
    const ref = uniqueRecoveryRef(git, dir, key);
    git(dir, ["update-ref", ref, commit]);
    if (git(dir, ["rev-parse", "--verify", "--quiet", ref], { allowFail: true }).stdout !== commit) {
      throw new MyrWsError(1, `${key}: recovery ref ${ref} could not be verified; the copy was left untouched`);
    }
    return ref;
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

function describeProblems(problems) {
  return problems.map((p) => p.kind).join(", ");
}

/** True when a working tree has anything `git stash` would keep. */
function isDirty(git, dir) {
  return git(dir, ["status", "--porcelain", "--untracked-files=all"], { allowFail: true }).stdout !== "";
}

/**
 * Removes the worktree and adds it again on `branch` (which keeps its commits).
 * The state must already be in a recovery ref.
 */
function recreateWorktree(ctx, git, dir, branch, commonDir) {
  const root = path.resolve(ctx.workspaceRoot);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new MyrWsError(1, `${dir} is outside ${root}; refusing to recreate it`);
  }
  if (!commonDir) throw new MyrWsError(1, `${dir}: no base repository found; refusing to recreate it`);
  git(commonDir, ["worktree", "remove", "--force", "--force", dir], { allowFail: true });
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  git(commonDir, ["worktree", "prune"]);
  git(commonDir, ["worktree", "add", dir, branch]);
}

/**
 * Brings a copy back to a usable state.
 *   opts.key, opts.expectedBranch  - registry/caller branch (open) or null (repair)
 *   opts.explicitBranch            - the caller asked for this branch (--branch)
 *   opts.baseTarget                - fallback ref to create a missing branch from
 * Returns {action: "ok"|"recovered"|"fallthrough", recovered:[{problem, action, detail}],
 *          recoveryRef, branch}. "fallthrough" = the git directory is unreadable: the copy
 * was moved aside to `movedTo` and the caller must create a fresh one.
 */
function recoverCopy(ctx, git, dir, opts) {
  const { key, expectedBranch = null, explicitBranch = false } = opts;
  const state = inspectCopy(git, dir, { expectedBranch });
  const recovered = [];
  if (state.problems.length === 0) return { action: "ok", recovered, branch: state.branch };

  if (state.broken) {
    // Only a worktree whose git directory is gone (the base was pruned or removed) is dead for sure;
    // a copy git merely cannot read for another reason is left exactly as it is.
    if (!isDeadWorktree(dir)) return { action: "ok", recovered, branch: null };
    const moved = `${dir}.broken-${key}-${ctx.now()}`;
    fs.renameSync(dir, moved);
    recovered.push({ problem: "broken_git", action: "moved_aside", detail: `unreadable git state; the copy is kept at ${moved}` });
    return { action: "fallthrough", recovered, movedTo: moved };
  }

  const halfWay = state.problems.filter(isHalfWay);
  const drift = state.problems.filter((p) => !isHalfWay(p));
  const reason = describeProblems(state.problems);
  let recoveryRef;
  let branch = state.branch;
  const commonDir = commonDirOf(git, dir);

  if (halfWay.length > 0 || (drift.length > 0 && explicitBranchNeedsMove(state, drift, explicitBranch))) {
    recoveryRef = snapshotCopy(git, dir, key, state.gitDir, reason);
  }

  // 1. Interrupted operations: abort them, in order.
  // Unresolved stages are the symptom of an operation in progress: report them on their own only when nothing explains them.
  const reported = halfWay.some((p) => p.kind !== "unmerged_paths") ? halfWay.filter((p) => p.kind !== "unmerged_paths") : halfWay;
  if (halfWay.length > 0) {
    for (const p of halfWay) {
      if (p.abort) git(dir, p.abort, { allowFail: true, env: IDENTITY });
    }
    let after = inspectCopy(git, dir, {});
    let leftover = after.problems.filter(isHalfWay);
    if (leftover.length > 0) {
      // `merge --abort` can refuse (e.g. no MERGE_HEAD but stages left): drop the stages of a clean-HEAD copy.
      git(dir, ["reset", "--merge"], { allowFail: true });
      after = inspectCopy(git, dir, {});
      leftover = after.problems.filter(isHalfWay);
    }
    if (leftover.length > 0) {
      const target = state.branch || expectedBranch;
      if (!target) throw new MyrWsError(1, `${key}: copy is stuck (${describeProblems(leftover)}), saved to ${recoveryRef}; no branch to recreate it on`);
      recreateWorktree(ctx, git, dir, target, commonDir);
      for (const p of reported) recovered.push({ problem: p.kind, action: "recreated", detail: `abort did not clean the copy; recreated on ${target}` });
      branch = target;
    } else {
      for (const p of reported) recovered.push({ problem: p.kind, action: "aborted", detail: p.abort ? `git ${p.abort.join(" ")}` : "reset --merge" });
    }
  }

  // 2. Branch policy (open only; repair passes no expected branch).
  const nowState = inspectCopy(git, dir, { expectedBranch });
  const drift2 = nowState.problems.filter((p) => !isHalfWay(p));
  for (const p of drift2) {
    if (p.kind === "broken_git") continue;
    const actual = nowState.branch;
    if (p.kind === "branch_mismatch" && !explicitBranch) {
      // The bot moved the copy to another branch on purpose or by accident: the actual
      // branch is the truth, the registry follows it. Nothing on disk changes.
      recovered.push({ problem: "branch_mismatch", action: "registry_synced", detail: `copy is on ${actual}, registry said ${p.expected}` });
      branch = actual;
      continue;
    }
    // detached head, or a branch other than the one the caller asked for: move to it.
    if (!recoveryRef) recoveryRef = snapshotCopy(git, dir, key, nowState.gitDir, reason);
    if (isDirty(git, dir)) {
      const st = git(dir, ["stash", "push", "--include-untracked", "--message", `myr-ws recovery ${key}`], { allowFail: true, env: IDENTITY });
      if (st.status !== 0) throw new MyrWsError(1, `${key}: could not stash local changes before switching to ${expectedBranch}; saved to ${recoveryRef}, copy left as it is`);
    }
    const have = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${expectedBranch}`], { allowFail: true }).status === 0;
    let co;
    if (have) co = git(dir, ["checkout", expectedBranch], { allowFail: true });
    else if (p.kind === "detached_head" && !explicitBranch) co = git(dir, ["checkout", "-b", expectedBranch], { allowFail: true });
    else co = createBranchFromRemote(git, dir, expectedBranch, opts.baseTarget);
    if (co.status !== 0) throw new MyrWsError(1, `${key}: cannot switch to ${expectedBranch}: ${co.stderr.slice(0, 300)}; saved to ${recoveryRef}`);
    recovered.push({ problem: p.kind, action: "switched_branch", detail: `${actual || "detached HEAD"} -> ${expectedBranch}; local changes are in the stash and ${recoveryRef}` });
    branch = expectedBranch;
  }

  return { action: "recovered", recovered, recoveryRef, branch };
}

function isDeadWorktree(dir) {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8"));
    return Boolean(m) && !fs.existsSync(path.resolve(dir, m[1].trim()));
  } catch {
    return false;
  }
}

function explicitBranchNeedsMove(state, drift, explicitBranch) {
  return drift.some((p) => p.kind === "detached_head" || (p.kind === "branch_mismatch" && explicitBranch));
}

function createBranchFromRemote(git, dir, branch, baseTarget) {
  const remote = `refs/remotes/origin/${branch}`;
  const has = () => git(dir, ["rev-parse", "--verify", "--quiet", `${remote}^{commit}`], { allowFail: true }).status === 0;
  if (!has()) git(dir, ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${remote}`], { allowFail: true });
  const hasRemote = has();
  const from = hasRemote ? remote : baseTarget;
  if (!from) return { status: 1, stderr: `no ref to create ${branch} from`, stdout: "" };
  return git(dir, ["checkout", "--no-track", "-b", branch, from], { allowFail: true });
}

/** One line for a human/stderr: what was restored. */
function recoveredSummary(key, recovered, recoveryRef) {
  const parts = recovered.map((r) => `${r.problem} -> ${r.action}`);
  return `${key}: copy was not clean (${parts.join("; ")})${recoveryRef ? `; state saved to ${recoveryRef}` : ""}`;
}

/** True if some process has its working directory in `dir` (the run that owns the copy may still be going). */
function hasLiveProcess(dir, procRoot = "/proc") {
  let names;
  try {
    names = fs.readdirSync(procRoot);
  } catch {
    return null;
  }
  let readable = 0;
  const real = path.resolve(dir);
  for (const n of names) {
    if (!/^\d+$/.test(n) || Number(n) === process.pid) continue;
    try {
      const cwd = fs.readlinkSync(path.join(procRoot, n, "cwd"));
      readable += 1;
      if (cwd === real || cwd.startsWith(`${real}/`)) return true;
    } catch {
      /* gone or not ours */
    }
  }
  return readable > 0 ? false : null;
}

module.exports = {
  RECOVERY_REF_PREFIX,
  inspectCopy,
  recoverCopy,
  snapshotCopy,
  recoveredSummary,
  hasLiveProcess,
  isHalfWay,
  commonDirOf,
  IDENTITY,
};
