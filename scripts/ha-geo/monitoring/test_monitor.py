import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest

from monitor import evaluate


class MonitoringTest(unittest.TestCase):
    def setUp(self):
        self.sample = {
            'observed_at': 1000,
            'source_observed_at': {'replication': 1000, 'receiver': 1000, 'wal': 1000, 'host': 1000},
            'replication': {'success': True, 'rpoOk': True, 'role': 'standby',
                            'inRecovery': True, 'timeLagSeconds': 10},
            'receiver_status': 'streaming',
            'wal_retained_bytes': 100,
            'wal_limit_bytes': 1000,
            'disk_used_percent': 40,
            'memory_used_percent': 40,
            'cpu_used_percent': 40,
        }

    def check(self, expected, **changes):
        sample = copy.deepcopy(self.sample)
        sample.update(changes)
        result = evaluate(sample, now=1000)
        self.assertEqual(result['status'], expected, result)
        return result

    def test_healthy(self):
        self.check('ok')

    def test_lag_boundaries(self):
        for lag, expected in [(239, 'ok'), (240, 'warning'), (299, 'warning'), (300, 'critical')]:
            replication = dict(self.sample['replication'], timeLagSeconds=lag)
            with self.subTest(lag=lag):
                self.check(expected, replication=replication)

    def test_stale_metric_source_is_not_hidden_by_fresh_envelope(self):
        source_times = dict(self.sample['source_observed_at'], replication=939)
        result = evaluate(dict(self.sample, source_observed_at=source_times), now=1000)
        self.assertEqual(result['status'], 'critical', result)
        self.assertEqual(next(check for check in result['checks'] if check['name'] == 'replication_freshness')['status'], 'critical')

    def test_missing_stale_future_and_disconnected(self):
        for changes in ({'observed_at': 939}, {'observed_at': 1001}, {'observed_at': None},
                        {'receiver_status': None}, {'receiver_status': 'stopped'},
                        {'replication': None}, {'replication': dict(self.sample['replication'], role='primary_or_standalone', inRecovery=False)},
                        {'replication': dict(self.sample['replication'], timeLagSeconds=None)},
                        {'replication': dict(self.sample['replication'], success=False)},
                        {'replication': dict(self.sample['replication'], rpoOk=False)}):
            with self.subTest(changes=changes):
                self.check('critical', **changes)

    def test_check_lag_cli_output_is_consumed(self):
        sample = copy.deepcopy(self.sample)
        sample['replication'] = {'command': 'check-lag', 'allRpoOk': True,
                                 'results': [dict(sample['replication'], target='board')]}
        self.assertEqual(evaluate(sample, now=1000)['status'], 'ok')
        sample['replication']['results'][0]['timeLagSeconds'] = 300
        self.assertEqual(evaluate(sample, now=1000)['status'], 'critical')
        sample['replication']['results'] = []
        self.assertEqual(evaluate(sample, now=1000)['status'], 'critical')

    def test_aggregate_lag_does_not_hide_missing_database_sample(self):
        child = dict(self.sample['replication'], target='board', timeLagSeconds=None)
        aggregate = dict(self.sample['replication'], target='all', timeLagSeconds=10,
                         databases=[child, dict(self.sample['replication'], target='hindsight')])
        self.check('critical', replication=aggregate)

    def test_cli_emits_status_and_exit_code(self):
        sample = copy.deepcopy(self.sample)
        now = time.time()
        sample['observed_at'] = now
        sample['source_observed_at'] = dict.fromkeys(sample['source_observed_at'], now)
        command = [sys.executable, str(Path(__file__).with_name('monitor.py'))]
        for lag, expected_code, expected_status in [(10, 0, 'ok'), (240, 1, 'warning'), (300, 2, 'critical')]:
            with self.subTest(lag=lag):
                sample['replication']['timeLagSeconds'] = lag
                result = subprocess.run(command, input=json.dumps(sample), text=True,
                                        capture_output=True, env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1'))
                self.assertEqual(result.returncode, expected_code, result.stderr)
                self.assertEqual(json.loads(result.stdout)['status'], expected_status)
        invalid = subprocess.run(command, input='{', text=True, capture_output=True)
        self.assertEqual(invalid.returncode, 2)
        self.assertEqual(json.loads(invalid.stdout)['status'], 'critical')

    def test_resource_pressure_and_missing(self):
        for field in ('disk_used_percent', 'memory_used_percent', 'cpu_used_percent'):
            with self.subTest(field=field):
                self.check('warning', **{field: 80})
                self.check('critical', **{field: 90})
                self.check('critical', **{field: None})
        self.check('warning', wal_retained_bytes=800)
        self.check('critical', wal_retained_bytes=900)
        self.check('critical', wal_limit_bytes=0)
        self.check('critical', wal_retained_bytes=-1)

    def test_adapter_combines_timestamped_sources_and_evaluates(self):
        command = [sys.executable, str(Path(__file__).with_name('adapter.py'))]
        now = time.time()
        sources = {
            'replication': {'observed_at': now, 'value': self.sample['replication']},
            'receiver': {'observed_at': now, 'value': {'receiver_status': 'streaming'}},
            'wal': {'observed_at': now, 'value': {'wal_retained_bytes': 100, 'wal_limit_bytes': 1000}},
            'host': {'observed_at': now, 'value': {'disk_used_percent': 40, 'memory_used_percent': 40, 'cpu_used_percent': 40}},
        }
        result = subprocess.run(command, input=json.dumps(sources), text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'ok')
        sources['wal']['observed_at'] = now - 61
        result = subprocess.run(command, input=json.dumps(sources), text=True, capture_output=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'critical')
        del sources['receiver']
        result = subprocess.run(command, input=json.dumps(sources), text=True, capture_output=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'critical')


if __name__ == '__main__':
    unittest.main()
