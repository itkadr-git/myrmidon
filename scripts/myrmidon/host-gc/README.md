# Myrmidon Host GC — Task Clone & Build Cache Scheduler

Host-side garbage collector for bot task clones and build caches on `vm-core` and `myr-dev-build`. Replaces the temporary `devbuild-v2-gc.sh`.

## Targets

| Host | Root | What |
|------|------|------|
| vm-core | `/srv/myrmidon-bots/*` | Bot workspaces (git clones) |
| vm-core | `<runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId>` | SSH runner run copies (OPE-12722); only when a runner root is configured, see below |
| myr-dev-build | `/srv/devbuild/*` | Build copies per agent/task |
| myr-dev-build | `/srv/devcache/*` | Build caches (git-wt, pnpm, etc.) |

## Policy

| Item | TTL | Condition |
|------|-----|-----------|
| Task clone (done/cancelled) | > 24 h | `git status` clean **and** all commits pushed **and** no stash **and** no alternates |
| Task clone (unsafe) | > 24 h | Archive to `.gc-archive/` first, then remove |
| Active checkout/worktree | — | Never touched |
| Build cache | > 72 h | LRU eviction by mtime |
| SSH runner run copy (`<runner root>/<runner>/workspace/.paperclip-runtime/runs/<runId>`, OPE-12722) | > 4 h (`--run-copy-ttl`, at least 3) | Counted from the run directory's own mtime (set when the run starts). Runs **only when a runner root is configured** (`--runner-root` / `HOST_GC_RUNNER_ROOTS`); a path through a symlink is skipped |
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
{"at":"2026-11-01T23:00:00.000Z","event":"run-copy-removed","path":"/srv/myrmidon-xfs/omp-runners/eng17/workspace/.paperclip-runtime/runs/<runId>","runner":"eng17","ageHours":6,"sizeBytes":1048576}
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

# Prune SSH runner run copies too (see below)
node scripts/myrmidon/host-gc/host-clone-cache-gc.mjs --apply \
  --runner-root /srv/myrmidon-xfs/omp-runners --run-copy-ttl 4
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

- the environment variable `HOST_GC_RUNNER_ROOTS=/srv/myrmidon-xfs/omp-runners` (colon-separated
  for several roots);
- `--runner-root <path>` on the command line (repeatable).

Which hosts get it:

- A host that installs the repo unit `systemd/myrmidon-host-gc.service` as is: the unit sets
  `HOST_GC_RUNNER_ROOTS` in its `Environment=` line, so the pass is enabled. A wrapper that calls
  the script does not inherit that line: it must set the variable or pass `--runner-root` itself.
- A wrapper that calls the script once per bot root should pass the runner root on **one**
  invocation only; otherwise the pass repeats once per bot (harmless: the repeats find nothing to
  remove, but the journal gets noisy).

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
