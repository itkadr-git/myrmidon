# HA-GEO operational runbook

This is a procedure template, not evidence of site readiness or authorization to execute. See the existing [T9 standby runbook](../../../doc/runbooks/t9-center-standby.md). Its historical 900-second RPO threshold does not demonstrate the HA-GEO target of 300 seconds. All live execution requires a separate operator authorization and window.

## Scope and safety

The target is a manually operated PostgreSQL streaming standby and a cold application/worker site. The target is RPO <= 300 seconds and manual RTO <= 1800 seconds. The primary and standby names, addresses, DNS records, secret-store paths, compose paths, image digests, and release versions are parameters. Replace every `<...>` value before execution. An unresolved value is a hard stop.

Parts A-D are dependencies and remain pending unless their owners record completion: site/network readiness, replication implementation, application routing, and worker fencing. `geo-check` and `standby-ctl` are present in this revision. The context names `/api/health/replication`, but its route and response are not confirmed in this revision: do not call it or rely on a guessed response. The dependent step is blocked until the release source and contract are verified.

No step below permits a connection to a site. Lab rehearsal uses synthetic data and isolated paths only. Production steps require the named operator, an approved maintenance window, and a recorded change or incident reference.

## Roles, approvals, and evidence

- Operator: the person named in the change record. The operator runs commands and records UTC timestamps and exit codes.
- Database owner: approves PostgreSQL role, slot, backup, promotion, and restore actions.
- Application owner: approves application routing and cold-start actions.
- Fencing authority: the infrastructure operator who can stop or isolate the old writer. A reachability failure is not fencing evidence.
- Observer: records RPO, RTO, health, integrations, and worker counts.

For every mutating command, record: prerequisites, operator, approval and window, command, exit code, result check, and abort action. Abort before the next step on any failed check. Never print passwords, tokens, or connection strings containing credentials.

## 1. Inventory and readiness

Prerequisites: Parts A-D have named owners and status; the approved parameter sheet has values for both sites; no production connection is needed for the lab. Operator: observer. Window: none for lab; production inventory is read-only and needs an approved observation window.

Use the released readiness interface with synthetic or approved read-only values:

```bash
myrmidon geo-check --json --config <approved-config>
```

Check that the report passes OS, Docker, PostgreSQL client, PostgreSQL and LiteLLM reachability, required-secret presence, and mirror configuration checks. `geo-check` is a readiness gate, not proof of replication or failover. Do not copy secret values into the report.

The replication endpoint is pending contract verification; no command or response is specified. A missing or undocumented endpoint is a failed prerequisite for endpoint-dependent steps, not a reason to invent a substitute. Abort: stop and return the missing parameter or pending dependency to the change record.

## 2. Prepare the standby

Prerequisites: inventory passes; approved primary endpoint and replication credential reference exist; standby data and backup paths are empty or explicitly approved; the same PostgreSQL major and released standby tool are identified. Operator: database owner. Window: preparation window; this changes standby state and may consume primary resources.

First inspect the plan without execution:

```bash
bash scripts/myrmidon/standby/standby-ctl.sh setup --target all --dry-run
```

After approval, run setup with a secret reference supplied by the approved credential mechanism. Do not put a password in shell history or documentation:

```bash
bash scripts/myrmidon/standby/standby-ctl.sh setup --target all --credentials <approved-passfile>
```

Verify: exit code `0`; standby service is running; both databases report `pg_is_in_recovery() = 1`; the approved replication evidence confirms streaming; the slot is present and bounded; no application or worker is active on the cold site. Record the tool JSON and timestamps with secrets redacted.

Abort: if any preflight fails, do not use `--force`; correct the prerequisite. If a destructive step has started and fails, stop, preserve the data directory, and escalate to the database owner. Never delete a promoted standby to make setup pass.

## 3. Backup and restore rehearsal

