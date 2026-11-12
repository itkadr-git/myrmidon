# Myrmidon Host GC — Task Clone & Build Cache Scheduler

Host-side garbage collector for bot task clones and build caches on `vm-core` and `myr-dev-build`. Replaces the temporary `devbuild-v2-gc.sh`.

## Targets

| Host | Root | What |
|------|------|------|
| vm-core | `/srv/myrmidon-bots/*` | Bot workspaces (git clones) |
| vm-core | `/srv/myrmidon-bots/*/hermes/cache/scratch/*` | Bot scratch directories (temp dirs) |
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
```

## Environment Configuration

Configuration variables can be provided in `/etc/myrmidon-host-gc.env`:
```bash
# Scratch TTL in hours (default: 12)
SCRATCH_TTL_HOURS=12
```

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
the next run on that runner starts — an idle runner keeps them. Pass the runners' root with
`--runner-root <path>` (repeatable) or `HOST_GC_RUNNER_ROOTS` (colon-separated): copies older
than `--run-copy-ttl` hours (default 4, above the 3-hour longest run) are removed and journaled
as `run-copy-removed`. A path that goes through a symlink is skipped. Without a runner root the
pass does nothing.
