# HA-GEO monitoring

This directory contains an offline evaluator. It does not connect to a host,
PostgreSQL, or an alerting system. A caller supplies one JSON sample on stdin.
`adapter.py` accepts an object with `replication`, `receiver`, `wal`, and `host`
entries, each shaped as `{ "observed_at": <Unix seconds>, "value": <data> }`.
The replication value is the check-lag JSON; the other values are objects
containing their respective fields below. It assembles the sample and invokes
the evaluator; missing or stale inputs remain critical. It does not collect data.
For an already collected JSON file, run `python3 scripts/ha-geo/monitoring/adapter.py < sources.json`.

## Input contract

- `observed_at`: Unix seconds when the sample was assembled.
- `source_observed_at`: object containing Unix seconds for each independently
  collected `replication`, `receiver`, `wal`, and `host` source. Each must be
  present and no older than 60 seconds; refreshing the envelope alone is not
  evidence that any source is fresh.
- `replication`: a `checkLag` result or the complete JSON output of
  `standby-ctl.mjs check-lag`. The evaluator uses each returned database result;
  callers must request all intended targets. Aggregate results fail closed if
  a database lag is missing. The collector must preserve command failures.
- `receiver_status`: status from PostgreSQL `pg_stat_wal_receiver`.
- `wal_retained_bytes` and `wal_limit_bytes`: WAL retention usage measured by
  the collector. A missing or invalid limit is critical.
- `disk_used_percent`, `memory_used_percent`, `cpu_used_percent`: host resource
  percentages from the collector.

The evaluator is fail-closed. A missing, future, or older-than-60-second sample,
non-standby role, failed replication result, non-streaming receiver, missing lag,
or invalid resource value is critical. Lag is warning at 240 seconds and critical
at 300 seconds, preserving the RPO limit. WAL and resource usage warn at 80%
and are critical at 90%.

## Required access

The existing `checkLag` queries recovery and replay state on the standby and
uses the primary replication protocol `IDENTIFY_SYSTEM` for its current LSN.
Its slot check queries `pg_replication_slots` and `pg_settings` on the primary.
The corresponding roles need standby database access, primary replication
protocol access, and permission to read slot and setting data. Reading
`pg_stat_wal_receiver` can require `pg_read_all_stats` or suitable privileges.
A future collector must establish exact least privilege for its PostgreSQL
version. WAL retained bytes come from the slot's restart LSN relative to the
primary WAL LSN; the limit comes from `max_slot_wal_keep_size`, converted to
bytes. Unlimited or unknown limits need a separately justified finite threshold.
Disk usage comes from filesystem capacity and available space, memory usage from
host memory statistics, and CPU usage from a sampled CPU utilization source.
These require a read-only host metrics source and defined sampling intervals.
No collector, scheduler, production metric, alert, endpoint, secret,
DNS, firewall, or deployment is enabled by these files. No production metric
inventory has been performed.

## Synthetic check

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts/ha-geo/monitoring -p 'test_*.py' -v
```

The test fixtures cover healthy, lag boundary, stale, missing, disconnected,
non-standby, and resource pressure cases.
