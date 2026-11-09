# Runbook: T9 Central Standby (Option A2)

This runbook defines the operational procedures for the central database warm standby (Board database `paperclip` and `myrmidon_hindsight`) on `myr-vm1`, supporting automatic and manual failover with RPO <= 15 minutes and RTO <= 30 minutes.

---

## 1. Architecture & Topology

- **Primary Site (`vm-core`)**:
  - Hosts single production PostgreSQL 18 cluster `myrmidon-pg` on port `5432`.
  - Contains both `paperclip` board database (~13 GB) and `myrmidon_hindsight` vector database (~19 GB); total cluster ~45 GB.
  - Configured with `wal_level = logical`, `archive_mode = off`, continuous WAL streaming to replication slot `standby_board_slot`.
- **Standby Site (`myr-vm1`)**:
  - Connected to `vm-core` via secure IPsec tunnel.
  - Hosts a single warm standby PostgreSQL cluster in isolated directory and port:
    - **Cluster Standby**: port `5433` (maps to container `5432`), data directory `/srv/standby/myrmidon-pg/data`.
    - Physical streaming replication replicates the entire cluster (both `paperclip` and `myrmidon_hindsight` databases).
  - Operates in `hot_standby = on` mode with continuous streaming replay and WAL archive fallback (`restore_command`).
  - Does NOT alter or conflict with local host workloads or bots running on `myr-vm1`.

---

## 2. Prerequisites & Credentials

1. **Replication Role**:
   A dedicated replication role on the primary PostgreSQL cluster:
   ```sql
   CREATE ROLE myr_replicator WITH REPLICATION LOGIN PASSWORD '...';
   ```
2. **Client Authentication (`pg_hba.conf`)**:
   Allow replication user access from standby host over the internal IPsec tunnel:
   ```text
   host replication myr_replicator <standby-host-ip>/32 scram-sha-256
   host paperclip,myrmidon_hindsight myr_replicator <standby-host-ip>/32 scram-sha-256
   ```
   The second line matters for the tool: `check-lag`, the failover split-brain probe, the switchback role check and the
   `setup` WAL-policy/slot checks all talk to the **primary as `myr_replicator` over a database-mode replication
   connection** (`replication=database dbname=paperclip`: replication commands such as `IDENTIFY_SYSTEM` plus plain SQL).
   They never use the application role `paperclip` against the primary, because the standby's passfile only holds the
   replicator's credentials. The role needs `REPLICATION` (already required) and `CONNECT` on the database.
3. **Replication Slots**:
   - Slot name: `standby_board_slot` (physical, for the entire cluster).
   - `setup` first validates finite `max_slot_wal_keep_size`, then creates the slot on the primary with `pg_create_physical_replication_slot('standby_board_slot', true)` if absent; `pg_basebackup --slot=standby_board_slot` then consumes the existing slot. Do not use `pg_basebackup -C` here. If an existing slot has uncertain ownership, stop and investigate; do not drop it.
   - A stopped standby/dead tunnel retains WAL until `max_slot_wal_keep_size` is reached; monitor `check-lag` for retained bytes and `wal_status`.
4. **Tooling**:
   The management CLI is located at:
   `scripts/myrmidon/standby/standby-ctl.sh` (backed by `standby-ctl.mjs`).

5. **Host prerequisites (D8, standby host `myr-vm1`)**:
   - `node` (any supported LTS) to run `standby-ctl.mjs`.
   - PostgreSQL 18 client binaries on the host: `psql`, `pg_basebackup`, `pg_ctl` (the same major version as the primary, PG 18).
   - Run as a non-root OS user that owns the standby data directory and the docker socket group. `pg_ctl` (promote/start/stop) refuses to run as root, and `pg_basebackup`/`psql` invocations from `standby-ctl.sh` inherit that user.
   - Docker with the `pgvector/pgvector:pg18` image pre-pulled (no on-host image build — board image comes from CI per release policy).
   - Host mode (`--pg-runner=host`) passes no passfile to `psql`: export `PGPASSFILE` (or keep the replicator line in `~/.pgpass`) so the
     primary-side probes, which run as `myr_replicator`, can authenticate. Docker mode uses the container's own `.pgpass`.

