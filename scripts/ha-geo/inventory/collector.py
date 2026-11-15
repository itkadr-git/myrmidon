#!/usr/bin/env python3
"""Collect non-secret host facts and, only when requested, local PostgreSQL facts."""
import argparse
import json
import os
import shutil
import ssl
import subprocess


SQL = """SELECT json_build_object(
 'server_version_num', current_setting('server_version_num')::int,
 'db_bytes', pg_database_size(current_database()),
 'in_recovery', pg_is_in_recovery(),
 'wal_level', current_setting('wal_level'),
 'wal_compression', current_setting('wal_compression', true),
 'archive_mode', current_setting('archive_mode'),
 'archive_timeout', current_setting('archive_timeout'),
 'wal_keep_size', current_setting('wal_keep_size', true),
 'max_wal_size', current_setting('max_wal_size', true),
 'min_wal_size', current_setting('min_wal_size', true),
 'checkpoint_timeout', current_setting('checkpoint_timeout', true),
 'full_page_writes', current_setting('full_page_writes', true),
 'max_wal_senders', current_setting('max_wal_senders')::int,
 'max_replication_slots', current_setting('max_replication_slots')::int,
 'streaming', CASE WHEN pg_is_in_recovery() THEN
   (SELECT count(*) FROM pg_stat_wal_receiver WHERE status = 'streaming')
   ELSE (SELECT count(*) FROM pg_stat_replication WHERE state = 'streaming') END,
 'lag_bytes', CASE WHEN pg_is_in_recovery() THEN
   pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()) ELSE NULL END,
 'lag_seconds', CASE WHEN pg_is_in_recovery() THEN
   extract(epoch from (clock_timestamp() - pg_last_xact_replay_timestamp())) ELSE NULL END,
 'ssl', (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
 'ssl_configured', current_setting('ssl', true),
 'archive_last_success', (SELECT last_archived_time FROM pg_stat_archiver),
 'archive_successes', (SELECT archived_count FROM pg_stat_archiver),
 'archive_last_failure', (SELECT last_failed_time FROM pg_stat_archiver),
 'archive_failures', (SELECT failed_count FROM pg_stat_archiver)
)::text;"""
FIELDS = ('server_version_num', 'db_bytes', 'in_recovery', 'wal_level', 'wal_compression', 'archive_mode',
          'archive_timeout', 'wal_keep_size', 'max_wal_size', 'min_wal_size',
          'checkpoint_timeout', 'full_page_writes', 'max_wal_senders', 'max_replication_slots',
          'streaming', 'lag_bytes', 'lag_seconds', 'ssl', 'ssl_configured', 'archive_last_success',
          'archive_successes', 'archive_last_failure', 'archive_failures')


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


def tls_profile():
    profile = capability('openssl', 'openssl_available')
    profile.update(openssl_version=ssl.OPENSSL_VERSION,
                   tls_1_2_available=ssl.HAS_TLSv1_2,
                   tls_1_3_available=ssl.HAS_TLSv1_3,
                   reason='local Python TLS capabilities do not establish server configuration or health')
    return profile


def login_profile():
    binary = shutil.which('sshd', path='/usr/bin:/bin:/usr/sbin:/sbin')
    profile = {'status': 'unknown', 'sshd_available': binary is not None,
               'reason': 'effective default SSH configuration unavailable; service and Match rules not assessed'}
    if not binary:
        return profile
    try:
        result = subprocess.run([binary, '-T'], env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'},
                                capture_output=True, text=True, timeout=3, check=True)
        keys = {'passwordauthentication': 'password', 'pubkeyauthentication': 'public_key',
                'kbdinteractiveauthentication': 'keyboard_interactive'}
        values = {}
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] in keys and parts[1] in ('yes', 'no'):
                values[keys[parts[0]]] = parts[1] == 'yes'
        if len(values) == len(keys):
            profile.update(status='ok', sshd_authentication=values,
                           reason='default configuration only; service and Match rules not assessed')
    except (OSError, subprocess.SubprocessError):
        pass
    return profile


