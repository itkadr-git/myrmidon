# Workspace turn checkpoints

> Русская версия: [Workspace-turn-checkpoints.ru](Workspace-turn-checkpoints.ru)

Every completed agent turn of a run leaves a snapshot of the working
execution-workspace tree on that run's git worktree. The snapshot is a hidden
git ref `refs/myrmidon/turns/<runId>/<turnN>`. If a run dies in the middle of
a turn, the operator rewinds the worktree to the checkpoint of the previous
turn and restarts the turn from there — the repeated turn produces an
identical diff instead of piling onto half-finished edits (OPE-12738,
release 1.7).

State lives in git only — no schema migration; plain `git log`/`git branch`
do not show the refs, and they are never pushed to remotes.

## Ref naming and retention

- Refs live on the run's worktree under `refs/myrmidon/turns/<runId>/<turnN>`;
  turn numbers are per-run and monotonic from 1 (max existing + 1), so they
  survive a provider session restart mid-run.
- The snapshot records the worktree through a temporary index (an in-flight
  git operation in the live worktree is never corrupted) and chains `-p` to
  the previous turn's checkpoint of the same run. The checked-out branch and
  HEAD never move.
- Retention keeps the newest 10 refs per run; refs beyond the cap are pruned
  oldest-first when the next turn is snapshotted.
- Each completed turn logs a `paperclip.turn_checkpoint.created` line with
  `runId` and `turnNumber`. Snapshotting is fail-open and never fails a run.

## Endpoints

All routes are mounted per execution workspace. Reading needs
`company_scope:read` on the company; restore is board-only plus
`runtime:manage` (an agent key gets `403`). Errors carry a stable `code`:
`turn_checkpoint_missing` (404), `worktree_busy_by_active_run` (409),
`worktree_has_uncommitted_edits` (409), `worktree_missing` /
`not_a_git_worktree` (422).

- `GET /api/execution-workspaces/:id/turn-checkpoints?runId=` — the run's
  checkpoints in turn order (`runId`, `turnNumber`, `ref`, `commitSha`).
- `GET /api/execution-workspaces/:id/turn-checkpoints/diff?runId=&fromTurn=&toTurn=`
  — turn→turn diff: `stat`, `patch` (capped at 512 KiB, `truncated: true`
  beyond that) and the two commit SHAs.
- `POST /api/execution-workspaces/:id/turn-checkpoints/restore` with body
  `{"runId": "...", "targetTurnNumber": N}` — rewinds the tracked working
  files **and the index** to the checkpoint tree (`git read-tree --reset -u`).
  Untracked files survive; the branch never moves. Audited as
  `execution_workspace.turn_checkpoint_restored`.

## The restore order of checks

Restore refuses before it changes anything:

1. The worktree exists and is a git worktree.
2. No other active run (`queued`/`running`) claims the worktree — otherwise
   409 `worktree_busy_by_active_run`. Stop or wait for that run first.
3. The target ref resolves — otherwise 404 `turn_checkpoint_missing`.
4. Uncommitted tracked state must equal the target checkpoint on both faces:
   the worktree (`git diff <commitSha>`) **and** the index
   (`git diff --cached <commitSha>`). Any divergence refuses with
   409 `worktree_has_uncommitted_edits` and lists up to 20 paths. This
   protects a foreign staged edit even when the worktree file was rewritten
   back to the checkpoint content — `read-tree --reset -u` resets the index
   too, so a worktree-only comparison would silently destroy staged content.

Only after all checks pass does restore run `read-tree --reset -u`.

Full guide: [workspace-turn-checkpoints](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/workspace-turn-checkpoints.md).
