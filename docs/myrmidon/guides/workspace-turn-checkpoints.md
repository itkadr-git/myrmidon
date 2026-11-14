# Turn checkpoints of the working worktree

> Russian version: [workspace-turn-checkpoints.ru.md](workspace-turn-checkpoints.ru.md)

Every completed agent turn of a run leaves a snapshot of the working
execution-workspace tree on that run's git worktree. The snapshot is a hidden
git ref `refs/myrmidon/turns/<runId>/<turnN>`. If a run dies in the middle of
a turn, the operator can rewind the worktree to the checkpoint of the previous
turn and restart the turn from there — and the repeated turn then produces an
identical diff instead of piling onto half-finished edits (OPE-12738,
release 1.7 CHECKPOINT-PER-TURN).

State lives in git only: there is no schema migration, and the refs are hidden
plumbing — plain `git log`/`git branch` do not show them, and they are never
pushed to remotes.

## Ref naming and retention

- Refs live on the run's worktree under
  `refs/myrmidon/turns/<runId>/<turnN>`, where `<runId>` is the heartbeat run
  id and `<turnN>` is a monotonic per-run turn number starting at 1. Turn
  numbers are derived from the existing refs of the run (max + 1), so they
  stay monotonic even when the provider session restarts mid-run.
- The snapshot commits a tree read from the worktree (via a temporary index,
  so an in-flight git operation in the live worktree is never corrupted),
  chained `-p` to the previous turn's checkpoint of the same run. The
  snapshot records the worktree as it was; the checked-out branch and HEAD
  never move.
- Retention keeps the newest 10 refs per run
  (`DEFAULT_TURN_CHECKPOINT_RETENTION`; not yet configurable by environment).
  When turn N+1 is snapshotted, refs beyond the cap are deleted oldest-first
  (`update-ref -d`), so a long run cannot grow the repository without bound.
- Each completed turn also emits a `paperclip.turn_checkpoint.created` line
  to the run log with `runId` and `turnNumber`.

Snapshotting is fail-open: a non-git worktree or a transient git failure only
logs a warning and never fails the run.

## Endpoints

All three routes are mounted per execution workspace. Read routes need
`company_scope:read` on the workspace's company (a board member of the company
or an agent key of the same company); restore is a runtime-control action:
board-only plus `runtime:manage`. An agent key is rejected with `403`.

Errors carry a stable `code`: `turn_checkpoint_missing` (404),
`worktree_busy_by_active_run` (409), `worktree_has_uncommitted_edits` (409),
`worktree_missing` and `not_a_git_worktree` (422).

### GET /api/execution-workspaces/:id/turn-checkpoints?runId=

Lists the checkpoint refs of one run in turn order. Each entry carries
`runId`, `turnNumber`, `ref` and `commitSha`. `runId` is required.

### GET /api/execution-workspaces/:id/turn-checkpoints/diff?runId=&fromTurn=&toTurn=

Introspection: the turn→turn diff between two checkpoints of the same run.
Answers `runId`, `fromTurn`, `toTurn`, `fromCommitSha`, `toCommitSha`, `stat`
(`git diff --stat`), `patch` and `truncated`. The patch is capped at 512 KiB;
a larger patch is cut and marked `truncated: true`. `fromTurn` and `toTurn`
are integers ≥ 0; a missing ref on either side is `404 turn_checkpoint_missing`.

### POST /api/execution-workspaces/:id/turn-checkpoints/restore

Body: `{ "runId": "...", "targetTurnNumber": 3 }` (`reason` is optional and
only lands in the activity log). Rewinds the tracked working files **and the
index** of the worktree to the target checkpoint's tree (`git read-tree
--reset -u <commitSha>`). Untracked files are preserved, and the checked-out
branch ref never moves. On success the answer repeats `runId`,
`targetTurnNumber`, `ref`, `commitSha` and `refBefore` (the symbolic branch
before the restore, when HEAD was on a branch).

The write is audited as activity `execution_workspace.turn_checkpoint_restored`
with the run, turn, ref, commit and the workspace's source issue.

## The restore order of checks

Restore refuses before it changes anything. The checks run in this order, and
the first failure aborts with no mutation:

1. Worktree exists and is a git worktree (`worktree_missing` /
   `not_a_git_worktree`).
2. **Active-run contention** (`worktree_busy_by_active_run`, 409): another
   active run (`queued` or `running`) claims the same worktree — from a
   different execution workspace, or a different run of the same workspace in
   shared-workspace mode. Rewinding under a live run would corrupt its state;
   stop or wait for that run first.
3. The target ref resolves (`turn_checkpoint_missing`, 404).
4. **Uncommitted state safety** (`worktree_has_uncommitted_edits`, 409):
   uncommitted tracked state must equal the target checkpoint on *both* faces
   — the worktree (`git diff <commitSha>`) and the index
   (`git diff --cached <commitSha>`). Any divergence in either face refuses
   the restore and lists the first 20 paths in `details.paths`. This protects
   a foreign staged edit even when the worktree file was rewritten back to
   the checkpoint content: `read-tree --reset -u` resets the index too, and a
   worktree-only comparison would silently destroy such staged content.

Only when all checks pass does restore run `read-tree --reset -u`. Committed
history between HEAD and the target needs no protection: it stays reachable
at HEAD, and rewinding it is exactly what restore is for.

## Typical recovery

A run died mid-turn N. To restart turn N from the previous turn's state:

1. `GET .../turn-checkpoints?runId=...` — find the last completed turn
   (N-1) and its `commitSha`.
2. Make sure no other run is active on the worktree (otherwise expect 409
   `worktree_busy_by_active_run`).
3. `POST .../turn-checkpoints/restore` with
   `{"runId": "...", "targetTurnNumber": N-1}`.
4. Re-run the turn; `GET .../turn-checkpoints/diff?...&fromTurn=N-1&toTurn=N`
   shows what the repeated turn changed.
