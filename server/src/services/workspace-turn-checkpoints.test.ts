import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTurnCheckpoint,
  diffTurnCheckpoints,
  findTurnCheckpointWorktreeContention,
  listTurnCheckpoints,
  restoreTurnCheckpoint,
  TURN_CHECKPOINT_BUSY_CODE,
  TURN_CHECKPOINT_DIRTY_CODE,
  TURN_CHECKPOINT_MISSING_CODE,
  TurnCheckpointError,
  DEFAULT_TURN_CHECKPOINT_RETENTION,
  TURN_CHECKPOINT_REF_PREFIX,
} from "./workspace-turn-checkpoints.js";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Drizzle-shaped stub whose every query chain resolves to zero rows. */
function emptyDb() {
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
  };
  return {
    select: () => chain,
  };
}

function gitAllowFail(cwd: string, args: string[]) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function makeRunRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-turn-checkpoints-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@myrmidon.invalid"]);
  git(root, ["config", "user.name", "turn-checkpoint-tests"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

const RUN_ID = "123e4567-e89b-42d3-a456-426614174000";

describe("per-turn checkpoints (OPE-12738)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeRunRepo();
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it("restores to a previous turn and a relaunch produces an identical diff", async () => {
    // turn 1 committed state (clean index/worktree)
    await fs.writeFile(path.join(repoRoot, "file.txt"), "turn-1\n");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-m", "turn 1"]);
    const turn1 = await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 1 });

    // turn 2 committed state (clean index/worktree)
    await fs.writeFile(path.join(repoRoot, "file.txt"), "turn-1\nturn-2\n");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-m", "turn 2"]);
    await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 2 });

    // the original turn1→turn2 introspection diff, captured before the crash
    const originalDiff = await diffTurnCheckpoints({
      worktreePath: repoRoot,
      runId: RUN_ID,
      fromTurn: 1,
      toTurn: 2,
    });
    expect(originalDiff.patch).toContain("+turn-2");

    // restore to turn 1's checkpoint via the service (no contention, clean tree)
    const restoreResult = await restoreTurnCheckpoint({
      db: emptyDb() as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      runId: RUN_ID,
      targetTurnNumber: 1,
    });
    expect(restoreResult.commitSha).toBe(turn1.commitSha);

    // worktree content is now exactly the turn-1 snapshot
    expect(await fs.readFile(path.join(repoRoot, "file.txt"), "utf8")).toBe("turn-1\n");
    expect(git(repoRoot, ["diff", turn1.commitSha, "--stat"])).toBe("");

    // a relaunched turn from the restored state produces an identical diff:
    // re-run turn-2's edit and diff turn1 -> new snapshot
    await fs.writeFile(path.join(repoRoot, "file.txt"), "turn-1\nturn-2\n");
    git(repoRoot, ["add", "-A"]);
    const turn2prime = await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 2 });
    const relaunchDiff = await diffTurnCheckpoints({
      worktreePath: repoRoot,
      runId: RUN_ID,
      fromTurn: 1,
      toTurn: 2,
    });
    expect(relaunchDiff.fromCommitSha).toBe(turn1.commitSha);
    expect(relaunchDiff.toCommitSha).toBe(turn2prime.commitSha);
    // deterministic tree: the re-applied edit diffs identically to the original turn-2 edit
    expect(relaunchDiff.patch).toContain("+turn-2");
    expect(relaunchDiff.patch).not.toContain("garbage");
    expect(relaunchDiff.patch).toBe(originalDiff.patch.replace(/\n$/, ""));
  });

  it("refuses restore when tracked files have uncommitted edits without overwriting them", async () => {
    await fs.writeFile(path.join(repoRoot, "file.txt"), "turn-1\n");
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-m", "turn 1"]);
    await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 1 });

    // Foreign uncommitted tracked edit arrives after checkpoint
    await fs.writeFile(path.join(repoRoot, "file.txt"), "foreign uncommitted edit\n");

    await expect(restoreTurnCheckpoint({
      db: emptyDb() as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      runId: RUN_ID,
      targetTurnNumber: 1,
    })).rejects.toMatchObject({
      name: "TurnCheckpointError",
      code: TURN_CHECKPOINT_DIRTY_CODE,
    });

    // Foreign edit must survive intact
    expect(await fs.readFile(path.join(repoRoot, "file.txt"), "utf8")).toBe("foreign uncommitted edit\n");
  });

  it("untracked foreign files survive the restore", async () => {
    await fs.writeFile(path.join(repoRoot, "tracked.txt"), "one\n");
    git(repoRoot, ["add", "-A"]);
    await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 1 });
    await fs.writeFile(path.join(repoRoot, "foreign.txt"), "not mine\n");
    const result = await restoreTurnCheckpoint({
      db: emptyDb() as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      runId: RUN_ID,
      targetTurnNumber: 1,
    });
    void result;
    expect(await fs.readFile(path.join(repoRoot, "foreign.txt"), "utf8")).toBe("not mine\n");
    expect(await fs.readFile(path.join(repoRoot, "tracked.txt"), "utf8")).toBe("one\n");
  });

  it("GC: on the N+1th snapshot the oldest is pruned and the ref count stays capped", async () => {
    const retention = 3;
    for (let turn = 1; turn <= retention + 2; turn += 1) {
      await fs.writeFile(path.join(repoRoot, "log.txt"), `turn-${turn}\n`);
      git(repoRoot, ["add", "-A"]);
      await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: turn, retention });
    }
    const refs = git(repoRoot, ["for-each-ref", "--format=%(refname)", `${TURN_CHECKPOINT_REF_PREFIX}/${RUN_ID}/`])
      .split("\n")
      .filter(Boolean);
    expect(refs.length).toBe(retention);
    const listed = await listTurnCheckpoints({ worktreePath: repoRoot, runId: RUN_ID });
    expect(listed.map((c) => c.turnNumber)).toEqual([3, 4, 5]);
    expect(listed.map((c) => c.turnNumber)).not.toContain(1);
    expect(listed.map((c) => c.turnNumber)).not.toContain(2);
    expect(DEFAULT_TURN_CHECKPOINT_RETENTION).toBe(10);
  });

  it("refuses restore when another active run claims the worktree", async () => {
    await fs.writeFile(path.join(repoRoot, "x.txt"), "x\n");
    git(repoRoot, ["add", "-A"]);
    await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: 1 });

    const activeRun = { id: "other-run-id", status: "running" as const };
    // Contention probe with a foreign active run: the cross-workspace arm
    // (leftJoin) returns no conflicting workspace, while the same-workspace arm
    // (innerJoin) returns the foreign active run and must refuse restore.
    const contentionDb = new Proxy({}, {
      get(_target, prop) {
        if (prop === "select") {
          return () => {
            let isSameWorkspaceArm = false;
            const chain: Record<string, unknown> = {
              from: () => chain,
              innerJoin: () => {
                isSameWorkspaceArm = true;
                return chain;
              },
              leftJoin: () => chain,
              where: () => chain,
              orderBy: () => chain,
              limit: () => Promise.resolve(isSameWorkspaceArm ? [{ id: activeRun.id }] : []),
            };
            return chain;
          };
        }
        throw new Error(`unexpected db access: ${String(prop)}`);
      },
    });
    const contention = await findTurnCheckpointWorktreeContention({
      db: contentionDb as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      executionWorkspaceId: "00000000-0000-4000-8000-000000000001",
      activeRunId: RUN_ID,
    });
    expect(contention).not.toBeNull();
    expect(contention?.activeRunId).toBe(activeRun.id);
    // restore itself must refuse with the busy code
    await expect(restoreTurnCheckpoint({
      db: contentionDb as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      runId: RUN_ID,
      targetTurnNumber: 1,
      executionWorkspaceId: "00000000-0000-4000-8000-000000000001",
      activeRunId: RUN_ID,
    })).rejects.toMatchObject({
      name: "TurnCheckpointError",
      code: TURN_CHECKPOINT_BUSY_CODE,
    });
    // worktree untouched by the refused restore
    expect(gitAllowFail(repoRoot, ["status", "--porcelain"])).not.toMatch(/^ D base.txt/m);
  });

  it("missing checkpoint ref fails with the missing code", async () => {
    await expect(diffTurnCheckpoints({
      worktreePath: repoRoot,
      runId: RUN_ID,
      fromTurn: 1,
      toTurn: 2,
    })).rejects.toMatchObject({
      name: "TurnCheckpointError",
      code: TURN_CHECKPOINT_MISSING_CODE,
    });
    await expect(restoreTurnCheckpoint({
      db: emptyDb() as never,
      companyId: "00000000-0000-4000-8000-000000000000",
      worktreePath: repoRoot,
      runId: RUN_ID,
      targetTurnNumber: 9,
    })).rejects.toBeInstanceOf(TurnCheckpointError);
  });

  it("lists checkpoints in turn order with refs and shas", async () => {
    for (const turn of [1, 2, 3]) {
      await fs.writeFile(path.join(repoRoot, "f.txt"), `${turn}\n`);
      git(repoRoot, ["add", "-A"]);
      await createTurnCheckpoint({ worktreePath: repoRoot, runId: RUN_ID, turnNumber: turn });
    }
    const listed = await listTurnCheckpoints({ worktreePath: repoRoot, runId: RUN_ID });
    expect(listed.map((c) => c.turnNumber)).toEqual([1, 2, 3]);
    for (const entry of listed) {
      expect(entry.ref).toBe(`${TURN_CHECKPOINT_REF_PREFIX}/${RUN_ID}/${entry.turnNumber}`);
      expect(entry.commitSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("rejects unsafe run ids and negative turns", async () => {
    await expect(createTurnCheckpoint({
      worktreePath: repoRoot,
      runId: "../escape",
      turnNumber: 1,
    })).rejects.toBeInstanceOf(TurnCheckpointError);
    await expect(createTurnCheckpoint({
      worktreePath: repoRoot,
      runId: RUN_ID,
      turnNumber: -1,
    })).rejects.toMatchObject({ code: "invalid_turn_number" });
  });
});
