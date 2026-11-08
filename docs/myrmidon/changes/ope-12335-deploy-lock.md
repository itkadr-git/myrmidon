# OPE-12335: deploy.sh deploy lock hardening

- Added exclusive deploy locking (`flock`) at the beginning of `scripts/myrmidon/deploy/deploy.sh` via `acquire_deploy_lock` in `lib.sh`.
- Supports `MYRMIDON_DEPLOY_LOCK_FILE` (defaults to `$STATE_DIR/executor.lock`) and `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` (defaults to 0).
- Dry-run mode checks the lock and warns if held without acquiring it.
- Automatically releases the lock via a trap on EXIT, INT, and TERM.
- Stores process metadata (PID, UTC start time, and deploy script version) in the lock file for informative error diagnostics.
- Documented `MYRMIDON_DEPLOY_LOCK_FILE` and `MYRMIDON_DEPLOY_LOCK_WAIT_SEC` in `docs/myrmidon/SETTINGS.md` and `docs/myrmidon/SETTINGS.ru.md`.