Prerequisites: isolated lab paths and synthetic data; an approved backup destination; released backup/restore commands and image digest. The default wrapper uses host networking and production-named mounts: it is prohibited in the isolated lab. Use an independently verified host-mode isolated fixture with no production volumes; if unavailable, do not run this drill. Explicitly verify host, port, passfile, new drill directory and environment variables point only to that fixture. The tool defaults are not isolated. The all target runs one board cluster rehearsal which checks both databases, not two separate clusters. Operator: database owner. Window: lab window; production backup or restore requires a separate approved window.

Create a dry-run plan first:

```bash
bash scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --dry-run
```

Run the isolated rehearsal only with synthetic data. Its snapshot source is 127.0.0.1 at the specified standby port, not the primary host/port: independently verify that this port is the isolated standby and cannot reach live data before running.

```bash
STANDBY_CTL_NO_DOCKER=1 bash scripts/myrmidon/standby/standby-ctl.sh rehearse --target all --pg-runner=host --primary-host=<isolated-primary-host> --primary-port=<isolated-primary-port> --standby-port=<isolated-standby-port> --drill-dir=<isolated-new-drill-dir> --drill-port=<isolated-drill-port> --credentials=<isolated-passfile>
```

Verify: the isolated instance starts, promotes, answers smoke queries for each target, reports elapsed time, and removes its drill directory. Exit code `0` is required. Verify the directory is absent after cleanup. A retained drill requires an explicit cleanup action and must not share live data or production secrets.

Abort: stop the isolated instance, remove only the named isolated drill path, retain logs without credentials, and mark restore acceptance failed if cleanup cannot be verified.

## 4. Manual failover

Prerequisites: incident or approved window; last replication health result; measured lag <= 300 seconds; an unknown or larger lag fails acceptance and blocks this procedure; application drain plan; tested rollback; fencing authority present. Operator: incident commander coordinates; database owner promotes; infrastructure operator fences. Window: production emergency or approved failover window.

1. Freeze writes and drain application work according to the released application procedure. Verify no active writer remains on the standby.
2. Fence the old primary before promotion. The fencing authority must stop or isolate the old writer at the infrastructure boundary, then record method, operator, UTC time, and evidence. A failed ping or database connection is not fencing.
3. Run the released failover guard with explicit fencing evidence:

```bash
bash scripts/myrmidon/standby/standby-ctl.sh failover board --fenced="<change-id>: <fencing evidence>"
```

4. Verify the promoted database reports `pg_is_in_recovery() = 0`, the old writer remains fenced, and the promoted node is not incorrectly treated as standby-ready.
5. Start the cold application only through the approved production compose/service procedure. Keep scheduler, outbound integrations, and workers disabled until the single-active checks pass.
6. Route traffic using the approved routing procedure. Do not invent a DNS or load-balancer command. Verify board health, database target, integration probes, and worker count.

Abort: if fencing cannot be proven, do not promote. If promotion succeeds but application or integration checks fail, keep the old site fenced, stop newly started workers, and invoke incident rollback; do not promote the old writer again.



RTO starts at incident declaration and ends when board health, database write test, integrations, and single-active worker checks all pass. Record UTC timestamps and compute seconds offline: `python3 -c 'print(int("<end_epoch>") - int("<start_epoch>"))'`. Reject missing or negative values and durations over 1800 seconds.

For RPO, before the incident run `bash scripts/myrmidon/standby/standby-ctl.sh check-lag --target all --rpo 300` and retain the exit code and both results. Exit 0 does not prove RPO at a later failure time. Record the last acknowledged primary write and latest recovered write in an approved test dataset. Use primary timestamp as end and recovered timestamp as start in the offline calculation above. Reject missing markers, clock uncertainty, negative values, or results over 300 seconds. A quiet primary's last replay timestamp alone is not a lag measurement.

## 5. Fencing and single-active controls

Fencing is a safety proof, not a command name. Accepted evidence is an infrastructure stop/isolation result from the fencing authority plus a second independent check that the old writer cannot accept writes. `pg_is_in_recovery()` on the new writer alone is insufficient.

Before enabling the application, verify:

