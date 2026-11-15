# Bot container workspace (1.6.9)

> Русская версия: bot-container-workspace.ru.md

Agents of the adapters `hermes_gateway` and `omp_local` work in their own
container. Their code lives in the task directory of the bot,
`/workspace/<ISSUE>`, on the bot disk. The board does not run code for them
and keeps no copy of the repository for them.

## What the board does for such a run

- It creates no git worktree.
- It hands out no checkout of the shared project workspace.
- It clones nothing and creates no directory for the project on its own disk:
  no managed checkout, no clone temp directory, no referenced-project copies.
  `repoUrl` and `repoRef` are read from the project workspace row.
- It records one `execution_workspaces` row per task: mode
  `isolated_workspace`, strategy `bot_container`, provider `adapter_managed`,
  cwd `/workspace/<ISSUE>`. The run context (`paperclipWorkspace`) points at
  that directory.
- Two tasks of one agent get two rows. They do not conflict, and the message
  "the copy is held by another run" cannot appear for them.
- The next run of the same task reuses the row. A row left by an earlier
  board-side copy (`git_worktree`, `project_primary`) is not restored for such
  a task; a new `bot_container` row takes over.

The rule applies only to runs in `isolated_workspace` mode. A run in
`shared_workspace` mode keeps the shared project workspace of the board.

## Lease and cleanup

The row is the lease of the task: it is bound to the task, not to the run.
After the task is `done` or `cancelled`, the terminal sweep archives the row
without any git inspection. There is nothing on the board to delete. The task
directory on the bot disk follows the bot-disk policy (`general.botDisk`:
thresholds, scratch TTL, idle TTL).

## Adapters that run on the board host

A local adapter keeps the git worktree under `.paperclip/worktrees` of the
project. Before the board creates a worktree, it measures the partition (statfs
of the worktree directory). At or above
`general.botDisk.partitionRefuseOpenPercent` (default 90) the board refuses
with the code `WORKTREE_PARTITION_FULL`. The message names the partition fill
and the threshold. Free disk space or change the threshold, then retry the
run. Reuse of an existing worktree is never refused. The terminal sweep removes
the worktree after the task is `done` or `cancelled`.

## Safe order to enable isolation

1. Deploy a build that contains the `bot_container` strategy.
2. Check that a `hermes_gateway` task gets a row with strategy `bot_container`
   and that `.paperclip/worktrees` of the project stays empty.
3. Only then enable `experimental.enableIsolatedWorkspaces` and the project
   policy `isolated_workspace`.
4. Watch the root disk of the board host for two hours.