6. **D9: Docker-runner mode (default; no host PostgreSQL client needed)**:
   `standby-ctl.sh` runs the tool in a throw-away `node:20-alpine` container on the **host network** with the docker
   socket mounted (it installs `docker-cli`, `docker-cli-compose` and `curl` there). Inside it:
   - `psql`, `pg_ctl`, `pg_isready` and the drill's `pg_basebackup` run through `docker exec -u postgres myrmidon-pg-standby ...`
     with **in-container paths**.
   - `setup` / `switchback` re-create the data directory while the standby container is **stopped**, so their base backup
     (and, on a first setup, their primary-side checks) run in a one-shot `docker compose run --rm --no-deps -u postgres`
     container built from the same service definition (same image, same bind-mounted data directory).
   - Two data directories exist and are never mixed up: `--data-dir` is the **host** path (default
     `/srv/standby/myrmidon-pg/data`, used for file operations and, in host mode, for `pg_ctl`); `--container-data-dir`
     is the **in-container** PGDATA (default `/var/lib/postgresql/data`, handed to `pg_ctl promote` and `pg_basebackup -D`
     in docker mode). `failover` therefore promotes with `pg_ctl promote -D /var/lib/postgresql/data` inside the container.
   - Files the tool writes into the bind-mounted data directory (`.pgpass` is `0600`) are chowned to uid/gid 999 (`postgres`
     in the image). The wrapper runs as root, so this works there; run as a non-root user and `setup` stops **before**
     touching anything with an explicit error.
   - `--credentials <file>` / `STANDBY_CREDENTIAL_PATH` must point below `/srv/standby` or `/srv/backups` (the only host paths
     visible inside the wrapper container).
   - The Docker socket must be accessible to the invoking user (member of the `docker` group).
   - Use `--pg-runner=docker` (default) or `--pg-runner=host` to force host binaries if they are installed.

**Mandatory primary-side PostgreSQL settings** (validated by `setup` and `check-lag`, fail-closed):

> **D7 note (02.11, ADM):** production runs `wal_level=logical` and `archive_mode=off`,
> both fixed in the container `command` line — `ALTER SYSTEM` is overridden by the
> command line and would need a restart. Do NOT change them; streaming replication
> works with `logical`. Only the slot retention bound below is managed via ALTER SYSTEM.

```sql
-- Streaming replication works with the live wal_level=logical — no wal_level change needed.
-- Bound WAL retention per slot so a stopped standby cannot fill the disk.
-- D7: root fs has ~40 GB free — use 6 GB, not 50 GB.
ALTER SYSTEM SET max_slot_wal_keep_size = '6GB';
SELECT pg_reload_conf();
```
`max_slot_wal_keep_size = -1` (unbounded, the live `myrmidon-pg` default) is rejected by `setup` and reported by `check-lag`; a VM with `/` at 90% capacity must not run an unbounded slot.


---

## 3. Initial Standby Setup

On the standby host (`myr-vm1`):

1. **Prepare Directories** (the tool creates and chowns the data directory itself; this is only needed for a custom layout):
   ```bash
   mkdir -p /srv/standby/myrmidon-pg/data
   mkdir -p /srv/backups/wal/myrmidon-pg
   chmod 700 /srv/standby/myrmidon-pg/data
   ```

