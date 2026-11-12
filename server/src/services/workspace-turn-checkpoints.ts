import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@myrmidon/db";

/**
 * Per-turn checkpoints of the working execution-workspace tree (OPE-12738).
 *
 * Every completed agent turn in a run leaves an immutable snapshot ref
 * `refs/myrmidon/turns/<runId>/<turnN>` on the run's git worktree. Restore
 * rewinds the worktree to the checkpoint of a previous turn without touching
 * foreign edits (proven identical-diff relaunch); a retention cap bounds the
 * number of refs per run; introspection exposes turn→turn diffs.
 *
 * The refs are hidden plumbing: plain `git log`/`git branch` do not show them,
 * and they are never pushed to remotes. State lives in git, so no schema
 * migration is needed.
 */

export const TURN_CHECKPOINT_REF_PREFIX = "refs/myrmidon/turns";

/** Retention cap for turn checkpoint refs per run (oldest pruned first). */
export const DEFAULT_TURN_CHECKPOINT_RETENTION = 10;

export const TURN_CHECKPOINT_BUSY_CODE = "worktree_busy_by_active_run";
export const TURN_CHECKPOINT_DIRTY_CODE = "worktree_has_uncommitted_edits";
export const TURN_CHECKPOINT_MISSING_CODE = "turn_checkpoint_missing";

export type TurnCheckpointRef = {
  runId: string;
  turnNumber: number;
  ref: string;
  commitSha: string;
};

export type CreateTurnCheckpointResult = {
  runId: string;
  turnNumber: number;
  ref: string;
  commitSha: string;
  prunedRefs: string[];
};

export type RestoreTurnCheckpointResult = {
  runId: string;
  targetTurnNumber: number;
  ref: string;
  commitSha: string;
  refBefore: string | null;
};

export type TurnCheckpointDiffResult = {
  runId: string;
  fromTurn: number;
  toTurn: number;
  fromCommitSha: string;
  toCommitSha: string;
  stat: string;
  patch: string;
  truncated: boolean;
};

export class TurnCheckpointError extends Error {
  code: string;
  details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TurnCheckpointError";
    this.code = code;
    this.details = details;
  }
}

const TURN_DIFF_MAX_PATCH_BYTES = 512 * 1024;

function formatTurnRef(runId: string, turnNumber: number): string {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(runId)) {
    throw new TurnCheckpointError("invalid_run_id", `run id is not a safe ref component: ${runId}`);
  }
  if (!Number.isInteger(turnNumber) || turnNumber < 0) {
    throw new TurnCheckpointError("invalid_turn_number", `turn number must be a non-negative integer: ${turnNumber}`);
  }
  return `${TURN_CHECKPOINT_REF_PREFIX}/${runId}/${turnNumber}`;
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        const error = new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`);
        (error as NodeJS.ErrnoException & { gitCode?: number }).gitCode = code ?? undefined;
        reject(error);
      }
    });
  });
}

async function listTurnCheckpointRefs(worktreePath: string, runId: string): Promise<Array<{ ref: string; sha: string }>> {
  const pattern = `${TURN_CHECKPOINT_REF_PREFIX}/${runId}/*`;
  const output = await runGit(["for-each-ref", "--format=%(refname) %(objectname)", pattern], worktreePath)
    .catch(() => "");
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceIndex = line.indexOf(" ");
      return {
        ref: line.slice(0, spaceIndex),
        sha: line.slice(spaceIndex + 1),
      };
    });
}

function turnNumberFromRef(ref: string, runId: string): number | null {
  const prefix = `${TURN_CHECKPOINT_REF_PREFIX}/${runId}/`;
  if (!ref.startsWith(prefix)) return null;
  const raw = ref.slice(prefix.length);
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && String(value) === raw ? value : null;
}

/**
 * Contention refusal: refuse restore while the worktree is claimed by another
 * workspace's active run, or by any other active run bound to the same
 * workspace (shared workspace with concurrent mutations — mirroring the
 * dirty-quarantine protection).
 */
