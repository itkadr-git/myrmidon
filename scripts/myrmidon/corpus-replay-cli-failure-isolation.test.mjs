import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../corpus-replay.py', import.meta.url));
const python = String.raw`
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import call, patch
from urllib.error import URLError

spec = importlib.util.spec_from_file_location('corpus_replay', sys.argv[1])
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

class ReplayCliTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.input = Path(self.directory.name) / 'input.jsonl'
        self.output = Path(self.directory.name) / 'report.json'
        self.argv = ['corpus-replay', '--input', str(self.input), '--output', str(self.output),
                     '--company-id', 'synthetic-company', '--since', '2026-01-01T00:00:00Z',
                     '--until', '2026-01-02T00:00:00Z', '--live-source', 'synthetic']

    def write_rows(self, rows):
        self.input.write_text(''.join(json.dumps(row) + '\n' for row in rows), encoding='utf-8')

    def test_failure_isolated_and_reported(self):
        rows = [dict(ts='2026-01-01T12:00:00Z', bot_id='synthetic', dataset='dataset',
                     query=f'query-{i}', ragflow_ids=ids, ragflow_latency_ms=latency)
                for i, ids, latency in [(1, ['a'], 10), (2, [], 20), (3, ['c'], 30)]]
        self.write_rows(rows)
        for error in (TimeoutError('private detail'), URLError('private detail'), ValueError('private detail')):
            with self.subTest(error=type(error).__name__):
                stdout = io.StringIO()
                with patch.object(sys, 'argv', self.argv), patch.dict(os.environ, {'CORPUS_REPLAY_TOKEN': 'synthetic-token'}, clear=True), \
                     patch.object(replay, 'corpus_search', side_effect=[(['a'], 100), error, (['c'], 300)]) as search, \
                     contextlib.redirect_stdout(stdout):
                    self.assertEqual(replay.main(), 0)
                self.assertEqual(search.call_args_list, [call('http://localhost:3100', 'synthetic-token', 'synthetic-company', 'dataset', f'query-{i}', 30) for i in (1, 2, 3)])
                report = json.loads(self.output.read_text(encoding='utf-8'))
                self.assertEqual(report['live_query_count'], 3)
                self.assertEqual(report['replayed_count'], 3)
                self.assertEqual(report['records'], [
                    {**rows[0], 'module_ids': ['a'], 'module_latency_ms': 100},
                    {**rows[1], 'module_ids': [], 'module_latency_ms': None, 'module_error': type(error).__name__},
                    {**rows[2], 'module_ids': ['c'], 'module_latency_ms': 300},
                ])
                self.assertEqual(report['metrics'], {'top5_overlap_mean_ids': 2/3,
                    'top5_overlap_fraction_of_five': (2/3)/5, 'ragflow_empty_rate': 1/3,
                    'module_empty_rate': 1/3, 'module_error_rate': 1/3,
                    'ragflow_p95_ms': 29.0, 'module_p95_ms': 290.0})
                self.assertEqual(json.loads(stdout.getvalue()), {'live_query_count': 3, 'replayed_count': 3, 'report': str(self.output)})

    def test_empty_input(self):
        self.write_rows([])
        stdout = io.StringIO()
        with patch.object(sys, 'argv', self.argv), patch.dict(os.environ, {'CORPUS_REPLAY_TOKEN': 'synthetic-token'}, clear=True), \
             patch.object(replay, 'corpus_search') as search, contextlib.redirect_stdout(stdout):
            self.assertEqual(replay.main(), 0)
        search.assert_not_called()
        report = json.loads(self.output.read_text(encoding='utf-8'))
        self.assertEqual((report['live_query_count'], report['replayed_count'], report['records']), (0, 0, []))
        self.assertTrue(all(value is None for value in report['metrics'].values()))
        self.assertEqual(json.loads(stdout.getvalue()), {'live_query_count': 0, 'replayed_count': 0, 'report': str(self.output)})

    def test_invalid_arguments_fail_before_search_or_output(self):
        self.write_rows([])
        for argv, env in ((self.argv, {}),
                          (self.argv[:-2] + ['--until', '2026-01-01T00:00:00Z'], {'CORPUS_REPLAY_TOKEN': 'synthetic-token'}),
                          (self.argv[:-2] + ['--until', '2025-12-31T00:00:00Z'], {'CORPUS_REPLAY_TOKEN': 'synthetic-token'})):
            with self.subTest(argv=argv, env=env), patch.object(sys, 'argv', argv), patch.dict(os.environ, env, clear=True), \
                 patch.object(replay, 'corpus_search') as search, contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()) as stdout:
                with self.assertRaises(SystemExit) as exit_error:
                    replay.main()
                self.assertEqual(exit_error.exception.code, 2)
                search.assert_not_called()
                self.assertFalse(self.output.exists())
                self.assertEqual(stdout.getvalue(), '')

suite = unittest.defaultTestLoader.loadTestsFromTestCase(ReplayCliTest)
result = unittest.TextTestRunner(verbosity=2).run(suite)
print(f'PYTHON_TESTS={result.testsRun} SKIPPED={len(result.skipped)}')
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
`;

test('replay CLI isolates row failures and validates inputs', () => {
  const result = spawnSync('python3', ['-c', python, script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const details = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nerror: ${result.error ?? ''}`;
  assert.equal(result.status, 0, details);
  assert.match(result.stdout, /PYTHON_TESTS=[1-9]\d* SKIPPED=0/, details);
  console.log(result.stdout.trim());
});
