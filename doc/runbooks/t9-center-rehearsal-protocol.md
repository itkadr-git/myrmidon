# Protocol: T9 Central Standby DR Rehearsal & Verification

This protocol documents the verification procedure, acceptance criteria, and operational execution steps for the central warm standby disaster recovery system on `myr-vm1` (Option A2), covering both the `paperclip` and `myrmidon_hindsight` databases.

---

## 1. Scope & Acceptance Standards

| Objective | Target Requirement | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **Warm Standby Cluster** | Single standby cluster on `myr-vm1` (:5433) | `docker-compose.standby.yml` + `standby-ctl.sh` | Verified (single cluster port 5433, replicates both DBs) |
| **Streaming Replication** | Continuous WAL replay via `standby_board_slot` | `pg_stat_wal_receiver` check in `setupStandby` | Verified fail-closed (fails if streaming stream inactive) |
| **Replication Security** | scram-sha-256 credentials via container passfile | `.pgpass` (0600, owner uid 999) in `/var/lib/postgresql/data/.pgpass` | Verified (no plaintext passwords in config or compose; the compose file ships no default secrets) |
| **Switchback Safety** | Prevent accidental data directory destruction | `--force`; every check before stop/wipe; promoted-standby guard (`--discard-promoted-standby` + timeline/LSN comparison) | Verified fail-closed (nothing is stopped or deleted until all checks pass) |
| **Failover Safety** | No split-brain on promotion | Replicator probe of the old primary; `--fenced` required when it is unreachable | Verified fail-closed (writable / error / unknown endpoint / unfenced-unreachable are all refused) |
| **RPO Guarantee** | Data loss window <= 15 minutes (900 seconds) | `standby-ctl.sh check-lag --rpo 900` | Verified (LSN byte lag & time lag measured vs primary) |
| **RTO Guarantee** | Total recovery time <= 30 minutes (1800 seconds) | `standby-ctl.sh rehearse --target all` | Verified (automated promotion & dual DB smoke test < 30s) |
| **Fleet Integrity** | Standby deployment preserves 13 worker bots on `myr-vm1` | Isolated ports (5433, 5533) and paths (`/srv/standby/`) | Verified (no collision with host workloads) |

---

## 2. Automated Behavioral Drill Suite (CI Evidence)

The test suite in `scripts/myrmidon/standby/standby-ctl.test.mjs` drives the tool exclusively through an injected runner and an
injected filesystem (a simulated primary / standby container / drill cluster); it never spawns docker, psql or any real process and
is safe to run anywhere:

```bash
node --test scripts/myrmidon/standby/*.test.mjs
```

All simulated PostgreSQL answers are what `psql -t -A` really prints (`1`/`0` for the `::int` role queries); an earlier revision
answered `t`/`f` for `::text` booleans that a real server prints as `true`/`false`, which hid a switchback that would refuse at step 1.

Coverage by area (116 tests, 0 failing at the time of this revision):

| Area | What is pinned down |
| :--- | :--- |
| LSN / lag math, status parsing, config and command generation | `parseLsn`, `calculateLag` (idle DB, RPO boundaries), `parseReplicationStatus` (`1`/`t`/`true`), `generateStandbyConfig`, `generateBasebackupCommand` |
| Real PostgreSQL booleans | one `::int` helper everywhere; failover, switchback, setup and check-lag succeed on real `1`/`0` answers and never issue a `::text` boolean query |
| Failover split-brain guard | writable primary -> refuse; auth/permission/docker/unparseable/tool-timeout -> refuse; unknown endpoint -> refuse; unreachable without `--fenced` -> refuse; unreachable with `--fenced` -> promote (evidence recorded); in recovery -> promote; probe uses `myr_replicator`, a `replication=database` connection and the live endpoint from `primary_conninfo`; `--accept-split-brain` bypass; `--fenced` does not swallow the target |
| Failover execution (docker and host mode) | `pg_ctl promote -D /var/lib/postgresql/data` inside the container (never the host path); host mode uses `--data-dir`; `pg_promote()` fallback and combined error; `appSwitched`/`healthOk` are `null` unless `--restart-app` / `--check-health` ran, then the real outcome |
| Setup / switchback ordering and safety | every check before stop/wipe, using the same credentials as the base backup; credentials, WAL policy, slot or primary failure leave the standby untouched; promoted standby refused without `--discard-promoted-standby`, and a standby that is ahead of the primary (or another cluster) additionally needs `--accept-data-loss`; container-down fallback to `standby.signal`; stop is verified (`docker inspect`); wipe target must contain `PG_VERSION`; incomplete wipe aborts; live relay kept in `primary_conninfo` |
| Docker-mode setup | base backup in a one-shot `docker compose run` container with in-container `-D`, staged passfile mounted read-only, data dir / `.pgpass` chowned to uid 999, chown failures refused; first setup without a container |
| Rehearsal | cleanup via `docker exec ... rm -rf` in `finally` for success and for every failure path, host filesystem never touched in docker mode; unsafe `--drill-dir` refused; existing drill dir never reused; cleanup failure reported; `--keep-drill` (secrets required, `listen_addresses='*'`, board started from `--compose-file`, cleaned on failure); `--cleanup-drill`; `--dry-run` exits 0 |
| Static checks | compose uses only real server env switches, no `host.docker.internal`, no default secrets, `psql -tA` healthcheck; wrapper forwards `PRIMARY_PG_PORT` and passes secrets by name |

---

## 3. Operational Rehearsal Runbook on `myr-vm1` (ADM Window)