2. **Execute Base Backup Sync**:
   Run the setup command to stream the initial base backup, configure credentials/passfile, register the replication slot
   and start the standby:
   ```bash
   PRIMARY_PG_HOST="<primary-host>" PRIMARY_PG_PORT="<port>" PG_REPLICATOR_PASSWORD="<replication-password>" scripts/myrmidon/standby/standby-ctl.sh setup --target all
   # Or using an existing credential passfile (must live under /srv/standby when the wrapper is used):
   # scripts/myrmidon/standby/standby-ctl.sh setup --target all --credentials /srv/standby/pgpass
   ```
   Order of operations (OPE-7656): **all checks first, then anything destructive.** Data directory state, replication
   credentials, finite `max_slot_wal_keep_size`, physical slot, and (for `--force`) the promoted-standby guard are checked
   while the standby container is still up. Only then is the container stopped, the data directory emptied, the base backup
   taken in a one-shot container, `standby.signal` / `postgresql.auto.conf` / `.pgpass` (uid 999, `0600`) written and the
   container started. `primary_conninfo` references the passfile, never an embedded password.
   `setup --force` on a data directory that belongs to a **promoted** standby (not in recovery, or no `standby.signal` while the
   container is down) is refused unless `--discard-promoted-standby` is given; the refusal and the success report both carry the
   primary/standby timeline and LSN comparison.

3. **Start Standby Services** (already done by `setup`; only needed after a reboot or manual stop):
   ```bash
   docker compose -f scripts/myrmidon/standby/docker-compose.standby.yml up -d myrmidon-pg-standby
   ```
   Do not start the compose file without a service name: the `myrmidon-board` drill service lives in the `drill` profile and
   must only run through `rehearse --keep-drill` (section 7).

4. **Verify Standby Readiness**:
   ```bash
   docker compose -f scripts/myrmidon/standby/docker-compose.standby.yml ps
   psql -h localhost -p 5433 -U paperclip -d paperclip -tA -c "SELECT pg_is_in_recovery()::int;"
   psql -h localhost -p 5433 -U myrmidon_hindsight -d myrmidon_hindsight -tA -c "SELECT pg_is_in_recovery()::int;"
   ```
   Both queries must print `1` (in recovery). Note: `pg_is_in_recovery()::text` prints `true`/`false` (and a bare boolean prints
   `t`/`f`); the tool always uses `::int` so the answer is `1`/`0`.

### WAL Archive & Restore Paths (Defect 3 Note)

The standby container mounts `/srv/backups/wal/myrmidon-pg` on the host to `/srv/backups/wal` inside the container:
```yaml
volumes:
  - /srv/backups/wal/myrmidon-pg:/srv/backups/wal:ro
```
and `docker-compose.standby.yml` configures:
`-c restore_command='cp /srv/backups/wal/%f %p'`.

To ensure compatibility, `standby-ctl.mjs` sets the default container WAL archive directory (`walArchiveDir`, `boardWalArchiveDir`, `hindsightWalArchiveDir`) to `/srv/backups/wal`. In `postgresql.auto.conf`, `restore_command` references `/srv/backups/wal/%f`, matching the in-container mount point. Note that production primary runs `archive_mode = off` by default (see D7 note); WAL archiving is kept as a fallback mechanism when archives are copied or restored.

---

## 4. Freshness & Lag Monitoring (RPO Verification)

To guarantee the **RPO <= 15 minutes (900 seconds)** requirement, run the lag check tool regularly:

```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900
```
(Alternative flag: `--rpo-max-seconds 900`).

### JSON Monitoring Output
For integration into automated probes or monitoring pipelines:
```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900
```

Output example:
```json
{
  "command": "check-lag",
  "allRpoOk": true,
  "results": [
    {
      "target": "board",
      "success": true,
      "role": "standby",
      "inRecovery": true,
      "measuredAgainst": "primary",
      "primaryLsn": "1/2000000",
      "receiveLsn": "1/2000000",
      "replayLsn": "1/2000000",
      "byteLag": "0",
      "receiveByteLag": "0",
      "timeLagSeconds": 4,
      "rpoMaxSeconds": 900,
      "rpoOk": true,
      "rpoStatus": "ok"
    },
    {
      "target": "hindsight",
      "success": true,
      "role": "standby",
      "inRecovery": true,
      "measuredAgainst": "primary",
      "primaryLsn": "1/2000000",
      "receiveLsn": "1/2000000",
      "replayLsn": "1/2000000",
      "byteLag": "0",
      "receiveByteLag": "0",
      "timeLagSeconds": 6,
      "rpoMaxSeconds": 900,
      "rpoOk": true,
      "rpoStatus": "ok"
    }
  ]
}
```

