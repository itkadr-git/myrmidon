# Myrmidon Host GC — Task Clone & Build Cache Scheduler

Host-side garbage collector for bot task clones and build caches on `vm-core` and `myr-dev-build`. Replaces the temporary `devbuild-v2-gc.sh`.

## Targets

| Host | Root | What |
|------|------|------|
| vm-core | `/srv/myrmidon-bots/*` | Bot workspaces (git clones) |
| vm-core | `/srv/myrmidon-bots/*/hermes/cache/scratch/*` | Bot scratch directories (temp dirs) |
| vm-core | `<runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId>` | SSH runner run copies (OPE-12722); only when a runner root is configured, see below |
| vm-core | `<runner root>/<runner>/{workspace,home}/OPE-*`, `wt-ope*` | SSH runner task folders (OPE-12855); only when a runner root is configured, see below |
| vm-core | `<runner root>/<runner>/home/.npm/{_cacache,_npx}` | SSH runner agent npm/npx caches (OPE-12855); only when a runner root is configured, see below |
| vm-core | `<runner root>/<runner>/tmp/*` | SSH runner `/tmp` entries (OPE-12966); only when a runner root is configured, see below |
| myr-dev-build | `/srv/devbuild/*` | Build copies per agent/task |
| myr-dev-build | `/srv/devcache/*` | Build caches (git-wt, pnpm, etc.) |

## Policy

| Item | TTL | Condition |
|------|-----|-----------|
| Task clone (done/cancelled) | > 24 h | `git status` clean **and** all commits pushed **and** no stash **and** no alternates |
| Task clone (unsafe) | > 24 h | Archive to `.gc-archive/` first, then remove |
| Active checkout/worktree | — | Never touched |
| Bot data directory (`/srv/myrmidon-bots/<bot-uuid>`, OPE-12654) | > 24 h | No `myrmidon-bot-<key>` container of any state **and** the board lists no `hermes_gateway` card for the agent (moved away, terminated or deleted) **and** no heartbeat run of the agent is `running` **and** no git worktree under `workspace/` holds unpushed work (uncommitted edits, stash, an operation in progress, commits on no remote). The quota project entries (`/etc/projid`, `/etc/projects`) are cleared after the removal |
| Build cache | > 72 h | LRU eviction by mtime |
| SSH runner run copy (`<runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId>`, OPE-12722) | > 4 h (`--run-copy-ttl`, at least 3) | Counted from the run directory's own mtime (set when the run starts). Runs **only when a runner root is configured** (`--runner-root` / `HOST_GC_RUNNER_ROOTS`); a path through a symlink is skipped |
| SSH runner npm/npx cache (`<runner root>/<runner>/home/.npm/{_cacache,_npx}`, OPE-12855) | > 4 h (`--npm-cache-ttl`, at least 1) | Counted from the **newest mtime in the cache tree**, so a cache an npm/npx call is still writing stays fresh; npm refills everything on demand. A symlinked `.npm` or cache dir is skipped. Runs **only when a runner root is configured** (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), the same gate as the run-copy pass |
| SSH runner task folder (`<runner root>/<runner>/{workspace,home}/OPE-<n>[,-wt]`, `wt-ope<n>`, OPE-12855) | > 24 h (clone TTL) | Issue `done`/`cancelled` on the board **and** every git repo inside is clean, pushed, stash-free and alternates-free → remove; dirty/unpushed or a git state that cannot be read (a worktree with a dead gitdir) → archive to `<runner root>/.gc-archive/` first, then remove; any other issue status or an unreachable board → keep. Runs **only when a runner root is configured** (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), the same gate as the run-copy pass |
| Bot scratch item | > 12 h (env configurable) | All tree mtimes > threshold; ignore `gh-cli-cache`; skip if open by running process |
| `state.db`, `session`, `auth`, `credential`, `.git` | — | Never deleted |

## Atomic Guards

- **Lockfile**: `/var/run/myrmidon-host-gc.lock` prevents concurrent runs.
- **Symlink checks**: root, parent, and target must not be symlinks.
- **TOCTOU-safe rename**: file is renamed to an unpredictable temp name inside the verified parent dir, re-validated, then unlinked.
- **Path containment**: every deletion is verified to stay inside the canonical root.

## Journal

Every action is appended as JSONL to `/var/log/myrmidon-host-gc.jsonl`:

