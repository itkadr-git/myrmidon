#!/usr/bin/env python3
"""Render an offline, inactive standby example from explicit operator inputs."""
import json
import re
import sys
from pathlib import Path

FIELDS = {'primary_major', 'standby_major', 'postgres_image', 'app_image', 'cpu', 'memory_mb',
          'required_cpu', 'required_memory_mb', 'free_disk_mb', 'required_disk_mb', 'wal_keep_mb',
          'max_slot_wal_keep_mb', 'slot', 'primary_host', 'primary_port', 'replication_user',
          'tls_server_name', 'ca_file', 'passfile', 'cert_file', 'key_file'}


def render(c):
    if not isinstance(c, dict) or set(c) != FIELDS:
        raise ValueError('configuration must contain exactly the documented fields')
    ints = ('primary_major', 'standby_major', 'cpu', 'memory_mb', 'required_cpu', 'required_memory_mb',
            'free_disk_mb', 'required_disk_mb', 'wal_keep_mb', 'max_slot_wal_keep_mb', 'primary_port')
    if any(type(c[k]) is not int or c[k] <= 0 for k in ints):
        raise ValueError('numeric fields must be positive integers')
    if c['primary_major'] != c['standby_major'] or c['primary_port'] > 65535:
        raise ValueError('incompatible major or invalid port')
    for actual, minimum in [('cpu', 'required_cpu'), ('memory_mb', 'required_memory_mb'), ('free_disk_mb', 'required_disk_mb')]:
        if c[actual] < c[minimum]:
            raise ValueError('insufficient resources')
    if c['max_slot_wal_keep_mb'] < c['wal_keep_mb']:
        raise ValueError('slot retention below WAL retention')
    if not re.fullmatch(r'ghcr\.io/itkadr-git/myrmidon@sha256:[0-9a-f]{64}', str(c['app_image'])):
        raise ValueError('app image must be a CI digest')
    if not re.fullmatch(r'postgres@sha256:[0-9a-f]{64}', str(c['postgres_image'])):
        raise ValueError('postgres image must be digest pinned')
    for key, pattern in [('slot', r'[a-z0-9_]{1,63}'), ('replication_user', r'[a-zA-Z_][a-zA-Z0-9_]{0,62}'),
                         ('primary_host', r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}'),
                         ('tls_server_name', r'[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}')]:
        if not isinstance(c[key], str) or not re.fullmatch(pattern, c[key]):
            raise ValueError('invalid ' + key)
    if c['primary_host'] != c['tls_server_name']:
        raise ValueError('primary host must match TLS server name')
    mounts = []
    for key in ('ca_file', 'passfile', 'cert_file', 'key_file'):
        p = c[key]
        if not isinstance(p, str) or not Path(p).is_absolute() or not Path(p).is_file() or not Path(p).stat().st_size:
            raise ValueError('missing or empty file: ' + key)
        try:
            with Path(p).open('rb') as source:
                if not source.read(1):
                    raise ValueError('empty file: ' + key)
        except OSError as exc:
            raise ValueError('unreadable file: ' + key) from exc
        mounts.append({'type': 'bind', 'source': p, 'target': '/run/standby/' + key, 'read_only': True})
    conn = (f"host={c['primary_host']} port={c['primary_port']} user={c['replication_user']} "
            "sslmode=verify-full sslrootcert=/run/standby/ca_file sslcert=/run/standby/cert_file "
            "sslkey=/run/standby/key_file passfile=/run/standby/passfile")
    return {'services': {
        'standby': {'image': c['postgres_image'], 'profiles': ['manual-standby'], 'restart': 'no',
                    'cpus': str(c['cpu']), 'mem_limit': f"{c['memory_mb']}m", 'volumes': mounts + ['standby-data:/var/lib/postgresql/data'],
                    'entrypoint': ['/bin/sh', '-ec'],
                    'command': [f"test -f /var/lib/postgresql/data/standby.signal && test \"$(cat /var/lib/postgresql/data/PG_VERSION)\" = {c['standby_major']} && test \"$(postgres -V | cut -d ' ' -f 3 | cut -d . -f 1)\" = {c['standby_major']} || exit 1; exec docker-entrypoint.sh postgres \"$@\"", 'standby',
                                '-c', 'primary_conninfo=' + conn, '-c', 'primary_slot_name=' + c['slot'],
                                '-c', f"wal_keep_size={c['wal_keep_mb']}MB", '-c', f"max_slot_wal_keep_size={c['max_slot_wal_keep_mb']}MB"]},
        'cold-app': {'image': c['app_image'], 'profiles': ['manual-cold-app'], 'restart': 'no',
                     'network_mode': 'none', 'cpus': str(c['cpu']), 'mem_limit': f"{c['memory_mb']}m",
                     'environment': {'MYRMIDON_PROCESS_ROLE': 'api', 'HEARTBEAT_SCHEDULER_ENABLED': 'false',
                                     'MYRMIDON_DB_BACKUP_ENABLED': 'false'}}},
        'volumes': {'standby-data': {}}}


def main():
    if len(sys.argv) != 2:
        print('usage: render.py INPUT.json', file=sys.stderr)
        return 2
    try:
        with open(sys.argv[1], encoding='utf-8') as source:
            config = json.load(source)
        result = render(config)
    except (ValueError, OSError, TypeError):
        print('invalid configuration or inaccessible required file', file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