- Exit code `0`: Standby is in recovery, connected, and within RPO threshold (`allRpoOk: true`).
- Exit code `1`: Replication lag exceeds 15 minutes, standby is disconnected, or replication stream is down.

---

## 5. Failover Procedure (Disaster Recovery)

When `vm-core` experiences total failure or network isolation.

### Step 0: Fence the old primary (mandatory)
An unreachable primary is **not** a dead primary: behind a network partition `vm-core` may still be serving the fleet and accepting
writes, and promoting the standby would then create two writers (split-brain, divergent timelines, data loss on one side).
Before promoting:
1. Power off the `vm-core` VM at the hypervisor (the owner, Alex, performs this — least privilege; no one else holds the hypervisor
   credentials) **or** otherwise guarantee it cannot accept writes (database and board stopped on `vm-core`, network path cut). A
   hypervisor power-off is the only option that does not depend on the partitioned host. Record who did it and when
   (e.g. in the OPE-7656 worklog).
2. Confirm it: the hypervisor shows the VM stopped, and `check-lag`/the probe below can no longer reach it.

### Step 1: Promote Standby Instance
`failover` runs a fail-closed split-brain guard first. It probes the original primary as `myr_replicator` over the replication
protocol, at the endpoint from `--primary-host`/`--primary-port`, else `PRIMARY_PG_HOST`/`PRIMARY_PG_PORT`, else the standby's own
`primary_conninfo` (the live relay), and decides:

| Primary answer | Result |
| :--- | :--- |
| reachable, **not** in recovery (`pg_is_in_recovery()::int = 0`) | **refused** — fence/stop it first |
| any other answer or error (authentication failure, permission, `FATAL`, docker/container error, unparseable) | **refused** — this does *not* prove it is down |
| endpoint cannot be determined | **refused** |
| reachable and in recovery (`= 1`) | promote |
| unreachable (connection refused, timeout, DNS, relay drop) | **refused unless `--fenced`** (Step 0 done) |

```bash
scripts/myrmidon/standby/standby-ctl.sh failover board --fenced="hypervisor poweroff vm-core 10:00+08"
# add --primary-host=<h> --primary-port=<p> if the standby's primary_conninfo is unreadable
# --accept-split-brain bypasses the guard entirely (emergency only; the old primary may hold writes the standby lacks)
```
The promotion is `pg_ctl promote -D /var/lib/postgresql/data` **inside the standby container** (host mode: `-D` the host data
directory); only if that fails does the tool fall back to SQL `pg_promote()` (needs superuser) and it reports both errors if both
fail. The JSON result carries `guard` (state, probed endpoint, fencing evidence) and `promoteMethod`.
Manual alternative, on the standby: `docker exec -u postgres myrmidon-pg-standby /usr/lib/postgresql/18/bin/pg_ctl promote -D /var/lib/postgresql/data`.

### Step 2: Confirm Standby is in Read-Write Mode
```bash
psql -h localhost -p 5433 -U paperclip -d paperclip -tA -c "SELECT pg_is_in_recovery()::int;"
# Expected: 0

psql -h localhost -p 5433 -U myrmidon_hindsight -d myrmidon_hindsight -tA -c "SELECT pg_is_in_recovery()::int;"
# Expected: 0
```