export async function findTurnCheckpointWorktreeContention(input: {
  db: Db;
  companyId: string;
  worktreePath: string;
  executionWorkspaceId?: string | null;
  activeRunId?: string | null;
}): Promise<{ claimedByWorkspaceId: string; claimedByIssueId: string | null; activeRunId: string | null } | null> {
  const activeRunStatuses = ["queued", "running"] as const;
  const { executionWorkspaceService } = await import("./execution-workspaces.js");
  const svc = executionWorkspaceService(input.db);
  const crossWorkspaceContention = await svc.findGitWorktreeContention({
    companyId: input.companyId,
    worktreePath: input.worktreePath,
    liveBranchName: null,
    excludingExecutionWorkspaceId: input.executionWorkspaceId ?? null,
  });
  if (crossWorkspaceContention && crossWorkspaceContention.activeRun) {
    // A live claim by a different active run blocks the rewind; the same run
    // rewinding its own worktree is the whole point of this operation.
    const claimRunId = crossWorkspaceContention.activeRun.id;
    if (!(input.activeRunId && claimRunId === input.activeRunId)) {
      return {
        claimedByWorkspaceId: crossWorkspaceContention.claimedByWorkspaceId,
        claimedByIssueId: crossWorkspaceContention.claimedByIssueId ?? null,
        activeRunId: claimRunId,
      };
    }
  }
  // Same-workspace contention: another active run bound to this workspace.
  // Issues link to runs via executionRunId / checkoutRunId (the runs table has
  // no issue column).
  if (input.executionWorkspaceId) {
    const sameWorkspaceRows = await input.db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .innerJoin(
        issues,
        or(
          eq(issues.executionRunId, heartbeatRuns.id),
          eq(issues.checkoutRunId, heartbeatRuns.id),
        ),
      )
      .where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        inArray(heartbeatRuns.status, [...activeRunStatuses]),
        input.activeRunId ? ne(heartbeatRuns.id, input.activeRunId) : undefined,
        eq(issues.executionWorkspaceId, input.executionWorkspaceId),
      ))
      .orderBy(desc(heartbeatRuns.startedAt))
      .limit(1);
    const other = sameWorkspaceRows[0];
    if (other) {
      return {
        claimedByWorkspaceId: input.executionWorkspaceId,
        claimedByIssueId: null,
        activeRunId: other.id,
      };
    }
  }
  return null;
}

/**
 * Snapshot the current worktree state after a completed turn. Never moves
 * HEAD and never touches the index; the snapshot commit is built with
 * `git write-tree` from the current index (the turn's durable edits are
 * already observable in worktree files; untracked noise is not captured).
 */
export async function createTurnCheckpoint(input: {
  worktreePath: string;
  runId: string;
  turnNumber: number;
  retention?: number;
}): Promise<CreateTurnCheckpointResult> {
  const ref = formatTurnRef(input.runId, input.turnNumber);
  const retention = input.retention ?? DEFAULT_TURN_CHECKPOINT_RETENTION;
  if (!existsSync(input.worktreePath)) {
    throw new TurnCheckpointError("worktree_missing", `worktree path does not exist: ${input.worktreePath}`);
  }
  await assertGitRepository(input.worktreePath);

  // The index in a live worktree may be locked by an in-flight git op; a
  // snapshot must not corrupt it, so take a stable read via a temporary index
  // and `git add -A` only into that temporary index.
  const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], input.worktreePath);
  const tmpIndex = path.join(gitDir, "myrmidon-turn-checkpoint-index");
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    await runGitWithEnv(["read-tree", "HEAD"], input.worktreePath, env)
      .catch(async () => runGitWithEnv(["read-tree", "--empty"], input.worktreePath, env));
    await runGitWithEnv(["add", "-A", "--", "."], input.worktreePath, env);
    const treeSha = await runGitWithEnv(["write-tree"], input.worktreePath, env);
    const parentSha = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], input.worktreePath)
      .catch(() => "");
    const commitArgs = [
      "commit-tree", treeSha,
      "-m", `myrmidon turn checkpoint run=${input.runId} turn=${input.turnNumber}`,
    ];
    if (parentSha) commitArgs.push("-p", parentSha);
    const commitSha = await runGitWithEnv(commitArgs, input.worktreePath, {
      ...env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "myrmidon-turn-checkpoint",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "checkpoint@myrmidon.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "myrmidon-turn-checkpoint",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "checkpoint@myrmidon.invalid",
      GIT_COMMITTER_DATE: new Date().toISOString(),
    });
    await runGit(["update-ref", ref, commitSha], input.worktreePath);
    const prunedRefs = await pruneTurnCheckpoints({
      worktreePath: input.worktreePath,
      runId: input.runId,
      retention,
    });
    return { runId: input.runId, turnNumber: input.turnNumber, ref, commitSha, prunedRefs };
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
    } catch {
      // leftover temp index is harmless; best-effort removal only
    }
  }
}