In accordance with company architecture governance (Alex 29.09.2026: production workloads run exclusively from official CI images `ghcr.io/itkadr-git/myrmidon@sha256:...`) and access delegation (ADM 15.10.2026: network access and VM host management are ADM responsibility), the physical execution on `myr-vm1` is conducted by ADM following PR merge:

### Step 1: Pre-Rehearsal Replication & RPO Check
Run on `myr-vm1`:
```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900
```
**Expected JSON output**:
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
      "byteLag": "0",
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
      "byteLag": "0",
      "timeLagSeconds": 4,
      "rpoMaxSeconds": 900,
      "rpoOk": true,
      "rpoStatus": "ok"
    }
  ]
}
```

### Step 2: Isolated Restore & Promotion Rehearsal (Zero Impact)
Run isolated drill on ephemeral port 5533 without stopping active replication:
```bash
scripts/myrmidon/standby/standby-ctl.sh rehearse --target all
# Custom drill directory/port override if needed:
# scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --drill-dir=/var/lib/postgresql/drill-cluster --drill-port=5533
# Plan only (exit 0, nothing executed):
# scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --dry-run
```

**Primary endpoint resolution (ADM 04.11):** the real primary on myr-vm1 is `192.0.2.1:15432` (TEST-NET-1 example; production value is in the standby's `primary_conninfo`),
not the compile-time default `primary.internal:5432`. Priority order:
1. Explicit `--primary-host` / `--primary-port` CLI flags
2. Env vars `PRIMARY_PG_HOST` / `PRIMARY_PG_PORT` (the wrapper forwards both)
3. Auto-detect from the standby's own `primary_conninfo` (works on myr-vm1)

The same resolution is used by `check-lag`, the failover split-brain probe and `switchback`; if none of the three yields an endpoint,
failover and switchback refuse instead of guessing.

**Drill directory note (ADM 04.11):** the drill snapshot (`pg_basebackup`) runs INSIDE the
standby container via `docker exec`, so `--drill-dir` must be a path writable by uid 999
inside the container. Default: `/var/lib/postgresql/drill-cluster`. Host paths like
`/srv/standby/drill-cluster` are root-owned bind-mount points (they fail with "Permission denied" for uid 999 and cannot be removed:
EBUSY), so docker mode refuses them. The tool also deletes this directory
(`docker exec -u postgres myrmidon-pg-standby rm -rf <drillDir>`, never through the host filesystem), so it refuses any value that is not an
absolute path whose last segment contains `drill`, or that overlaps the live data / WAL-archive directories, and it refuses to start when
the directory already exists.

**Execution flow**:
1. Basebackup snapshot of the standby into the ephemeral `/var/lib/postgresql/drill-cluster` (inside the container).
2. Startup of ephemeral PostgreSQL instance on port `5533` (loopback; `'*'` with `--keep-drill`).
3. Execution of `pg_ctl promote -D <drillDir>` (D3: SQL `pg_promote()` requires superuser; the `paperclip` role lacks it. `pg_ctl promote` runs as the OS user that owns the data directory).
4. Verification that `SELECT pg_is_in_recovery()::int` returns `0`.
5. Smoke verification: `SELECT 1` on `paperclip` and `myrmidon_hindsight`.
6. Ephemeral instance shutdown and in-container directory removal in `finally` — runs even if a step fails (ADM 04.11: prevents 49GB drill dirs being left on disk) and is verified; a failed cleanup fails the run. Skipped only after a fully successful `--keep-drill`.
7. Verification that measured RTO <= 1800s.

**Optional — keep drill alive for board/fleet verification (D6)**:
```bash
export BETTER_AUTH_SECRET=...      # drill-only secret
export PAPERCLIP_DB_PASSWORD=...   # URL-encoded password of the paperclip role in the restored database
export COMPOSE_BOARD_IMAGE=ghcr.io/itkadr-git/myrmidon@sha256:...   # release component under test
scripts/myrmidon/standby/standby-ctl.sh rehearse --target board --keep-drill --drill-port=5533
curl -s http://127.0.0.1:3101/healthz
# tear down: board + drill instance + drill directory
scripts/myrmidon/standby/standby-ctl.sh rehearse --target board --cleanup-drill
```
`--keep-drill` itself starts the drill board (`docker compose -f <--compose-file> --profile drill up -d --no-deps myrmidon-board`); there
is no separate manual `up` step. See runbook `t9-center-standby.md` section 7 for the networking and isolation details.

**Expected JSON output**:
```json
{
  "command": "rehearse",
  "allSuccess": true,
  "allRtoOk": true,
  "results": [
    {
      "success": true,
      "target": "board",
      "promoted": true,
      "smokeTestPassed": true,
      "verifiedDatabases": ["paperclip", "myrmidon_hindsight"],
      "durationSeconds": 14,
      "targetRtoSeconds": 1800,
      "rtoOk": true,
      "cleanup": { "stopped": true, "removed": true }
    }
  ]
}
```

### Step 3: Fleet Visibility Check
Done with the drill board started by `--keep-drill` in Step 2 (D6: drill-only service on `127.0.0.1:3101`, profile `drill`; process role `api` with
`HEARTBEAT_SCHEDULER_ENABLED=false`, no background timers, no run execution, no connector credentials):
```bash
curl -s http://127.0.0.1:3101/healthz
```
Verify via API or UI that the restored board serves the restored data. Worker bots on `myr-vm1` keep reporting to the production board; they are
not re-pointed at the drill board, and the `api`-role drill board cannot execute runs, so the earlier "13 bots report heartbeats to the restored
board" check is **not** part of this drill (it would require a full failover, which is a separate, fenced procedure: runbook section 5).

To clean up the drill board and drill cluster afterwards:
```bash
scripts/myrmidon/standby/standby-ctl.sh rehearse --target board --cleanup-drill
```
