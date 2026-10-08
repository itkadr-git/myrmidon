# Upgrading and rollback

> Русская версия: [Upgrading-and-rollback.ru](Upgrading-and-rollback.ru)

## Upgrading with the installer (the usual way)

On a server installed with the one-line command, updating is the same
command again:

```sh
curl -fsSL https://github.com/itkadr-git/myrmidon/releases/latest/download/install.sh | sudo bash
```

The installer resolves the latest release, **dumps the database before
anything changes**, switches to it and waits for the board to answer. If the
new board does not come up healthy, it **rolls back to the previous release
on its own** and keeps the dump. A specific release:
`install.sh --version myr-vX.Y.Z`. Pre-releases (RC) are never served by the
one-line command — it follows the newest **stable** release; an RC installs
only when asked for by its exact tag.

## Upgrading with deploy.sh (manual flow)

For servers managed by hand the deploy script is the path — see
[Manual deployment](Manual-deployment). Per-release operator notes live in
[`docs/myrmidon/deploy.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md),
and the changelog names the release each change landed in.

## Upgrading

The rest of this page describes the manual `deploy.sh` flow for servers
managed by hand — the full procedure lives in
[Manual deployment](Manual-deployment); here is the operator reference.

Upgrading uses the same script as installing:

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --digest sha256:<new digest>
```

or, for a published release, with digest resolution from the release
manifest (`release-components.json`, uploaded as a release asset):

```sh
scripts/myrmidon/deploy/deploy.sh --config /path/to/deploy.env --release myr-vX.Y.Z
```

What the deploy does, in order:

1. **CI-image gate** — before any action (before `docker pull`, the dump,
   maintenance): only an image built by CI from `main` or a `myr-v*` tag
   passes. There is no bypass flag.
2. **Database dump** — `DUMP_COMMAND` into `DUMP_DIR`; a missing or too
   small file aborts the deploy.
3. **Predeploy check on a database copy** (`MYRMIDON_PREDEPLOY_CHECK=1`,
   default) — the dump is restored into a throwaway Postgres, the new board
   and the new dockergate of the same release are started against the copy,
   `/api/health` must report `ok` with the new version and commit, and the
   walked routes must answer. Any failure stops the deploy **before** the
   maintenance window: production is never touched.
4. **One maintenance window** — the board, dockergate, fleetd and the bot
   image list roll together. A component already on the release image is not
   restarted.
5. **Health proof** — the board by `/api/health` (version and commit),
   dockergate by its log (`self-check ok` / `config_reloaded` naming the new
   binary version and config hash), fleetd by its health probe.
6. **All or nothing** — a component failure inside the window rolls the
   changed components, the dockergate config and the board back together
   (`MYRMIDON_COMPONENT_AUTO_ROLLBACK=1`, default). Bot cards switch in
   batches of at most 5, each bot only while its agent is paused or idle —
   a run is never interrupted.

The deploy also manages the PostgreSQL server settings (since 1.6.5,
DB-TUNING): the declarative source lives in the repository
(`scripts/myrmidon/deploy/db-tuning.sql`), the deploy applies it through
`DB_TUNE_COMMAND` and then verifies every `DB_TUNE_EXPECTED` pair with
`SHOW` — a mismatch is a failed deploy, and the previous values (recorded
before the first managed apply) are returned at once. A rollback returns
the settings through `DB_TUNE_ROLLBACK_COMMAND` and verifies them against
the recorded previous values. All four `DB_TUNE_*` settings are optional;
with an empty `DB_TUNE_COMMAND` the step is skipped and the database
keeps whatever settings it has. The values, the verification flow and the
`pg_stat_statements` query for the before/after measurement are in
[`docs/myrmidon/deploy.md`](https://github.com/itkadr-git/myrmidon/blob/main/docs/myrmidon/deploy.md).

## Release candidates and final releases (since 1.6.5)

A release goes through a trial run before it becomes **Latest** on GitHub:

1. **RC tag.** `myr-vX.Y.Z-rc.N` builds every component image as
   `X.Y.Z-rc.N`; the GitHub publish goes out as a **pre-release** and never
   moves the `latest` marker.
2. **RC deploy.** `deploy.sh --release myr-vX.Y.Z-rc.N` works like any
   release — deploying the RC *is* the trial run of the release flow.
3. **Production proof.** Health on `X.Y.Z-rc.N`, no new damage in the
   attention list, the fleet takes tasks, bot images applied.
4. **Final tag.** When the RC is accepted, `myr-vX.Y.Z` is tagged on the
   SAME commit — no rebuild; the image workflow re-tags the same images and
   the final release is published, still without `latest`.
5. **Promote to Latest — a separate step**, only when the final release runs
   in production and passed smoke:

   ```sh
   scripts/myrmidon/release/promote-latest.sh --tag myr-vX.Y.Z \
     --health-url https://<board>/api/health --health-token-file <board-key-file>
   ```

   The command refuses if the tag is a candidate, the release is a
   pre-release, the release commit is not on `main`, or the board reports
   any version other than `X.Y.Z`.

## Rollback

```sh
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env                          # to the previous image
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --to sha256:<64 hex>
scripts/myrmidon/deploy/rollback.sh --config /path/to/deploy.env --local                  # to a local image, without pulling (since 1.6.0)
```

- The rollback returns the image and verifies health against the old image's
  labels. **The database is not restored** by default; restoring is a
  separate, explicit path (`--restore-dump` with `RESTORE_COMMAND`, the
  script asks to type `RESTORE`).
- Rollback does not need a live board and is **not** blocked by the
  CI-images-only gate: it is the emergency path.
- A board rollback does not roll back the components, and a component
  rollback does not touch the board.
- **Automatic rollback by health** (`AUTO_ROLLBACK=1`, default since 1.4.0):
  when a deploy started from the board interface fails its health check, the
  host executor immediately runs `rollback.sh` to the image the deploy
  remembered before the switch.

## A board on the shared PostgreSQL 18 server (since 1.6.5)

Everything on this page works unchanged when the board's database lives on
the shared PostgreSQL 18 server instead of the bundled container (see
[Installation](Installation)): the deploy script talks to the database only
through the commands in the settings file, so pointing them at the shared
server is all it takes.

**Client tools.** `pg_dump`, `pg_restore` and `psql` on the deploy host must
come from a PostgreSQL **18** or newer client package: PostgreSQL refuses a
dump taken by a client older than the server (`pg_dump: aborting because of
server version mismatch`). On Ubuntu/Debian the current client comes from
the PostgreSQL repository (`sudo apt-get install postgresql-client-18`).

**Backup and restore commands** for the settings file — the same shape
`deploy.env.example` documents, pointed at the shared server by its
connection string, and always naming **only the board's own database** (the
neighboring databases of the other programs are not the board's to touch):

```sh
# The board database's connection string on the shared server; the password
# stays out of the file and the process list (PGPASSWORD, a .pgpass line or
# a locally mapped socket). USER, HOST and DATABASE come from your
# administrator.
DATABASE_URL='postgres://USER@HOST:5432/DATABASE'

DUMP_COMMAND='pg_dump "$DATABASE_URL" -Fc -f "$DUMP_FILE"'
RESTORE_COMMAND='pg_restore "$DATABASE_URL" --clean --if-exists --no-owner --no-acl < "$DUMP_FILE"'
```

`pg_dump`/`pg_restore` take the host, login and database straight from the
connection string, so the commands need no separate `-h`/`-U`/`-d` flags.
Two details matter:

- `--no-owner --no-acl`: the dump carries ownership and grants of the roles
  it was taken with; on restore they must give way to the board's own role
  on the shared server, or `pg_restore` aborts on roles that exist only
  where the dump was taken.
- After a restore, refresh the planner statistics — `pg_restore` loads rows
  but not statistics, and until they are refreshed queries can run far
  slower than usual:

  ```sh
  psql "$DATABASE_URL" -c ANALYZE
  ```

**The predeploy check on a database copy** (`MYRMIDON_PREDEPLOY_CHECK=1`)
needs no changes beyond its image: set
`MYRMIDON_PREDEPLOY_POSTGRES_IMAGE=pgvector/pgvector:pg18` (or another
PostgreSQL 18 image with the pgvector extension) so the throwaway copy
matches the shared server's major version and carries the extension the
board's database needs — `pg_restore` refuses to load a dump into an older
server, and the check fails clearly when the copy lacks a required
extension.
The check still restores the dump into a throwaway container of its own,
never into the shared server, and its default restore command already
carries `--no-owner --no-acl` and runs `ANALYZE` afterwards.

**Moving an existing production database onto the shared server** is a
one-time task the board's operator performs with **logical replication,
without downtime** — it is deliberately not part of these scripts. (The
decision to keep one shared PostgreSQL 18 server for the board, the LLM
gateway, tracing and agent memory is the owner's storage decision; each
program keeps its own database and role there.)