### Step 3: Start Application on `myr-vm1`
The tool can recreate the application for you, but only when you ask and name the **production** compose file (never the drill
file in `docker-compose.standby.yml`):
```bash
scripts/myrmidon/standby/standby-ctl.sh failover board --fenced --restart-app --app-compose-file=/opt/myrmidon/docker-compose.yml --check-health
```
When the wrapper is used, the directory of that file must be mounted into it: `STANDBY_APP_COMPOSE_DIR=/opt/myrmidon scripts/myrmidon/standby/standby-ctl.sh failover ...`.
The compose file must already point `DATABASE_URL`/`HINDSIGHT_DATABASE_URL` at the promoted standby (`localhost:5433`); the tool only recreates the
service and does **not** verify which database it connects to — check `/healthz` and the UI.
`appSwitched` and `healthOk` in the JSON are **`null` unless requested** (the tool never reports an unperformed step as done); with
`--restart-app` they are the real outcome of `docker compose up -d --force-recreate` and of `curl -sf <health-url>`
(`--health-url`, default `http://127.0.0.1:3100/healthz`), and a failed requested step makes the command exit `1` although the
promotion succeeded (`promoted: true`). Manual alternative:
```bash
export DATABASE_URL="postgresql://paperclip:***@localhost:5433/paperclip"
export HINDSIGHT_DATABASE_URL="postgresql://myrmidon_hindsight:***@localhost:5433/myrmidon_hindsight"
docker compose up -d myrmidon-board
```

### Step 4: Reroute Fleet & Validate Service
- Update internal DNS / load balancer to route agent traffic to `myr-vm1`.
- Verify board readiness: `curl -s http://localhost:3100/healthz`.
- Verify fleet connection status in the Myrmidon UI / API.
- Measured **RTO <= 30 minutes** (typically under 5 minutes for promotion and service start).

---

## 6. Switchback Procedure (Primary Restored)

When `vm-core` is recovered and ready to resume primary service:

**Order matters.** The promoted standby on `myr-vm1` holds all writes accepted after failover — it is the source of truth until it is re-synced back to `vm-core`. Never wipe the standby data directory first.

1. **Verify both sides' roles** (`::int`: `0` = writer, `1` = in recovery):
   ```bash
   # vm-core (recovered) must be in recovery or freshly re-cloned, never a live writer:
   psql -h <vm-core> -p 5432 -tA -c "SELECT pg_is_in_recovery()::int;"
   # myr-vm1 standby must still be the active writer (0):
   psql -h 127.0.0.1 -p 5433 -tA -c "SELECT pg_is_in_recovery()::int;"
   ```
2. **Re-sync Primary from Standby**:
   Take a fresh `pg_basebackup` of the promoted standby into `vm-core`'s clean data directory (or use `pg_rewind` only when timelines allow). `vm-core` must accept writes only after this sync.
3. **Switch Application Back**:
   Drain active tasks on `myr-vm1`, update `DATABASE_URL` back to `vm-core:5432`, restart application services, and verify `http://localhost:3100/healthz`.
4. **Re-arm Standby on `myr-vm1`** (last step, and only with an explicit data-loss acknowledgement):
   ```bash
   scripts/myrmidon/standby/standby-ctl.sh switchback --target all --force --discard-promoted-standby
   ```
   The tool first checks that the original primary is reachable and **not** in recovery (probed as `myr_replicator`), then runs every
   `setup` check (credentials, WAL policy, slot, promoted-standby guard) **before** it stops the container and empties the data
   directory; the regenerated `primary_conninfo` keeps the verified live endpoint. It refuses (`exit 1`, no destructive action) if the
   standby is not in recovery — i.e. when it still holds the only copy of post-failover writes — unless `--discard-promoted-standby` is
   passed explicitly after steps 2/3 confirmed `vm-core` is the writer again. The timeline/LSN comparison is not advisory: when it says
   `standby_ahead` (the standby is on a higher timeline / further LSN than `vm-core`, i.e. `vm-core` was **not** re-synced from it) or
   `different_cluster` (different system identifier), `--discard-promoted-standby` alone is refused and the additional `--accept-data-loss`
   is required. The report carries the comparison (`comparison.verdict`) — record it in the worklog. Further guards: the data directory
   must contain `PG_VERSION` (a wrong `--data-dir` is never emptied), and the stop of the standby container is verified with `docker inspect`
   before the wipe.

---

