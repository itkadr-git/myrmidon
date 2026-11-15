# HA-GEO monitoring

This directory contains an offline evaluator. It does not connect to a host,
PostgreSQL, or an alerting system. A caller supplies one JSON sample on stdin.

## Input contract

- `observed_at`: Unix seconds when the sample was collected.
- `replication`: the existing `scripts/myrmidon/standby/standby-ctl.mjs`
  `checkLag` result. Its `success`, `rpoOk`, `role`, `inRecovery`, and
  `timeLagSeconds` fields are used.
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

The collector needs a PostgreSQL read-only connection to the standby. The
replication query needs permission to read `pg_is_in_recovery()`, WAL replay
functions, and `pg_stat_wal_receiver`; the existing standby contract and
replication role should be used. Host disk, memory, and CPU values need a
read-only host metrics source. No production metric, alert, endpoint, secret,
DNS, firewall, or deployment is enabled by these files.

## Synthetic check

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts/ha-geo/monitoring -p 'test_*.py' -v
```

The test fixtures cover healthy, lag boundary, stale, missing, disconnected,
non-standby, and resource pressure cases.