```json
{"at":"2026-11-01T23:00:00.000Z","event":"clone-removed","path":"/srv/myrmidon-bots/OPE-12345","reason":"clean-pushed"}
{"at":"2026-11-01T23:00:00.000Z","event":"clone-archived","path":"/srv/myrmidon-bots/OPE-12346","archive":"/srv/myrmidon-bots/.gc-archive/OPE-12346-20261101-230000.tar.zst"}
{"at":"2026-11-01T23:00:00.000Z","event":"cache-removed","path":"/srv/devcache/git-wt/abc123","reason":"ttl","sizeBytes":12345678}
{"at":"2026-11-01T23:00:00.000Z","event":"scratch-pruned","path":"/srv/myrmidon-bots/eng-16/hermes/cache/scratch/myrmidon-migrate-123","sizeBytes":1048576}
{"at":"2026-11-01T23:00:00.000Z","event":"run-copy-removed","path":"/srv/myrmidon-xfs/omp-runners/eng17/workspace/.paperclip-runtime/runs/<runId>","runner":"eng17","ageHours":6,"sizeBytes":1048576}
```

## Environment Configuration

Configuration variables can be provided in `/etc/myrmidon-host-gc.env`:
```bash
# Scratch TTL in hours (default: 12)
SCRATCH_TTL_HOURS=12
# SSH runner root for the run-copy pass (OPE-12722); unset = the pass is off
HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners
```

The file is read on every invocation of the script. See "SSH runner run copies" below for what
`HOST_GC_RUNNER_ROOTS` does and when to set it.

## Usage

```bash
# Dry-run (default)
node scripts/myrmidon/host-gc/host-clone-cache-gc.mjs --dry-run

# Apply
node scripts/myrmidon/host-gc/host-clone-cache-gc.mjs --apply

# Custom root / journal / lock (for testing)
node scripts/myrmidon/host-gc/host-clone-cache-gc.mjs \
  --root /tmp/test-root \
  --journal /tmp/test-journal.jsonl \
  --lock /tmp/test.lock \
  --clone-ttl 48 \
  --cache-ttl 96
```

## systemd Deployment

Copy the unit files from `systemd/` to `/etc/systemd/system/`:

```bash
sudo cp systemd/myrmidon-host-gc.service /etc/systemd/system/
sudo cp systemd/myrmidon-host-gc.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now myrmidon-host-gc.timer
```

The timer runs every 2 hours. The service is `Type=oneshot` and exits after one pass.

This is the repo unit. A host that does not install it as is (vm-core runs a wrapper,
`/usr/local/sbin/myrmidon-host-gc`, from its own unit) does not inherit its `Environment=` lines:
see "SSH runner run copies" below for the one that matters, `HOST_GC_RUNNER_ROOTS`.

## Restore / Rollback

1. **Stop the timer**: `sudo systemctl stop myrmidon-host-gc.timer`
2. **Inspect the journal**: `sudo tail -f /var/log/myrmidon-host-gc.jsonl`
3. **Restore an archived clone**:
   ```bash
   sudo tar -xf /srv/myrmidon-bots/.gc-archive/<NAME>-<ts>.tar.zst -C /srv/myrmidon-bots/
   ```
4. **Re-run in dry-run mode** to verify the plan before re-enabling.

## Replacement of `devbuild-v2-gc.sh`

The temporary `devbuild-v2-gc.sh` script is superseded by this scheduler. Remove it after the first successful `--apply` run:

```bash
sudo rm /usr/local/bin/devbuild-v2-gc.sh
```

## Board status guard

Task clones are eligible only when the Paperclip board reports `done` or `cancelled`, in addition to the TTL and git safety checks. Set `BOARD_API_URL` to the board base URL reachable from the host (for example, the host-published board URL); the collector requests `GET /api/issues/{identifier}` and sends `PAPERCLIP_API_KEY` as a bearer token when present. A missing/unreachable board, non-2xx response, or malformed issue is fail-closed and journaled as `clone-skipped`.

The default remains dry-run. Do not enable `--apply` in the timer or service until this change has been reviewed and approved by the owner.

## Bot data directories of decommissioned bots (OPE-12654)

