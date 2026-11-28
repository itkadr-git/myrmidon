#!/usr/bin/env python3
"""Combine independently timestamped monitoring sources and evaluate them offline."""
import json
import sys
import time

from monitor import evaluate


def assemble(sources, now):
    sources = sources if isinstance(sources, dict) else {}
    sample = {'observed_at': now, 'source_observed_at': {}}
    for name in ('replication', 'receiver', 'wal', 'host'):
        source = sources.get(name)
        source = source if isinstance(source, dict) else {}
        sample['source_observed_at'][name] = source.get('observed_at')
        value = source.get('value')
        if name == 'replication':
            sample[name] = value
        elif isinstance(value, dict):
            keys = {'receiver': ('receiver_status',),
                    'wal': ('wal_retained_bytes', 'wal_limit_bytes'),
                    'host': ('disk_used_percent', 'memory_used_percent', 'cpu_used_percent')}[name]
            sample.update({key: value.get(key) for key in keys})
    return sample


def main():
    try:
        sources = json.load(sys.stdin)
    except (ValueError, OSError):
        sources = None
    now = time.time()
    result = evaluate(assemble(sources, now), now=now)
    print(json.dumps(result, sort_keys=True))
    return {'ok': 0, 'warning': 1, 'critical': 2}[result['status']]


if __name__ == '__main__':
    sys.exit(main())