async function runGitWithEnv(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`));
    });
  });
}

async function assertGitRepository(worktreePath: string) {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], worktreePath).catch(() => "");
  if (inside !== "true") {
    throw new TurnCheckpointError("not_a_git_worktree", `path is not a git worktree: ${worktreePath}`);
  }
}

async function pruneTurnCheckpoints(input: {
  worktreePath: string;
  runId: string;
  retention: number;
}): Promise<string[]> {
  if (!Number.isInteger(input.retention) || input.retention < 1) return [];
  const refs = await listTurnCheckpointRefs(input.worktreePath, input.runId);
  const numbered = refs
    .map((entry) => ({ ...entry, turnNumber: turnNumberFromRef(entry.ref, input.runId) }))
    .filter((entry): entry is { ref: string; sha: string; turnNumber: number } => entry.turnNumber !== null)
    .sort((a, b) => b.turnNumber - a.turnNumber);
  const pruned: string[] = [];
  for (const stale of numbered.slice(input.retention)) {
    await runGit(["update-ref", "-d", stale.ref], input.worktreePath);
    pruned.push(stale.ref);
  }
  return pruned;
}

export async function listTurnCheckpoints(input: {
  worktreePath: string;
  runId: string;
}): Promise<TurnCheckpointRef[]> {
  await assertGitRepository(input.worktreePath);
  const refs = await listTurnCheckpointRefs(input.worktreePath, input.runId);
  return refs
    .map((entry) => ({ ...entry, turnNumber: turnNumberFromRef(entry.ref, input.runId) }))
    .filter((entry): entry is { ref: string; sha: string; turnNumber: number } => entry.turnNumber !== null)
    .sort((a, b) => a.turnNumber - b.turnNumber)
    .map((entry) => ({
      runId: input.runId,
      turnNumber: entry.turnNumber,
      ref: entry.ref,
      commitSha: entry.sha,
    }));
}

export type TurnCheckpointContention = NonNullable<Awaited<ReturnType<typeof findTurnCheckpointWorktreeContention>>>;

/**
 * Rewind the working worktree to a prior turn's checkpoint without touching
 * foreign edits: refuses when another workspace/run claims the tree. Only the
 * tracked working files and the index are rewound to the snapshot tree; the
 * checked-out branch ref never moves.
 */
export async function restoreTurnCheckpoint(input: {
  db: Db;
  companyId: string;
  worktreePath: string;
  runId: string;
  targetTurnNumber: number;
  executionWorkspaceId?: string | null;
  activeRunId?: string | null;
  retention?: number;
}): Promise<RestoreTurnCheckpointResult> {
  const ref = formatTurnRef(input.runId, input.targetTurnNumber);
  if (!existsSync(input.worktreePath)) {
    throw new TurnCheckpointError("worktree_missing", `worktree path does not exist: ${input.worktreePath}`);
  }
  await assertGitRepository(input.worktreePath);

  const contention = await findTurnCheckpointWorktreeContention({
    db: input.db,
    companyId: input.companyId,
    worktreePath: input.worktreePath,
    executionWorkspaceId: input.executionWorkspaceId,
    activeRunId: input.activeRunId,
  });
  if (contention) {
    throw new TurnCheckpointError(
      TURN_CHECKPOINT_BUSY_CODE,
      `restore refused: worktree is claimed by workspace ${contention.claimedByWorkspaceId}` +
        (contention.activeRunId ? ` with active run ${contention.activeRunId}` : ""),
      { contention },
    );
  }

  const commitSha = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], input.worktreePath)
    .catch(() => "");
  if (!commitSha) {
    throw new TurnCheckpointError(
      TURN_CHECKPOINT_MISSING_CODE,
      `no turn checkpoint ref ${ref} in ${input.worktreePath}`,
      { ref, runId: input.runId, targetTurnNumber: input.targetTurnNumber },
    );
  }

  // Uncommitted tracked state (staged or worktree edits vs HEAD) is foreign
  // work the rewind must not lose — EXCEPT when it already equals the target
  // checkpoint: a clean checkpoint legitimately carries its turn's durable
  // edits as staged-but-uncommitted state (the snapshot reads the worktree
  // into a temporary index without committing), so restoring onto an identical
  // stale copy is a safe no-op. Committed turn history between HEAD and the
  // target needs no protection: it stays reachable at HEAD, and rewinding it
  // is exactly what restore is for. Untracked files are preserved and never
  // count as tracked edits.
  const statusLines = (await runGit(["status", "--porcelain", "--untracked-files=no"], input.worktreePath))
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (statusLines.length > 0) {
    const targetDiff = (await runGit(["diff", "--name-status", commitSha, "--"], input.worktreePath))
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);
    if (targetDiff.length > 0) {
      throw new TurnCheckpointError(
        TURN_CHECKPOINT_DIRTY_CODE,
        "restore refused: uncommitted tracked state differs from the target checkpoint; refusing to overwrite it",
        { paths: targetDiff.slice(0, 20), truncated: targetDiff.length > 20 },
      );
    }
  }

  const refBefore = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], input.worktreePath).catch(() => null);
  // Rewind tracked working files + index to the snapshot tree. Untracked files
  // are intentionally preserved; the branch ref never moves.
  await runGit(["read-tree", "--reset", "-u", commitSha], input.worktreePath);
  return {
    runId: input.runId,
    targetTurnNumber: input.targetTurnNumber,
    ref,
    commitSha,
    refBefore,
  };
}

/** Introspection: diff between two turn checkpoints of one run. */
export async function diffTurnCheckpoints(input: {
  worktreePath: string;
  runId: string;
  fromTurn: number;
  toTurn: number;
}): Promise<TurnCheckpointDiffResult> {
  const fromRef = formatTurnRef(input.runId, input.fromTurn);
  const toRef = formatTurnRef(input.runId, input.toTurn);
  await assertGitRepository(input.worktreePath);
  const fromCommitSha = await runGit(["rev-parse", "--verify", "--quiet", `${fromRef}^{commit}`], input.worktreePath)
    .catch(() => "");
  if (!fromCommitSha) {
    throw new TurnCheckpointError(TURN_CHECKPOINT_MISSING_CODE, `no turn checkpoint ref ${fromRef}`, { ref: fromRef });
  }
  const toCommitSha = await runGit(["rev-parse", "--verify", "--quiet", `${toRef}^{commit}`], input.worktreePath)
    .catch(() => "");
  if (!toCommitSha) {
    throw new TurnCheckpointError(TURN_CHECKPOINT_MISSING_CODE, `no turn checkpoint ref ${toRef}`, { ref: toRef });
  }
  const stat = await runGit(["diff", "--stat", `${fromCommitSha}..${toCommitSha}`], input.worktreePath);
  const rawPatch = await runGit(["diff", `${fromCommitSha}..${toCommitSha}`], input.worktreePath);
  const patchBuf = Buffer.from(rawPatch, "utf8");
  const truncated = patchBuf.byteLength > TURN_DIFF_MAX_PATCH_BYTES;
  return {
    runId: input.runId,
    fromTurn: input.fromTurn,
    toTurn: input.toTurn,
    fromCommitSha,
    toCommitSha,
    stat,
    patch: truncated ? `${patchBuf.subarray(0, TURN_DIFF_MAX_PATCH_BYTES).toString("utf8")}\n... [truncated]` : rawPatch,
    truncated,
  };
}
