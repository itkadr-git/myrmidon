import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import collector


class CollectorTests(unittest.TestCase):
    def test_default_is_json_and_incomplete_without_connection(self):
        result = subprocess.run([sys.executable, str(Path(collector.__file__))], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertEqual(report['schemaVersion'], 1)
        self.assertEqual(report['postgres']['status'], 'unknown')

    def test_complete_report_returns_zero_and_json(self):
        import contextlib
        import io

        areas = ('postgres', 'disk', 'resources', 'ci_browser_profile',
                 'time_sync', 'tls', 'login_method', 'backup')
        report = {'schemaVersion': 1, **{area: {'status': 'ok'} for area in areas}}
        stdout = io.StringIO()
        with patch.object(collector, 'collect', return_value=report), \
             patch.object(sys, 'argv', ['collector.py']), contextlib.redirect_stdout(stdout):
            result = collector.main()
        self.assertEqual(result, 0)
        self.assertEqual(json.loads(stdout.getvalue()), report)

    def test_primary_and_standby_fixtures(self):
        for recovery in (False, True):
            with self.subTest(recovery=recovery):
                fixture = {'server_version_num': 160002, 'db_bytes': 123, 'in_recovery': recovery,
                           'wal_level': 'replica', 'archive_mode': 'on', 'max_wal_senders': 10,
                           'max_replication_slots': 10, 'streaming': 1, 'lag_bytes': 5,
                           'ssl': True, 'password': 'fixture-secret'}
                with patch.object(collector, 'query_postgres', return_value=fixture):
                    report = collector.collect('/socket', 'db', 'operator')
                self.assertEqual(report['postgres']['data']['in_recovery'], recovery)
                self.assertNotIn('fixture-secret', json.dumps(report))
                self.assertNotIn('password', report['postgres']['data'])

    def test_unavailable_is_explicit_and_does_not_echo_errors(self):
        with patch.object(collector, 'query_postgres', side_effect=OSError('password=fixture-secret')):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['status'], 'error')
        self.assertNotIn('fixture-secret', json.dumps(report))

    def test_local_capabilities_report_actual_results_without_secrets(self):
        with patch.object(collector.shutil, 'which', side_effect=lambda name, **kwargs: '/usr/bin/' + name if name in ('openssl', 'sshd', 'chromium') else None), \
             patch.object(collector, 'time_sync_status', return_value={'status': 'ok', 'synchronized': True}):
            report = collector.collect()
        self.assertTrue(report['tls']['openssl_available'])
        self.assertTrue(report['login_method']['sshd_available'])
        self.assertTrue(report['ci_browser_profile']['chromium_available'])
        self.assertTrue(report['time_sync']['synchronized'])
        self.assertEqual(report['backup']['status'], 'incomplete')

    def test_backup_and_ci_tool_availability_are_reported_without_claiming_configuration(self):
        tools = {'pg_basebackup', 'pgbackrest', 'node', 'chromium'}
        with patch.object(collector.shutil, 'which', side_effect=lambda name, **kwargs: '/usr/bin/' + name if name in tools else None):
            report = collector.collect()
        self.assertTrue(report['backup']['pg_basebackup_available'])
        self.assertTrue(report['backup']['pgbackrest_available'])
        self.assertFalse(report['backup']['barman_available'])
        self.assertEqual(report['backup']['status'], 'incomplete')
        self.assertTrue(report['ci_browser_profile']['node_available'])
        self.assertFalse(report['ci_browser_profile']['pnpm_available'])

    def test_tls_profile_reports_local_runtime_capabilities_without_claiming_server_health(self):
        profile = collector.tls_profile()
        self.assertEqual(profile['status'], 'incomplete')
        self.assertIsInstance(profile['openssl_version'], str)
        self.assertIsInstance(profile['tls_1_2_available'], bool)
        self.assertIsInstance(profile['tls_1_3_available'], bool)
        self.assertIn('server', profile['reason'])

    def test_login_profile_reports_effective_sshd_auth_methods_without_secret_output(self):
        response = subprocess.CompletedProcess([], 0, stdout=(
            'passwordauthentication no\npubkeyauthentication yes\n'
            'kbdinteractiveauthentication yes\nhostkey /secret/path\n'), stderr='')
        with patch.object(collector.shutil, 'which', return_value='/usr/sbin/sshd'), \
             patch.object(collector.subprocess, 'run', return_value=response):
            profile = collector.login_profile()
        self.assertEqual(profile['status'], 'ok')
        self.assertEqual(profile['sshd_authentication'], {
            'password': False, 'public_key': True, 'keyboard_interactive': True})
        self.assertNotIn('/secret/path', json.dumps(profile))

    def test_login_profile_failed_sshd_does_not_expose_error(self):
        with patch.object(collector.shutil, 'which', return_value='/usr/sbin/sshd'), \
             patch.object(collector.subprocess, 'run', side_effect=OSError('secret')):
            profile = collector.login_profile()
        self.assertEqual(profile['status'], 'unknown')
        self.assertNotIn('secret', json.dumps(profile))

    def test_ci_profile_includes_shared_memory_capacity(self):
        with patch.object(collector.os, 'statvfs') as statvfs:
            statvfs.return_value.f_frsize = 4096
            statvfs.return_value.f_blocks = 100
            report = collector.collect()
        self.assertEqual(report['ci_browser_profile']['shared_memory_bytes'], 409600)
        self.assertEqual(report['ci_browser_profile']['status'], 'incomplete')

    def test_ci_profile_reports_cgroup_v2_limits_without_guessing(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory() as root:
            Path(root, 'cpu.max').write_text('200000 100000\n')
            Path(root, 'memory.max').write_text('1073741824\n')
            profile = collector.browser_profile(root)
        self.assertEqual(profile['cpu_quota_cores'], 2.0)
        self.assertEqual(profile['memory_limit_bytes'], 1073741824)

    def test_shared_memory_unavailable_is_explicit(self):
        with patch.object(collector.os, 'statvfs', side_effect=OSError('secret detail')):
            report = collector.collect()
        self.assertIsNone(report['ci_browser_profile']['shared_memory_bytes'])
        self.assertNotIn('secret detail', json.dumps(report))

    def test_standby_time_lag_is_reported_and_required(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=True, lag_seconds=12.5)
        with patch.object(collector, 'query_postgres', return_value=fixture):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['data']['lag_seconds'], 12.5)
        fixture['lag_seconds'] = None
        with patch.object(collector, 'query_postgres', return_value=fixture):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['status'], 'incomplete')

    def test_postgres_incomplete_when_standby_lag_unavailable(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=True, lag_bytes=None)
        with patch.object(collector, 'query_postgres', return_value=fixture):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['status'], 'incomplete')

    def test_primary_without_archive_history_is_not_incomplete(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False, lag_bytes=None,
                       lag_seconds=None, archive_last_success=None, archive_last_failure=None)
        with patch.object(collector, 'query_postgres', return_value=fixture):
            postgres = collector.collect('/socket', 'db', 'operator')['postgres']
        self.assertEqual(postgres['status'], 'ok')
        self.assertIsNone(postgres['data']['archive_last_success'])
        self.assertIsNone(postgres['data']['archive_last_failure'])

    def test_missing_host_resources_are_explicitly_incomplete(self):
        with patch.object(collector.os, 'cpu_count', return_value=None), \
             patch.object(collector, 'memory', return_value=None):
            resources = collector.collect()['resources']
        self.assertEqual(resources['status'], 'incomplete')
        self.assertIsNone(resources['cpu_count'])
        self.assertIsNone(resources['memory_bytes'])

    def test_backup_archive_counters_are_reported_without_archive_commands(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False,
                       archive_successes=12, archive_last_failure='2026-01-02T00:00:00Z')
        with patch.object(collector, 'query_postgres', return_value=fixture):
            data = collector.collect('/socket', 'db', 'operator')['postgres']['data']
        self.assertEqual(data['archive_successes'], 12)
        self.assertEqual(data['archive_last_failure'], '2026-01-02T00:00:00Z')
        self.assertIn('archived_count', collector.SQL)
        self.assertIn('last_failed_time', collector.SQL)
        self.assertNotIn('archive_command', collector.SQL)

    def test_database_backup_and_tls_facts_are_retained(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False, lag_bytes=None,
                       archive_last_success='2026-01-01T00:00:00Z', archive_failures=3,
                       ssl_configured='on')
        with patch.object(collector, 'query_postgres', return_value=fixture):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['data']['archive_last_success'], '2026-01-01T00:00:00Z')
        self.assertEqual(report['postgres']['data']['archive_failures'], 3)
        self.assertEqual(report['postgres']['data']['ssl_configured'], 'on')

    def test_wal_compression_is_reported_without_exposing_archive_command(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False, wal_compression='lz4')
        with patch.object(collector, 'query_postgres', return_value=fixture):
            data = collector.collect('/socket', 'db', 'operator')['postgres']['data']
        self.assertEqual(data['wal_compression'], 'lz4')
        self.assertIn("current_setting('wal_compression'", collector.SQL)
        self.assertNotIn('archive_command', collector.SQL)

    def test_wal_retention_and_checkpoint_settings_are_reported(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False,
                       max_wal_size='1GB', min_wal_size='80MB',
                       checkpoint_timeout='5min', full_page_writes='on')
        with patch.object(collector, 'query_postgres', return_value=fixture):
            data = collector.collect('/socket', 'db', 'operator')['postgres']['data']
        self.assertEqual(data['max_wal_size'], '1GB')
        self.assertEqual(data['min_wal_size'], '80MB')
        self.assertEqual(data['checkpoint_timeout'], '5min')
        self.assertEqual(data['full_page_writes'], 'on')
        for key in ('max_wal_size', 'min_wal_size', 'checkpoint_timeout', 'full_page_writes'):
            self.assertIn("current_setting('" + key + "'", collector.SQL)

    def test_postgres_access_reports_local_transport_without_guessing_authentication(self):
        fixture = dict.fromkeys(collector.FIELDS, 1)
        fixture.update(server_version_num=160002, in_recovery=False)
        with patch.object(collector, 'query_postgres', return_value=fixture):
            report = collector.collect('/socket', 'db', 'operator')
        self.assertEqual(report['postgres']['access']['transport'], 'unix_socket')
        self.assertEqual(report['postgres']['access']['authentication']['status'], 'unknown')

    def test_query_uses_read_only_transaction_and_scrubbed_environment(self):
        response = subprocess.CompletedProcess([], 0, stdout='{}', stderr='')
        with patch.object(collector.subprocess, 'run', return_value=response) as run:
            collector.query_postgres('/socket', 'db', 'operator')
        args, kwargs = run.call_args
        self.assertEqual(kwargs['env']['PGOPTIONS'], '-c default_transaction_read_only=on')
        self.assertNotIn('PGPASSWORD', kwargs['env'])
        self.assertIn('-w', args[0])
        self.assertIn('-X', args[0])
        self.assertEqual(kwargs['env']['PGPASSFILE'], '/dev/null')

    def test_operator_can_measure_an_explicit_local_disk_path(self):
        result = subprocess.run([sys.executable, str(Path(collector.__file__)), '--disk-path', '/dev/shm'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        report = json.loads(result.stdout)
        self.assertNotIn('path', report['disk'])
        self.assertEqual(report['disk']['status'], 'ok')
        self.assertGreater(report['disk']['total_bytes'], 0)

    def test_disk_reports_used_capacity(self):
        with patch.object(collector.shutil, 'disk_usage', return_value=SimpleNamespace(total=1000, used=600, free=400)):
            disk = collector.collect()['disk']
        self.assertEqual(disk['used_bytes'], 600)
        self.assertEqual(disk['free_bytes'], 400)
        self.assertEqual(disk['total_bytes'], 1000)

    def test_disk_path_does_not_leak_sensitive_input(self):
        from tempfile import TemporaryDirectory
        with TemporaryDirectory(prefix='password-fixture-secret-') as root:
            result = subprocess.run([sys.executable, str(Path(collector.__file__)), '--disk-path', root], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['disk']['status'], 'ok')
            self.assertNotIn('fixture-secret', result.stdout)

    def test_remote_socket_is_rejected(self):
        result = subprocess.run([sys.executable, str(Path(collector.__file__)), '--socket', 'example.com', '--database', 'db', '--user', 'operator'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('example.com', result.stdout)


if __name__ == '__main__':
    unittest.main()