```bash
curl --fail --silent --show-error <ACTIVE_BOARD_URL>/api/health
```

Verify integrations with the released, non-destructive health/probe interface. Do not send real customer traffic from a lab drill. Verify there is one active board writer, one scheduler owner, and zero cold-site workers until explicitly enabled. Record process/container identities and timestamps; do not rely on a process-name grep alone.

If the release provides a generation, lease, or fencing token, compare the active token with the old site's token and reject stale owners. Parts A-D must define the exact token interface before this is executed. Missing fencing contract blocks promotion.

## 6. Manual failback

Prerequisites: incident commander approval; active site is healthy; all post-failover writes are backed up; old primary is fenced and reinitialized or otherwise proven not to be a writer; database owner has a resynchronization plan. Operator: database owner and application owner. Window: approved failback window.

1. Keep the current active site serving and record its final LSN/backup identifier.
2. Rebuild or rewind the old site only with the released PostgreSQL procedure. Verify system identity and timeline before allowing it to start.
3. Start the old site as a standby and verify recovery and streaming. Do not start it as a writer.
4. Drain the active application. Stop active-site workers and verify zero workers before routing changes.
5. Fence the current writer with independently verified evidence. Promote the resynced standby only using a separately approved promotion procedure; verify it is the sole writer. If fencing or promotion is unproven, abort without routing. Then route the application using the approved procedure and verify health, integrations, one writer, and zero stale workers.
6. Re-arm the former active site as standby only after the new writer is proven. Record the new RPO baseline.

Abort: retain the currently active site and its fence if any timeline, LSN, identity, health, or worker check fails. Never discard the only copy of post-failover writes. Roll back routing to the currently verified writer, not automatically to the old host.

## 7. Rollback and emergency stop

Rollback is a controlled return to the last verified writer. It is not an unplanned second promotion. Stop newly enabled workers, freeze writes, preserve logs and LSN evidence, and keep the old writer fenced until the incident commander and database owner approve the next action. If data divergence is possible, stop and escalate; do not merge timelines by guesswork.

## 8. Acceptance evidence

| Evidence | Lab (synthetic, isolated) | Real site (operator window) |
|---|---|---|
| Inventory | `geo-check --json` pass; parameters are complete | Same report plus approved read-only site evidence |
| Standby | isolated setup and both targets in recovery; dry-run is not setup evidence | Released setup output, confirmed streaming, slot and timeline evidence |
| RPO <= 300s | Last acknowledged synthetic primary write and latest recovered write markers with UTC timestamps; calculate the difference and retain `check-lag --target all --rpo 300` output | Last acknowledged primary and latest recovered write markers with UTC timestamps, calculated difference and `check-lag` output; reject missing markers or uncertain clocks |
| RTO <= 1800s | Full failover from incident declaration to passing health, write, integration and single-active worker checks; record start/end UTC and elapsed seconds; restore rehearsal alone is insufficient | Full failover start/end UTC and elapsed seconds; health, write, integrations and single-active worker checks pass |
| Fencing | Simulated old writer cannot write; evidence is synthetic | Infrastructure stop/isolation evidence plus independent write rejection |
| Single-active | One isolated board and no background workers outside the drill | One active writer/scheduler/worker set; cold site has zero workers before cutover |
| Backup/restore | Rehearsal smoke queries and drill cleanup | Approved backup identifier, restore evidence, and operator sign-off |

Required operator-window items: fencing, replication credentials, slot or WAL policy changes, any data-directory replacement, application start, routing/DNS/LB change, integration enablement, worker enablement, failback, and deletion of a promoted standby. No production acceptance is claimed by this document alone.

## 9. Pending dependencies and unknowns

Parts A-D must fill in the exact replication health response, fencing mechanism and evidence format, routing mechanism, worker single-active mechanism, credential path, supported release/image, and rollback owner. Until each value is recorded from an authoritative source, the corresponding procedure is blocked. No DNS name, secret-store product, host credential, image version, or production result is assumed here.