The dockergate decommission route (A22) deletes the containers of a bot whose agent left the
bot runtime, but not its data directory: the gate runs as uid 65532 and holds the volume root
read-only. The gate logs `bot_data_left_for_host_gc` and leaves the directory to this pass.
A directory named by a lowercase UUID bot key is removed by `--apply` only when every guard
says go: older than 24 h, no `myrmidon-bot-<key>` container of any state (`docker ps -a`,
label `myrmidon.bot`), the board reports the agent as moved away from `hermes_gateway`,
terminated or deleted (`GET /api/agents/{id}`), no heartbeat run of the agent is `running`,
and no git worktree under `workspace/` holds unpushed work. `.next` and `.helper` directories
are not worktrees and are never touched. A held directory is journalled with the reason
(`bot-data-held-unpushed`, `bot-data-board-unavailable`, `bot-data:retention`,
`bot-data:container-exists`, `bot-data:agent-on-hermes-gateway`,
`bot-data:agent-has-running-run`); an unreachable docker daemon or board skips the whole
section (fail-closed). After a removal the pass clears the bot's XFS quota project entries
(`/etc/projid`, `/etc/projects`, the `xfs_quota` limits) best-effort.

## Tests

```bash
node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
```

## SSH runner run copies (OPE-12722)

An SSH runner (the container an `omp_local` agent runs in) keeps one copy of the workspace
per run under `<runner>/workspace/.paperclip-runtime/runs/<runId>`. A failed or cancelled run
never reaches the restore that removes its copy, and the adapter prunes old copies only when
the next run on that runner starts, so an idle runner keeps them.

**The pass runs only when a runner root is configured; without one it does nothing.** Configure
it in either of two ways:

- the env file `/etc/myrmidon-host-gc.env`, line `HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners`
  (colon-separated for several roots); the script reads the file on every invocation;
- `--runner-root <path>` on the command line (repeatable).

Which hosts get it:

- A host that installs the repo unit `systemd/myrmidon-host-gc.service` as is: the unit sets
  `HOST_GC_RUNNER_ROOTS` in its `Environment=` line, so the pass is enabled.
- vm-core: the live unit runs the wrapper `/usr/local/sbin/myrmidon-host-gc`, which calls the
  script once per `/srv/myrmidon-bots/*/workspace` and reads `/etc/myrmidon-host-gc.env`. The
  repo unit's `Environment=` line does not apply there, so the pass is off until the root is
  put in the env file or the wrapper passes `--runner-root`.
- A wrapper that calls the script once per bot root should pass the runner root on **one**
  invocation only. The env file is read by every invocation, so with the root in it the pass
  repeats once per bot (harmless: the repeats find nothing to remove, but the journal gets noisy);
  to run it once, leave the root out of the env file and add `--runner-root` to a single call.

What the pass does:

