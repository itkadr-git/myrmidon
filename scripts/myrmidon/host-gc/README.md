# Myrmidon Host GC — Task Clone & Build Cache Scheduler

Host-side garbage collector for bot task clones and build caches on `vm-core` and `myr-dev-build`. Replaces the temporary `devbuild-v2-gc.sh`.

## Targets

| Host | Root | What |
|------|------|------|
| vm-core | `/srv/myrmidon-bots/*` | Bot workspaces (git clones) |
| myr-dev-build | `/srv/devbuild/*` | Build copies per agent/task |
| myr-dev-build | `/srv/devcache/*` | Build caches (git-wt, pnpm, etc.) |

## Policy

| Item | TTL | Condition |
|------|-----|-----------|
| Task clone (done/cancelled) | > 24 h | `git status` clean **and** all commits pushed **and** no stash **and** no alternates |
| Task clone (unsafe) | > 24 h | Archive to `.gc-archive/` first, then remove |
| Active checkout/worktree | — | Never touched |
| Build cache | > 72 h | LRU eviction by mtime |
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

## Tests

```bash
node --test scripts/myrmidon/host-gc/host-clone-cache-gc.test.mjs
```
