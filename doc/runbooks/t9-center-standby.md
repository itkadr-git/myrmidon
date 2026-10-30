# Runbook: T9 Central Standby (Option A2)

This runbook defines the operational procedures for the central database warm standby (Board database `paperclip` and `myrmidon_hindsight`) on `myr-vm1`, supporting automatic and manual failover with RPO <= 15 minutes and RTO <= 30 minutes.

---

## 1. Architecture & Topology

- **Primary Site (`vm-core`)**:
  - Hosts production `myrmidon-pg` (PostgreSQL 18 + pgvector) on port `5432`.
  - Serves `paperclip` board database (~6.6 GB) and `myrmidon_hindsight` vector database (~16 GB).
  - Configured with `wal_level = replica`, `archive_mode = on`, continuous WAL streaming to replication slots.
- **Standby Site (`myr-vm1`)**:
  - Connected to `vm-core` via secure IPsec tunnel.
  - Hosts dedicated standby instances in isolated directories and ports:
    - **Board DB Standby**: port `5433` (maps to container `5432`), data directory `/srv/standby/myrmidon-pg/data`.
    - **Hindsight DB Standby**: port `5434` (maps to container `5432`), data directory `/srv/standby/hindsight-pg/data`.
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
   ```
3. **Replication Slots**:
   - `standby_board_slot` (retains WAL segments for board standby)
   - `standby_hindsight_slot` (retains WAL segments for hindsight standby)
4. **Tooling**:
   The management CLI is located at:
   `scripts/myrmidon/standby/standby-ctl.sh` (backed by `standby-ctl.mjs`).

---

## 3. Initial Standby Setup

On the standby host (`myr-vm1`):

1. **Prepare Directories**:
   ```bash
   mkdir -p /srv/standby/myrmidon-pg/data /srv/standby/hindsight-pg/data
   mkdir -p /srv/backups/wal/myrmidon-pg /srv/backups/wal/hindsight-pg
   chmod 700 /srv/standby/myrmidon-pg/data /srv/standby/hindsight-pg/data
   ```

2. **Execute Base Backup Sync**:
   Run the setup command to stream initial base backup and register replication slots:
   ```bash
   PRIMARY_PG_HOST="<primary-host>" \
   scripts/myrmidon/standby/standby-ctl.sh setup --target all
   ```
   This generates `standby.signal` and configures `primary_conninfo` and `restore_command`.

3. **Start Standby Services**:
   Launch the standby containers via Docker Compose:
   ```bash
   docker compose -f scripts/myrmidon/standby/docker-compose.standby.yml up -d
   ```

4. **Verify Standby Readiness**:
   ```bash
   docker compose -f scripts/myrmidon/standby/docker-compose.standby.yml ps
   psql -h localhost -p 5433 -U paperclip -c "SELECT pg_is_in_recovery();"
   psql -h localhost -p 5434 -U postgres -c "SELECT pg_is_in_recovery();"
   ```
   Both queries must return `t` (true).

---

## 4. Freshness & Lag Monitoring (RPO Verification)

To guarantee the **RPO <= 15 minutes (900 seconds)** requirement, run the lag check tool regularly:

```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900
```

### JSON Monitoring Output
For integration into automated probes or Prometheus exporters:
```bash
scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 900 --json
```

Output example:
```json
{
  "status": "ok",
  "rpoMaxSeconds": 900,
  "results": [
    {
      "target": "board",
      "inRecovery": true,
      "role": "warm_standby",
      "rpoStatus": "ok",
      "rpoOk": true,
      "byteLag": 0,
      "timeLagSeconds": 4,
      "isCaughtUp": true,
      "marginSeconds": 896
    },
    {
      "target": "hindsight",
      "inRecovery": true,
      "role": "warm_standby",
      "rpoStatus": "ok",
      "rpoOk": true,
      "byteLag": 0,
      "timeLagSeconds": 6,
      "isCaughtUp": true,
      "marginSeconds": 894
    }
  ]
}
```

- Exit code `0`: Standby is in recovery and within RPO threshold (`timeLagSeconds <= 900`).
- Exit code `1`: Replication lag exceeds 15 minutes or standby is disconnected. Alerts must trigger immediate operator attention.

---

## 5. Failover Procedure (Disaster Recovery)

When `vm-core` experiences total failure or network isolation:

### Step 1: Promote Standby Instances
Execute promotion using `standby-ctl.sh`:
```bash
scripts/myrmidon/standby/standby-ctl.sh failover --target all
```
Or execute SQL promotion directly:
```sql
-- On port 5433 (Board DB):
SELECT pg_promote();

-- On port 5434 (Hindsight DB):
SELECT pg_promote();
```

### Step 2: Confirm Standby is in Read-Write Mode
```bash
psql -h localhost -p 5433 -U paperclip -d paperclip -c "SELECT pg_is_in_recovery();"
# Expected: f (false)

psql -h localhost -p 5434 -U postgres -d myrmidon_hindsight -c "SELECT pg_is_in_recovery();"
# Expected: f (false)
```

### Step 3: Start Application on `myr-vm1`
Start the Myrmidon application container pointing to the promoted local database instances:
```bash
export DATABASE_URL="postgresql://paperclip:paperclip@localhost:5433/paperclip"
export HINDSIGHT_DATABASE_URL="postgresql://postgres:postgres@localhost:5434/myrmidon_hindsight"
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

1. **Re-sync Primary from Standby**:
   Use `pg_rewind` or `pg_basebackup` to bring `vm-core` up to date with any writes made during failover on `myr-vm1`.
2. **Switch Application Back**:
   Drain active tasks on `myr-vm1`, update `DATABASE_URL` back to `vm-core:5432`, and restart application services.
3. **Re-arm Standby on `myr-vm1`**:
   Re-establish warm standby following the restored primary:
   ```bash
   scripts/myrmidon/standby/standby-ctl.sh switchback --target all
   ```
   Standby signals are placed and replication restarts from the active primary.

---

## 7. Disaster Recovery Rehearsal (Restore Drill)

To validate restore capability without affecting live replication:

```bash
scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --dry-run
```

For live drill on staging / test environments:
1. Snapshot current standby data to `/tmp/rehearsal-<target>`.
2. Launch ephemeral PostgreSQL instance on alternate port (`5533` / `5534`).
3. Promote the ephemeral instance and execute smoke queries (`SELECT COUNT(*) FROM issues;`).
4. Destroy ephemeral instance without interrupting active WAL stream on `5433` / `5434`.

---

## 8. Acceptance Criteria & Evidence Matrix

| Requirement | Target | Verification Method | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **Warm Standby Configuration** | Board (5433) & Hindsight (5434) | `scripts/myrmidon/standby/docker-compose.standby.yml` | Isolated ports & directories on `myr-vm1` |
| **Streaming Replication** | Continuous WAL replay | `standby-ctl.sh setup` + `pg_basebackup` slot streaming | `standby.signal` and streaming active |
| **RPO Limit** | <= 15 minutes (900s) | `standby-ctl.sh check-lag --rpo 900` | Replay delay <= 900s, exit code 0 |
| **RTO Limit** | <= 30 minutes (1800s) | `standby-ctl.sh failover` execution | Promotion in < 10s, read-write confirmed |
| **CI Automation** | Automatic regression check | `node --test scripts/myrmidon/standby/*.test.mjs` | 100% passing tests in CI suite |
