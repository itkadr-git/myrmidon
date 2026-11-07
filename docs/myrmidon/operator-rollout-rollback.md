# OPE-8126 operator rollout and rollback

This change is template-only. Do not rename existing Docker volumes, run `down/up` manually, or alter a production project name.

## Rollout

1. On the target host, copy the release manifest and `deploy.env` into the existing install directory; preserve `MYRMIDON_DATABASE_URL`, `POSTGRES_PASSWORD`, volume names, and bind-mount paths.
2. Run `sudo bash install.sh --dir /var/lib/myrmidon --version myr-v1.6.6 --dry-run` and inspect the rendered `compose.yml`; confirm the board and dockergate image digests are pinned and the database profile is unchanged. This validates the generated Compose configuration without pulling images or changing running services.
3. Run the same installer without `--dry-run`. It creates a database dump before changing image digests and starts the stack through the generated Compose project.
4. Verify `docker compose --project-name myrmidon config` succeeds, then verify the board health endpoint and one authenticated read-only request. Record the installer log and dump location.
5. Keep the pre-upgrade dump and previous manifest until the release has passed its observation window.

## Rollback

1. Do not remove volumes or call `docker compose down`. Restore the previous manifest and run the installer against the same directory.
2. If the new board fails health checks, the installer restores the previous manifest/digests and starts the previous release automatically.
3. Verify the health endpoint and read-only request. If automatic rollback is also unhealthy, stop and escalate with the installer diagnostic dump; do not delete data.
4. Restore only from the dump with the database operator's approved procedure if a database-level rollback is explicitly required. The installer does not rename or delete legacy volumes.