## 7. Disaster Recovery Rehearsal (Restore Drill)

To validate restore capability and measure actual RTO without affecting live replication:

```bash
# Automated live drill on isolated drill port 5533 / in-container drill directory
scripts/myrmidon/standby/standby-ctl.sh rehearse --target all

# Or inspect the execution plan first (exits 0, runs nothing)
scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --dry-run
```

The automated rehearsal procedure (docker mode: **everything happens inside the standby container**):
0. Refuses a `--drill-dir` that is not an absolute, drill-named path outside the live data/archive directories, and refuses to start if
   the drill directory already exists (a leftover or a kept drill is never reused or deleted behind your back).
1. Takes a consistent basebackup snapshot of the current standby into the isolated drill directory
   (default `/var/lib/postgresql/drill-cluster`, an in-container path; the host filesystem is not touched).
   `/srv/standby/drill-cluster` and `/srv/backups/wal` are compose bind-mount points inside the container (`rm -rf` of a mount point fails
   with EBUSY), so docker mode refuses them as drill directories.
2. Launches an ephemeral PostgreSQL instance on alternate drill port (`5533`), bound to loopback (`pg_ctl start -l <drillDir>/pg_ctl.log`:
   the log file keeps the postmaster from holding the `docker exec` output pipe open).
3. Promotes the ephemeral instance and confirms recovery exit (`SELECT pg_is_in_recovery()::int` returns `0`).
4. Executes smoke verification queries on both databases (`paperclip` and `myrmidon_hindsight`).
5. In a `finally` that runs for **every** outcome (snapshot/start/promote/verify/smoke failure included): stops the drill instance
   (`pg_ctl stop -m immediate`) and deletes the drill directory with `docker exec -u postgres myrmidon-pg-standby rm -rf <drillDir>`, then
   verifies it is gone. A cleanup that fails turns the result into a failure and prints the manual command.
6. Measures exact elapsed duration and validates that actual RTO is well within the 30-minute target (typically < 30 seconds).

### Optional: keep the drill and start the drill board (`--keep-drill`)
```bash
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"          # drill-only secret, not the production one
export PAPERCLIP_DB_PASSWORD="<url-encoded paperclip password>"  # same role password as in the restored database
export COMPOSE_BOARD_IMAGE="ghcr.io/itkadr-git/myrmidon@sha256:<release component digest>"
scripts/myrmidon/standby/standby-ctl.sh rehearse --target board --keep-drill
curl -s http://127.0.0.1:3101/healthz
# ...verify, then tear everything down (board + drill instance + drill directory):
scripts/myrmidon/standby/standby-ctl.sh rehearse --target board --cleanup-drill
```
`--keep-drill` starts the board from `--compose-file` (default: `docker-compose.standby.yml` next to the tool) with
`docker compose --profile drill up -d --no-deps myrmidon-board`, and only after the drill passed; if the drill or the board start
fails, the drill is cleaned up instead of kept. Without both secrets in the environment the command refuses before doing any work —
the compose file ships no default secrets.

**Networking.** The drill PostgreSQL runs inside the standby container and port `5533` is not published. With `--keep-drill` the tool
starts it with `listen_addresses='*'` (otherwise loopback only) and the board reaches it over the compose network at
`myrmidon-pg-standby:5533` (`host.docker.internal` is not used). The drill instance is reachable only from containers of that compose
project and only while the drill is kept.

**Isolation of the drill board.** The board is started with `MYRMIDON_PROCESS_ROLE=api` (HTTP only: no background timers or sweeps, no
run execution, no plugin workers, no backups), `HEARTBEAT_SCHEDULER_ENABLED=false` and `MYRMIDON_DB_BACKUP_ENABLED=false` (the only
switches the server reads; the earlier `PAPERCLIP_DISABLE_SCHEDULER` / `PAPERCLIP_DISABLE_OUTBOUND` do not exist). The server has no global
outbound kill-switch, so the board is also started **without connector credentials**: no secrets master key is given to the container, so
the copies of the production connector tokens inside the drill database cannot be decrypted. Do not mount or export a production
`SECRETS_MASTER_KEY(_FILE)` into it. Because the `api` role only waits for the schema (it never migrates), use the same release image as
the database being rehearsed. Endpoints that the `api` role proxies to a worker process (runs, heartbeat) may answer with errors in this standalone drill;
the intended check is "the board boots on the restored data, `/healthz` is ready, read paths work", not full operation
(to be confirmed by the first live rehearsal, see the OPE-7656 worklog).

