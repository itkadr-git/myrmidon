#!/usr/bin/env python3
"""Collect non-secret host facts and, only when requested, local PostgreSQL facts."""
import argparse
import json
import os
import shutil
import subprocess


SQL = """SELECT json_build_object(
 'server_version_num', current_setting('server_version_num')::int,
 'db_bytes', pg_database_size(current_database()),
 'in_recovery', pg_is_in_recovery(),
 'wal_level', current_setting('wal_level'),
 'archive_mode', current_setting('archive_mode'),
 'archive_timeout', current_setting('archive_timeout'),
 'wal_keep_size', current_setting('wal_keep_size', true),
 'max_wal_senders', current_setting('max_wal_senders')::int,
 'max_replication_slots', current_setting('max_replication_slots')::int,
 'streaming', CASE WHEN pg_is_in_recovery() THEN
   (SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming')
   ELSE (SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming') END,
 'lag_bytes', CASE WHEN pg_is_in_recovery() THEN
   pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) ELSE NULL END,
 'ssl', (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid())
)::text;"""
FIELDS = ('server_version_num', 'db_bytes', 'in_recovery', 'wal_level', 'archive_mode',
          'archive_timeout', 'wal_keep_size', 'max_wal_senders', 'max_replication_slots', 'streaming', 'lag_bytes', 'ssl')


def time_sync_status():
    try:
        result = subprocess.run(['/usr/bin/timedatectl', 'show', '--property=NTPSynchronized', '--value'],
                                env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                                capture_output=True, text=True, timeout=3, check=True)
        value = result.stdout.strip()
        if value in ('yes', 'no'):
            return {'status': 'ok', 'synchronized': value == 'yes'}
    except (OSError, subprocess.SubprocessError):
        pass
    return {'status': 'unknown', 'reason': 'time synchronization status unavailable'}


def capability(name, label):
    available = shutil.which(name, path='/usr/bin:/bin:/usr/sbin:/sbin') is not None
    return {'status': 'incomplete', label: available,
            'reason': 'binary availability does not establish configuration or service health'}


def query_postgres(socket, database, user):
    # A clean environment prevents libpq from consuming credentials or connection overrides.
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'PGPASSFILE': '/dev/null',
           'PGCONNECT_TIMEOUT': '5', 'PGSSLMODE': 'disable'}
    command = ['psql', '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
               '-h', socket, '-d', database, '-U', user, '-c', SQL]
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10, check=True)
    data = json.loads(result.stdout)
    if not isinstance(data, dict):
        raise ValueError('invalid response')
    return data


def collect(socket=None, database=None, user=None):
    postgres = {'status': 'unknown', 'reason': 'local PostgreSQL connection not requested'}
    if socket:
        try:
            raw = query_postgres(socket, database, user)
            data = {key: raw.get(key) for key in FIELDS}
            data['major'] = raw['server_version_num'] // 10000
            required = [k for k in FIELDS if k != 'lag_bytes' or data['in_recovery']]
            postgres = {'status': 'ok' if all(data[k] is not None for k in required) else 'incomplete', 'data': data}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            postgres = {'status': 'error', 'reason': 'query failed or access denied; details suppressed'}
    try:
        disk = shutil.disk_usage('/')
        disk_info = {'status': 'ok', 'path': '/', 'total_bytes': disk.total, 'free_bytes': disk.free}
    except OSError:
        disk_info = {'status': 'error', 'reason': 'disk usage unavailable'}
    return {'schemaVersion': 1, 'postgres': postgres, 'disk': disk_info,
            'resources': {'cpu_count': os.cpu_count(), 'memory_bytes': memory()},
            'ci_browser_profile': capability('chromium', 'chromium_available'),
            'time_sync': time_sync_status(),
            'tls': capability('openssl', 'openssl_available'),
            'login_method': capability('sshd', 'sshd_available'),
            'backup': {'status': 'unknown', 'reason': 'backup configuration not inspected'}}


def memory():
    try:
        return os.sysconf('SC_PAGE_SIZE') * os.sysconf('SC_PHYS_PAGES')
    except (ValueError, OSError):
        return None


def main():
    parser = argparse.ArgumentParser(description='Read-only inventory; PostgreSQL is not contacted by default.')
    parser.add_argument('--socket', help='explicit absolute local Unix socket directory')
    parser.add_argument('--database', help='database name, without connection options')
    parser.add_argument('--user', help='database user name, without connection options')
    args = parser.parse_args()
    if any((args.socket, args.database, args.user)):
        if not all((args.socket, args.database, args.user)) or not args.socket.startswith('/') or any(c in args.socket for c in ',=') or any(c in value for value in (args.database, args.user) for c in '=:/'):
            parser.error('provide an absolute local socket directory and simple database and user names')
    report = collect(args.socket, args.database, args.user)
    print(json.dumps(report, sort_keys=True))
    return 2 if any(report[name]['status'] != 'ok' for name in ('postgres', 'disk', 'ci_browser_profile', 'time_sync', 'tls', 'login_method', 'backup')) or not all(report['resources'].values()) else 0


if __name__ == '__main__':
    raise SystemExit(main())