def browser_profile(cgroup_dir=None):
    profile = capability('chromium', 'chromium_available')
    profile['cpu_quota_cores'] = None
    profile['memory_limit_bytes'] = None
    try:
        if cgroup_dir is None:
            with open('/proc/self/cgroup', encoding='ascii') as source:
                entries = [line.strip().split(':', 2) for line in source]
            relative = next(parts[2] for parts in entries if parts[:2] == ['0', ''])
            if '..' in relative.split('/'):
                raise ValueError('invalid cgroup path')
            cgroup_dir = os.path.join('/sys/fs/cgroup', relative.lstrip('/'))
        with open(os.path.join(cgroup_dir, 'cpu.max'), encoding='ascii') as source:
            quota, period = source.read().split()
        if quota != 'max' and int(period) > 0:
            profile['cpu_quota_cores'] = int(quota) / int(period)
    except (OSError, ValueError, StopIteration):
        pass
    try:
        if cgroup_dir is not None:
            with open(os.path.join(cgroup_dir, 'memory.max'), encoding='ascii') as source:
                limit = source.read().strip()
            if limit != 'max':
                profile['memory_limit_bytes'] = int(limit)
    except (OSError, ValueError):
        pass
    for name in ('node', 'pnpm'):
        profile[name + '_available'] = shutil.which(name, path='/usr/bin:/bin:/usr/sbin:/sbin') is not None
    try:
        shared = os.statvfs('/dev/shm')
        profile['shared_memory_bytes'] = shared.f_frsize * shared.f_blocks
    except OSError:
        profile['shared_memory_bytes'] = None
    return profile


def backup_profile():
    profile = {'status': 'incomplete', 'reason': 'tool availability does not establish backup configuration or health'}
    for name in ('pg_basebackup', 'pgbackrest', 'barman'):
        profile[name + '_available'] = shutil.which(name, path='/usr/bin:/bin:/usr/sbin:/sbin') is not None
    return profile


def query_postgres(socket, database, user):
    # A clean environment prevents libpq from consuming credentials or connection overrides.
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'PGPASSFILE': '/dev/null',
           'PGCONNECT_TIMEOUT': '5', 'PGSSLMODE': 'disable',
           'PGOPTIONS': '-c default_transaction_read_only=on'}
    command = ['psql', '-X', '-w', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
               '-h', socket, '-d', database, '-U', user, '-c', SQL]
    result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=10, check=True)
    data = json.loads(result.stdout)
    if not isinstance(data, dict):
        raise ValueError('invalid response')
    return data


def collect(socket=None, database=None, user=None, disk_path='/'):
    postgres = {'status': 'unknown', 'reason': 'local PostgreSQL connection not requested'}
    if socket:
        try:
            raw = query_postgres(socket, database, user)
            data = {key: raw.get(key) for key in FIELDS}
            data['major'] = raw['server_version_num'] // 10000
            optional = {'archive_last_success', 'archive_last_failure'}
            if not data['in_recovery']:
                optional.update(('lag_bytes', 'lag_seconds'))
            required = [key for key in FIELDS if key not in optional]
            postgres = {'status': 'ok' if all(data[k] is not None for k in required) else 'incomplete',
                        'data': data,
                        'access': {'transport': 'unix_socket',
                                   'authentication': {'status': 'unknown', 'reason': 'authentication method not exposed by PostgreSQL'}}}
        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
            postgres = {'status': 'error', 'reason': 'query failed or access denied; details suppressed'}
    try:
        disk = shutil.disk_usage(disk_path)
        disk_info = {'status': 'ok', 'total_bytes': disk.total, 'used_bytes': disk.used, 'free_bytes': disk.free}
    except OSError:
        disk_info = {'status': 'error', 'reason': 'disk usage unavailable'}
    cpu_count, memory_bytes = os.cpu_count(), memory()
    resources = {'status': 'ok' if cpu_count is not None and memory_bytes is not None else 'incomplete',
                 'cpu_count': cpu_count, 'memory_bytes': memory_bytes}
    return {'schemaVersion': 1, 'postgres': postgres, 'disk': disk_info,
            'resources': resources,
            'ci_browser_profile': browser_profile(),
            'time_sync': time_sync_status(),
            'tls': tls_profile(),
            'login_method': login_profile(),
            'backup': backup_profile()}


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
    parser.add_argument('--disk-path', default='/', help='local filesystem path to measure (default: /)')
    args = parser.parse_args()
    if any((args.socket, args.database, args.user)):
        if not all((args.socket, args.database, args.user)) or not args.socket.startswith('/') or any(c in args.socket for c in ',=') or any(c in value for value in (args.database, args.user) for c in '=:/'):
            parser.error('provide an absolute local socket directory and simple database and user names')
    report = collect(args.socket, args.database, args.user, args.disk_path)
    print(json.dumps(report, sort_keys=True))
    return 2 if any(report[name]['status'] != 'ok' for name in ('postgres', 'disk', 'resources', 'ci_browser_profile', 'time_sync', 'tls', 'login_method', 'backup')) else 0


if __name__ == '__main__':
    raise SystemExit(main())
