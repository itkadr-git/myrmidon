import copy
import unittest

from monitor import evaluate


class MonitoringTest(unittest.TestCase):
    def setUp(self):
        self.sample = {
            'observed_at': 1000,
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

    def test_missing_stale_future_and_disconnected(self):
        for changes in ({'observed_at': 939}, {'observed_at': 1001}, {'observed_at': None},
                        {'receiver_status': None}, {'receiver_status': 'stopped'},
                        {'replication': None}, {'replication': dict(self.sample['replication'], role='primary_or_standalone', inRecovery=False)},
                        {'replication': dict(self.sample['replication'], timeLagSeconds=None)},
                        {'replication': dict(self.sample['replication'], success=False)},
                        {'replication': dict(self.sample['replication'], rpoOk=False)}):
            with self.subTest(changes=changes):
                self.check('critical', **changes)

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


if __name__ == '__main__':
    unittest.main()
