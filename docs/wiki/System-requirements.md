# System requirements

> Русская версия: [System-requirements.ru](System-requirements.ru)

What a host needs to run a Myrmidon install. The values below come from the
product documentation and the deploy scripts
([`docs/myrmidon/deploy.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md),
[`scripts/myrmidon/deploy/deploy.env.example`](https://github.com/itkadr-git/myrmidon/blob/main/scripts/myrmidon/deploy/deploy.env.example)).
Where the docs name a number, it is quoted; where they do not, this page says
so instead of inventing one.

## Software (required)

From the deploy documentation — the deploy refuses to run without these:

- `bash` 4+
- `docker` with the `compose` and `buildx` plugins (buildx is needed to
  inspect the image digest: `docker buildx imagetools inspect`)
- `curl`, `jq`, `git`
- a clone of `itkadr-git/myrmidon` on the deploy host, whose `origin` points
  at `github.com/itkadr-git/myrmidon` — the deploy script checks the image
  commit against this clone
- a database dump command (`DUMP_COMMAND`, e.g. `pg_dump`) and, for a
  rollback with restore, a restore command (`RESTORE_COMMAND`, e.g.
  `pg_restore`)

The documentation names no specific OS distribution or version; any Linux
that runs current Docker with the compose and buildx plugins qualifies.

## Docker images

The board runs from the CI-built image `ghcr.io/itkadr-git/myrmidon`,
published by the **Myrmidon image** workflow. Only CI-built images from
`main` or a `myr-v*` tag are accepted by the deploy script — there is no
flag or setting that skips this check.

## Database

All board state lives in PostgreSQL. The predeploy check restores the dump
into a throwaway Postgres container (default image `postgres:16-alpine`);
its major version must be able to read the dump, because `pg_restore`
refuses an older server.

## Network and ports

- The board serves the UI and API on port `3100`
  (`HEALTH_URL=http://127.0.0.1:3100/api/health` in the example settings).
- The maintenance API lives on the same port
  (`/api/myrmidon/maintenance`).
- In `authenticated` deployment mode the anonymous `/api/health` shows the
  commit but not the version, so a board API key in a `0600` file
  (`HEALTH_TOKEN_FILE`) is required for the deploy's version check.
- fleetd (bots on other machines) needs a health URL
  (`MYR_FLEETD_HEALTH_URL`) reachable **from the deploy host** — without it
  the rollout refuses before it pulls anything. dockergate has no health
  URL by design: its socket answers only the board's main process, and it is
  proven by its own log lines.

## Memory

The run admission defaults document the memory the host is expected to keep
free ([`docs/myrmidon/guides/run-limits.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/guides/run-limits.md)):

- `minFreeHostMemoryMb` defaults to `15360` (15 GB) — a run starts only
  while the host keeps at least this much `MemAvailable`.
- `runMemoryEstimateMb` defaults to `300` MB — the budget counted per run
  against the free-memory check.

The documentation names no minimum or recommended absolute CPU/RAM sizes for
an install; it only names the free-memory floor above.

## Disk

- Board data lives under the data root (`/data` by default for the
  host-disk measurement, `MYRMIDON_HOST_DISK_DATA_ROOT`). The board measures
  the host disk fill on every scheduler tick and raises an attention signal
  at the threshold (default 85 %, critical from 95 %)
  ([`docs/myrmidon/host-disk.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/host-disk.md)).
- Every bot owns a directory on the host that runs its containers:
  `<MYRMIDON_BOT_VOLUME_ROOT>/<botKey>/{hermes,workspace,scratch}` — clones
  of working copies, scratch dumps, the bot's profile. Per-bot disk quotas
  are configured in the instance settings
  ([`docs/myrmidon/bot-disk-quota.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/bot-disk-quota.md)).
  Size this partition for the number of bots and their working copies; the
  docs name no fixed gigabyte figure — quota fields (`defaultQuotaMb`,
  `perCaste`, `perAgent`) are the operative knobs.
- Database dumps go to `DUMP_DIR`; the deploy aborts if the dump file is
  missing or smaller than `DUMP_MIN_BYTES` (1024 in the example).

## Deploy-time extras (optional)

- `MYRMIDON_PREDEPLOY_CHECK=1` (default) restores the predeploy dump into a
  throwaway Postgres and boots the new board and the new dockergate against
  it before the maintenance window — it needs a free local port
  (`MYRMIDON_PREDEPLOY_BOARD_PORT`, default `13110`) and the board's own
  env file.
- The systemd boot unit (`SYSTEMD_UNIT_NAME=paperclip.service`) is verified
  before anything changes; `SYSTEMD_UNIT_INSTALL=1` installs the canonical
  unit when none exists yet (needs root).
