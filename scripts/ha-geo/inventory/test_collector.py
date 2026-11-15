import json
import subprocess
import sys
import unittest
from pathlib import Path
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

    def test_remote_socket_is_rejected(self):
        result = subprocess.run([sys.executable, str(Path(collector.__file__)), '--socket', 'example.com', '--database', 'db', '--user', 'operator'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('example.com', result.stdout)


if __name__ == '__main__':
    unittest.main()
