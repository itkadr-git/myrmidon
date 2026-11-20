#!/usr/bin/env python3
"""Evaluate a timestamped, externally collected HA-GEO monitoring sample."""
import json
import math
import sys
import time


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def evaluate(sample, now=None):
    now = time.time() if now is None else now
    checks = []

    def add(name, status, detail):
        checks.append({'name': name, 'status': status, 'detail': detail})

    if not isinstance(sample, dict):
        sample = {}
    observed = sample.get('observed_at')
    fresh = number(observed) and 0 <= now - observed <= 60
    add('freshness', 'ok' if fresh else 'critical', 'sample age must be between 0 and 60 seconds')
    source_times = sample.get('source_observed_at')
    source_times = source_times if isinstance(source_times, dict) else {}
    source_fresh = {}
    for source in ('replication', 'receiver', 'wal', 'host'):
        timestamp = source_times.get(source)
        source_fresh[source] = number(timestamp) and 0 <= now - timestamp <= 60
        add(f'{source}_freshness', 'ok' if source_fresh[source] else 'critical',
            'source sample age must be between 0 and 60 seconds')
    replication = sample.get('replication')
    replication = replication if isinstance(replication, dict) else {}
    if replication.get('command') == 'check-lag':
        results = replication.get('results')
        valid = (isinstance(results, list) and len(results) in (1, 2)
                 and all(isinstance(item, dict) for item in results))
        targets = [item.get('target') for item in results] if valid else []
        valid = valid and all(target in ('board', 'hindsight') for target in targets) and len(set(targets)) == len(targets)
        if valid:
            replication = {
                'success': all(item.get('success') is True for item in results),
                'rpoOk': replication.get('allRpoOk') is True and all(item.get('rpoOk') is True for item in results),
                'role': 'standby' if all(item.get('role') == 'standby' for item in results) else 'invalid',
                'inRecovery': all(item.get('inRecovery') is True for item in results),
                'timeLagSeconds': max((item['timeLagSeconds'] for item in results), default=None)
                if all(number(item.get('timeLagSeconds')) and item['timeLagSeconds'] >= 0 for item in results)
                else None,
            }
        else:
            replication = {}
    standby = (replication.get('success') is True and replication.get('rpoOk') is True
               and replication.get('role') == 'standby' and replication.get('inRecovery') is True)
    add('standby', 'ok' if standby else 'critical', 'checkLag must confirm a successful standby with RPO met')
    streaming = sample.get('receiver_status') == 'streaming'
    add('streaming', 'ok' if streaming else 'critical', 'WAL receiver must be streaming')
    lag = replication.get('timeLagSeconds')
    if replication.get('target') == 'all':
        databases = replication.get('databases')
        if (not isinstance(databases, list) or len(databases) != 2
                or any(not isinstance(db, dict) or not number(db.get('timeLagSeconds'))
                       or db['timeLagSeconds'] < 0 for db in databases)):
            lag = None
        else:
            lag = max(db['timeLagSeconds'] for db in databases)
    if not number(lag) or lag < 0:
        lag_status = 'critical'
    elif lag >= 300:
        lag_status = 'critical'
    elif lag >= 240:
        lag_status = 'warning'
    else:
        lag_status = 'ok'
    add('lag', lag_status, 'seconds; warning >= 240, critical >= 300; missing is critical')

    retained, limit = sample.get('wal_retained_bytes'), sample.get('wal_limit_bytes')
    wal_percent = retained / limit * 100 if number(retained) and retained >= 0 and number(limit) and limit > 0 else None
    for name, value in [('wal_retention', wal_percent),
                        ('disk', sample.get('disk_used_percent')),
                        ('memory', sample.get('memory_used_percent')),
                        ('cpu', sample.get('cpu_used_percent'))]:
        if not number(value) or value < 0 or (name != 'wal_retention' and value > 100):
            status = 'critical'
        elif value >= 90:
            status = 'critical'
        elif value >= 80:
            status = 'warning'
        else:
            status = 'ok'
        add(name, status, 'percent; warning >= 80, critical >= 90; missing is critical')
    priority = {'ok': 0, 'warning': 1, 'critical': 2}
    status = max((check['status'] for check in checks), key=priority.get)
    return {'status': status, 'checks': checks}


def main():
    try:
        sample = json.load(sys.stdin)
    except (ValueError, OSError):
        sample = None
    result = evaluate(sample)
    print(json.dumps(result, sort_keys=True))
    return {'ok': 0, 'warning': 1, 'critical': 2}[result['status']]


if __name__ == '__main__':
    sys.exit(main())
