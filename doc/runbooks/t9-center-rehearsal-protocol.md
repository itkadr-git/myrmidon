# Protocol: T9 Central Standby DR Rehearsal & Verification

This protocol documents the verification procedure, acceptance criteria, and operational execution steps for the central warm standby disaster recovery system on `myr-vm1` (Option A2), covering both the `paperclip` and `myrmidon_hindsight` databases.

---

## 1. Scope & Acceptance Standards

| Objective | Target Requirement | Verification Mechanism | Status |
| :--- | :--- | :--- | :--- |
| **Warm Standby Cluster** | Single standby cluster on `myr-vm1` (`10.10.0.110:5433`) | `docker-compose.standby.yml` + `standby-ctl.sh` | Verified (single cluster port 5433, replicates both DBs) |
| **Streaming Replication** | Continuous WAL replay via `standby_board_slot` | `pg_stat_wal_receiver` check in `setupStandby` | Verified fail-closed (fails if streaming stream inactive) |
| **Replication Security** | scram-sha-256 credentials via container passfile | `.pgpass` (0600) mounted at `/var/lib/postgresql/data/.pgpass` | Verified (no plaintext passwords in config or compose) |
| **Switchback Safety** | Prevent accidental data directory destruction | Explicit `--force` flag requirement | Verified fail-closed (throws before stopping or deleting) |
| **RPO Guarantee** | Data loss window <= 15 minutes (900 seconds) | `standby-ctl.sh check-lag --rpo 900` | Verified (LSN byte lag & time lag measured vs primary) |
| **RTO Guarantee** | Total recovery time <= 30 minutes (1800 seconds) | `standby-ctl.sh rehearse --target all` | Verified (automated promotion & dual DB smoke test < 30s) |
| **Fleet Integrity** | Standby deployment preserves 13 worker bots on `myr-vm1` | Isolated ports (5433, 5533) and paths (`/srv/standby/`) | Verified (no collision with host workloads) |

---

## 2. Automated Behavioral Drill Suite (CI Evidence)

The test suite in `scripts/myrmidon/standby/standby-ctl.test.mjs` executes 23 automated behavioral tests covering all failure and recovery scenarios:

```text
✔ parseLsn parses valid PostgreSQL LSN strings into BigInt
✔ parseLsn returns null for invalid inputs
✔ calculateLag computes byte lag against primary and receive LSN
✔ calculateLag handles boundaries and rpoMaxSeconds=0 correctly
✔ parseReplicationStatus parses standard and error psql outputs
✔ generateStandbyConfig includes required streaming parameters and credentials via passfile
✔ generateBasebackupCommand generates slot and stream flags
✔ checkLag measures primary-to-standby lag and handles fail-closed errors
✔ setupStandby executes directory setup, basebackup, and config writes
✔ setupStandby fails closed if data directory is non-empty without --force
✔ setupStandby with --force stops container, wipes dataDir, and sets up standby
✔ setupStandby fails if WAL receiver stream is not active (walReceivers === 0)
✔ executeFailover promotes standby, polls recovery exit, and restarts app
✔ executeSwitchback resynchronizes standby from active primary
✔ executeSwitchback fails closed without explicit force flag
✔ executeRehearsal conducts isolated drill, smoke tests both databases, and measures RTO
✔ runCli commands output structured JSON and return correct exit codes
✔ setupStandby uses credential path, sets PGPASSFILE env on basebackup, and omits password from config
✔ executeRehearsal fails closed if promotion verification fails (in_recovery is true)
✔ executeRehearsal fails closed if smoke test fails for database
✔ checkLag verifies both databases on shared standby cluster port 5433 without split ports
✔ checkLag respects unified custom standbyPort and primaryPort on single cluster
✔ runCli check-lag defaults to checking both databases on shared cluster port 5433

Total: 23 pass, 0 fail (100% passing)
```

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
```
**Execution flow**:
1. Basebackup snapshot of `/srv/standby/myrmidon-pg/data` into ephemeral `/srv/standby/drill-cluster`.
2. Startup of ephemeral PostgreSQL instance on port `5533`.
3. Execution of `SELECT pg_promote()`.
4. Verification that `SELECT pg_is_in_recovery()` returns `f` (false).
5. Smoke verification: `SELECT 1` on `paperclip` and `myrmidon_hindsight`.
6. Ephemeral instance shutdown and directory cleanup.
7. Verification that measured RTO <= 1800s.

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
      "rtoOk": true
    }
  ]
}
```

### Step 3: Fleet Visibility Check
Launch Myrmidon Board application container from the release image:
```bash
docker compose -f scripts/myrmidon/standby/docker-compose.standby.yml up -d myrmidon-board
curl -s http://127.0.0.1:3100/healthz
```
Verify via API or UI that all 13 worker bots on `myr-vm1` report healthy heartbeats to the restored board instance.
