import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = resolve(root, 'scripts/corpus-replay.py');
const suite = String.raw`
import copy
import importlib.util
import sys
import unittest

spec = importlib.util.spec_from_file_location('corpus_replay', sys.argv[1])
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

class MetricsTest(unittest.TestCase):
    def percentile(self, values, p, expected):
        before = copy.deepcopy(values)
        result = replay.percentile(values, p)
        self.assertEqual(values, before)
        if expected is None:
            self.assertIsNone(result)
        else:
            self.assertAlmostEqual(result, expected)

    def report(self, live, rows):
        window = {'since': 'start', 'until': 'end'}
        before = copy.deepcopy((live, rows, window))
        result = replay.aggregate(live, rows, 'fixture', window)
        self.assertEqual((live, rows, window), before)
        return result

    def test_percentile_empty(self):
        self.percentile([], .95, None)

    def test_percentile_single(self):
        self.percentile([7], .95, 7)

    def test_percentile_unsorted(self):
        self.percentile([30, 10, 20], .5, 20)

    def test_percentile_interpolated_p95(self):
        self.percentile([40, 10, 30, 20], .95, 38.5)

    def test_top_five_excludes_sixth_from_both_sides(self):
        rows = [{'ragflow_ids': ['a','b','c','d','e','x'], 'module_ids': ['x','y','z','w','v','a'], 'module_latency_ms': 1}]
        metrics = self.report([], rows)['metrics']
        self.assertAlmostEqual(metrics['top5_overlap_mean_ids'], 0)
        self.assertAlmostEqual(metrics['top5_overlap_fraction_of_five'], 0)

    def test_top_five_intersection(self):
        rows = [{'ragflow_ids': ['a','b','c','d','e'], 'module_ids': ['e','c','q','r','s'], 'module_latency_ms': 1}]
        metrics = self.report([], rows)['metrics']
        self.assertAlmostEqual(metrics['top5_overlap_mean_ids'], 2)
        self.assertAlmostEqual(metrics['top5_overlap_fraction_of_five'], .4)

    def test_duplicate_ids_do_not_inflate_overlap(self):
        rows = [{'ragflow_ids': ['a','a','a'], 'module_ids': ['a','a'], 'module_latency_ms': 1}]
        metrics = self.report([], rows)['metrics']
        self.assertAlmostEqual(metrics['top5_overlap_mean_ids'], 1)
        self.assertAlmostEqual(metrics['top5_overlap_fraction_of_five'], .2)

    def test_overlap_mean_across_records(self):
        rows = [{'ragflow_ids': ['a','b'], 'module_ids': ['a','b'], 'module_latency_ms': 1},
                {'ragflow_ids': ['z'], 'module_ids': ['q'], 'module_latency_ms': 2}]
        metrics = self.report([], rows)['metrics']
        self.assertAlmostEqual(metrics['top5_overlap_mean_ids'], 1)
        self.assertAlmostEqual(metrics['top5_overlap_fraction_of_five'], .2)

    def test_empty_rates_use_separate_denominators(self):
        live = [{'ragflow_ids': [], 'ragflow_latency_ms': 10}, {'ragflow_ids': ['a'], 'ragflow_latency_ms': 20}, {'ragflow_ids': ['b'], 'ragflow_latency_ms': 30}]
        rows = [{'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': 1}, {'ragflow_ids': ['a'], 'module_ids': ['a'], 'module_latency_ms': 2}]
        metrics = self.report(live, rows)['metrics']
        self.assertAlmostEqual(metrics['ragflow_empty_rate'], 1/3)
        self.assertAlmostEqual(metrics['module_empty_rate'], .5)

    def test_error_rate_counts_key_presence_not_truthiness(self):
        rows = [{'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': None, 'module_error': ''},
                {'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': None, 'module_error': None},
                {'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': 4}]
        self.assertAlmostEqual(self.report([], rows)['metrics']['module_error_rate'], 2/3)

    def test_module_latency_excludes_none(self):
        rows = [{'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': 10},
                {'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': None},
                {'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': 30}]
        self.assertAlmostEqual(self.report([], rows)['metrics']['module_p95_ms'], 29)

    def test_all_missing_module_latencies(self):
        rows = [{'ragflow_ids': [], 'module_ids': [], 'module_latency_ms': None}]
        self.assertIsNone(self.report([], rows)['metrics']['module_p95_ms'])

    def test_empty_inputs_have_none_metrics(self):
        metrics = self.report([], [])['metrics']
        self.assertEqual(metrics, {'top5_overlap_mean_ids': None, 'top5_overlap_fraction_of_five': None,
            'ragflow_empty_rate': None, 'module_empty_rate': None, 'module_error_rate': None,
            'ragflow_p95_ms': None, 'module_p95_ms': None})

    def test_live_p95_and_metadata(self):
        live = [{'ragflow_ids': ['a'], 'ragflow_latency_ms': 10}, {'ragflow_ids': [], 'ragflow_latency_ms': 30}]
        rows = [{'ragflow_ids': ['a'], 'module_ids': ['a'], 'module_latency_ms': 5}]
        report = self.report(live, rows)
        self.assertAlmostEqual(report['metrics']['ragflow_p95_ms'], 29)
        self.assertEqual(report['live_source'], 'fixture')
        self.assertEqual(report['window_utc'], {'since': 'start', 'until': 'end'})
        self.assertEqual(report['live_query_count'], 2)
        self.assertEqual(report['replayed_count'], 1)
        self.assertEqual(report['records'], rows)

    def test_recommendation_and_golden_set(self):
        report = self.report([], [])
        self.assertTrue(report['recommendation'].startswith('NO-GO:'))
        self.assertEqual(report['golden_set']['status'], 'not_run')

result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(MetricsTest))
print('PYTHON_TESTS=%d SKIPPED=%d' % (result.testsRun, len(result.skipped)))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
`;

test('corpus replay metric denominators and p95', () => {
  const result = spawnSync('python3', ['-c', suite, script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nerror: ${result.error ?? 'none'}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /PYTHON_TESTS=([1-9]\d*) SKIPPED=0\b/, output);
  console.log(result.stdout.trim());
});