- A copy is removed when it is older than `--run-copy-ttl` hours (default 4, the same as the
  adapter's own prune, `REMOTE_RUN_DIR_RETENTION_MINUTES`). The age is counted from the run
  directory's own mtime, which is set when the run starts; files written deeper inside the copy
  do not extend it. The TTL must be a finite number of at least 3 hours (the longest run
  timeout): anything else makes the script exit with an error and remove nothing.
- Every component of `<runner>/workspace/.paperclip-runtime/runs` must be a real directory; a
  path through a symlink is skipped. Each removal is guarded against the runner root, so a
  `workspace` swapped for a symlink between the scan and the removal is refused
  (`run-copy-remove-failed`).
- `run-copy-removed` carries `runner`, `ageHours` and `sizeBytes` (apparent size, measured
  before the removal, best-effort). `runCopiesRemoved` in `apply-complete` counts the copies
  actually removed. A copy younger than the TTL is listed in the dry-run `plan.kept` with
  reason `fresh`.
- A runner root that does not exist is journaled as `run-copy-root-missing`; an unreadable root
  or runner directory as `run-copy-scan-failed` (root, runner, error). Neither stops the rest of
  the pass or the other passes of the same `--apply`.

## SSH runner task folders (OPE-12855)

An SSH runner keeps one task folder per board issue it ever checked out: the clone folder
`<runner>/workspace/OPE-<n>/` (with the repo inside) and worktree folders
(`<runner>/workspace/OPE-<n>-wt/`, `<runner>/home/wt-ope<n>`), whose `.git` file points into a
run directory that is deleted when the run ends. Nothing removed them: on 11.11 four runners
held 41.5 GB of folders of long-closed issues and the bots volume stood at 91%.

The pass shares the gate of the run-copy pass above: it runs only when a runner root is
configured (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), per the same host matrix. What it does:

- A folder is a candidate when it is older than the clone TTL (24 h, `--clone-ttl`, by the
  folder's own mtime) and its name parses an issue identifier (`OPE-<n>`, `OPE-<n>-wt`,
  `wt-ope<n>`). The board is asked for the issue status (`GET /api/issues/{identifier}`, the
  same board guard as the task clones). A folder of an issue in any other status is kept
  (`issue-status:<status>`); an unreachable board keeps the folder (fail-closed,
  `board-unavailable`).
- The folder is removed when every git repository found inside (the folder itself, `repo/`,
  or nested up to depth 3; `.next`, `.helper`, `node_modules`, `.gc-archive` are not walked) is
  clean, fully pushed, stash-free and alternates-free. A folder with no git repository at all
  is removed outright (`no-git-repos`).
- Unpushed work, or a git state that cannot be proven from the host (a worktree whose gitdir
  is gone fails every git command) → the folder is archived to `<runner root>/.gc-archive/`
  first (zstd/tar.gz + verification) and removed only after the archive verifies — the archive
  is the safety net for work the host could not inspect.
- Every removal is guarded against the runner root (`runner-task-folder-remove-failed` on a
  containment violation); a missing root is journaled as `runner-folder-root-missing`, an
  unreadable root or runner as `runner-folder-scan-failed`. Neither stops the rest of the
  pass. `runnerTaskFoldersRemoved` in `apply-complete` counts the folders actually removed.

## SSH runner npm/npx caches (OPE-12855)

A runner agent's `home/.npm` holds the npm download/index cache (`_cacache`) and the npx
package cache (`_npx`). npm refills both on demand, so removing them costs a re-download and
nothing else — but an aggressive rm under a live `npm install` breaks the install. The pass:

- runs only when a runner root is configured (`--runner-root` / `HOST_GC_RUNNER_ROOTS`), the
  same gate as the run-copy and task-folder passes;
- age = the **newest mtime in the cache tree** (`inspectPathTree`), so a cache an npm/npx call
  is still writing is `fresh` no matter how old the cache root is; default TTL 4 h
  (`--npm-cache-ttl` / `MYRMIDON_HOST_GC_NPM_CACHE_TTL_HOURS`), refused below 1 h (the longest
  an npm install may run);
- skips a symlinked `.npm` or cache directory (never follows out of the runner home) and
  guards every removal against the runner root (`atomicDrop`), so a `.npm` swapped for a
  symlink after the scan is refused (`runner-npm-cache-remove-failed`), not deleted through;
- journals `runner-npm-cache-removed` (with `kind: _cacache|_npx` and `sizeBytes` measured
  before the removal), `runner-npm-cache-remove-failed`, `runner-npm-cache-root-missing`,
  `runner-npm-cache-scan-failed`; a missing/unreadable root never stops the rest of the pass.
  `runnerNpmCachesRemoved` in `apply-complete` and the stdout JSON counts the caches actually
  removed; the dry-run event carries `runnerNpmCaches` and the plan lists each cache with its
  action.

## SSH runner /tmp (OPE-12966)

The omp SSH runner's `/tmp` is a bind volume on the data disk, `<runner>/tmp`
(`docker/agent-runtime/omp-ssh/compose.yml`), instead of the container's write layer on the
host's root disk. Tests and task tooling write gigabytes there (15.8 GB in two days on 13.11,
a host disk alarm) and nothing removed them.

The pass shares the gate of the run-copy pass: it runs only when a runner root is configured
(`--runner-root` / `HOST_GC_RUNNER_ROOTS`; the repo unit `systemd/myrmidon-host-gc.service`
sets it, so a host that installs the unit gets the pass on `--apply` without further
configuration). What it does:

- The candidates are the top-level entries (files and directories) of `<runner>/tmp`. An
  entry is removed when nothing inside it has changed for `--runner-tmp-ttl` hours (default
  24; a finite number of at least 3): the age is the newest mtime of the entry and everything
  under it, so a directory in which something was written within the TTL stays whole.
- `<runner>` and `tmp` must be real directories (a symlink is skipped). A symlink is never
  followed: a top-level symlink is kept (`runner-tmp-skipped`, reason `symlink`), one inside an
  entry is removed as a link, never through. An entry that is, or contains, a mount of another
  filesystem is kept (`other-filesystem`). `tmp` itself is never removed. Each removal is
  guarded against the runner root, as for the run copies (`runner-tmp-remove-failed`).
- `--dry-run` lists the entries to remove in `plan.runnerTmp` and removes nothing.
  `runner-tmp-removed` carries `runner`, `ageHours` and `sizeBytes` (apparent size);
  `runnerTmpRemoved` in `apply-complete` and in the printed JSON counts the entries removed.
- A missing root is journaled as `runner-tmp-root-missing`, an unreadable root, runner or
  entry as `runner-tmp-scan-failed` (the entry is kept). Neither stops the rest of the pass.