---

## 8. Acceptance Criteria & Evidence Matrix

| Requirement | Target | Verification Method | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **Warm Standby Configuration** | Cluster (5433) for Board & Hindsight | `scripts/myrmidon/standby/docker-compose.standby.yml` | Single standby cluster on `myr-vm1`, port 5433, replicating both DBs |
| **Streaming Replication** | Continuous WAL replay | `standby-ctl.sh setup` + `docker-compose.standby.yml` | `standby.signal`, `primary_conninfo` with credentials, active streaming verified |
| **RPO Limit** | <= 15 minutes (900s) | `standby-ctl.sh check-lag --rpo 900` | True primary-to-standby LSN lag & replay delay <= 900s, exit code 0; fail-closed on error |
| **RTO Limit** | <= 30 minutes (1800s) | `standby-ctl.sh failover` & `standby-ctl.sh rehearse` | Promotion in < 10s, read-write confirmed on both DBs, measured duration <= 1800s |
| **Split-brain safety** | No second writer | `standby-ctl.sh failover` | Refused for a reachable writable primary, for any non-network probe error, and for an unreachable primary without `--fenced` (section 5) |
| **Destructive-step ordering** | No data loss on re-sync | `standby-ctl.sh setup --force` / `switchback` | All checks (credentials, WAL policy, slot, promoted-standby guard + timeline/LSN comparison) run before the container is stopped or the data directory is emptied |
| **CI Automation** | Automatic regression check | `node --test scripts/myrmidon/standby/*.test.mjs` | 100% passing behavioral & unit tests in CI suite |

---

## 9. Automated Watchdog & RPO Monitoring (Сторож RPO и слота)

### EN: Automated Standby Watchdog
To prevent silent replication lag or invalid replication slot states (such as `wal_status = lost` or `wal_status = unreserved`), the platform monitoring or product cron executes `check-lag` every 5 minutes:
```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900 --json
```
**Exit Code & Failure Rules**:
The command exits with `0` only if all targets succeed and satisfy `rpoOk = true`. It exits with `1` (non-zero) and reports failure when:
1. `rpoOk` is `false` (time lag or byte lag exceeds 15 minutes / 900 seconds).
2. The primary is unreachable (`primary_unreachable` or connection failure).
3. The replication slot `wal_status` on `vm-core` is NOT `reserved` or `extended` (e.g. `unreserved`, `lost`, or missing).

When the exit code is non-zero (`1`), monitoring raises an immediate P1 alert.

### RU: Автоматический сторож репликации и мониторинг RPO
Для предотвращения скрытого отставания реплики или недействительного состояния слота репликации (`wal_status = lost` или `wal_status = unreserved`) штатный механизм мониторинга или встроенный cron продукта выполняет проверку каждые 5 минут:
```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900 --json
```
**Код выхода и критерии сбоя**:
Команда завершается с кодом `0` только тогда, когда все цели успешны и `rpoOk = true`. Команда завершается с ненулевым кодом `1` при следующих условиях:
1. `rpoOk` равен `false` (временное или байтовое отставание превышает 15 минут / 900 секунд).
2. Основная база недоступна (`primary_unreachable` или ошибка соединения).
3. Статус WAL слота (`wal_status`) на `vm-core` НЕ равен `reserved` или `extended` (например, `unreserved`, `lost` или слот отсутствует).

При ненулевом коде выхода (`1`) мониторинг поднимает аварийную тревогу P1.
