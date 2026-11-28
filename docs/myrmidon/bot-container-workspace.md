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
  default cwd `/workspace/<ISSUE>`. The run context (`paperclipWorkspace`) points at
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

On reuse, `myr-ws open` and the idle botd `myr-ws repair` leave unfinished
merge, rebase, cherry-pick, revert and am operations and unresolved index
stages in place for the task's next run. They do not abort these operations or
reset the index. A branch switch requested during an unfinished operation is
not performed; finish or abort the operation explicitly before switching.

## Offline checkout on a persistent volume

A board operator with `runtime:manage` in the company calls
`POST /api/companies/:companyId/issues/:issueId/offline-bot-workspace`.
Use lowercase canonical UUIDs for the company, issue and bot, not an issue key.
The first request requires an unassigned standard project issue without an
existing workspace binding and a running managed `hermes_gateway` in the company.

1. Send `{"action":"reserve","botId":"<bot UUID>"}`. The response
   `{id: null, cwd}` reserves a directory, not a registered checkout. The path is
   `<canonical Hermes home>/offline-workspaces/<companyId>/<issueId>` on the
   managed persistent bot volume, outside `/workspace`.
2. Prepare an existing standalone checkout at `cwd`, with its own `.git`
   directory, no linked worktree, symlinks or external Git object store. The
   owner and group must match the runtime UID and GID; the directory must be `0700`.
   It must be the worktree root and have a locally available HEAD commit. An
   empty `git init` is not enough; validation disables Git transports.
3. Send `{"action":"register","botId":"<bot UUID>"}`. A response `{id, cwd}`
   means the workspace is bound atomically to the issue. Registering again with
   the same bot and unchanged directory identity returns the same workspace UUID.
4. Start the issue through the normal swarm. The next swarm wake checks the
   binding and preserves UUID and cwd without `myr-ws open` or network Git
   operations when opening the workspace. An incompatible runtime or a changed
   owner, path, volume or directory identity stops the run without fallback.
   Reservation, registration and opening also reject nested mounts between the
   persistent volume and Hermes home or inside the checkout, including bind
   mounts on the same device.

The lease belongs to the issue UUID, not the run. After the row is archived,
the persistent directory remains under operator management, outside normal
`/workspace` cleanup. A physical directory cannot be assigned to two issues;
`0700` does not isolate tasks that share a UID.

After deployment, compare the UUID and cwd of two swarm runs. In the target
runtime, compare `realpath "$cwd"`, `findmnt -T "$cwd" -o TARGET,SOURCE,FSTYPE,OPTIONS`
and `stat -Lc '%n %u:%g %a %d:%i' "$cwd"` for both runs.

## Bare bases with extensions.worktreeConfig

A task copy is a linked git worktree of the shared bare base of the repository
(the class-D base under the bot home). A base can also carry the git extension
`extensions.worktreeConfig=true`. In that shape git never writes the
`config.worktree` of a new worktree, so the copy would inherit `core.bare=true`
from the base: `git rev-parse` works there, but `git status`, `read-tree` and
sparse checkout refuse with "this operation must be run in a work tree".

`myr-ws` handles such bases itself:

- After `git worktree add`, `myr-ws open` writes `core.bare=false` into the
  copy's own `config.worktree` (inside the administrative git directory of the
  copy). The common config of the base is not touched; the base stays bare.
- A copy left half-created by an earlier `open` (only its `.git` file, no
  checkout) is healed, not rejected: on reuse, `open` and the janitor
  `myr-ws repair` (botd) fix the config and then materialize the checkout a
  fresh open would have created. HEAD, the checked-out branch, the index and
  untracked files of the copy are preserved; nothing is reset or deleted. The
  base stays bare and gains no `config.worktree`.
- `repair` skips a copy with a live process inside it.
- A review copy healed this way gets a normal checkout; `open --review`
  already warns when it reuses an existing copy instead of recreating it.

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
