import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../corpus-replay.py', import.meta.url));

const python = String.raw`
import importlib.util
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

spec = importlib.util.spec_from_file_location('corpus_replay', sys.argv[1])
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)
SINCE = datetime(2026, 10, 21, tzinfo=timezone.utc)
UNTIL = datetime(2026, 10, 22, tzinfo=timezone.utc)
BASE = {'ts': '2026-10-21T12:00:00Z', 'bot_id': 'bot', 'dataset': 'ds',
        'query': 'q', 'ragflow_ids': ['a'], 'ragflow_latency_ms': 12}

class InputWindow(unittest.TestCase):
    def load(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'input.jsonl'
            original = text.encode('utf-8')
            path.write_bytes(original)
            try:
                return replay.load_rows(path, SINCE, UNTIL)
            finally:
                self.assertEqual(path.read_bytes(), original)

    def row(self, timestamp, query):
        return {**BASE, 'ts': timestamp, 'query': query}

    def test_since_included(self):
        row = self.row('2026-10-21T00:00:00Z', 'since')
        self.assertEqual(self.load(json.dumps(row)), [row])

    def test_until_excluded(self):
        row = self.row('2026-10-22T00:00:00Z', 'until')
        self.assertEqual(self.load(json.dumps(row)), [])

    def test_before_since_excluded(self):
        self.assertEqual(self.load(json.dumps(self.row('2026-10-20T23:59:59Z', 'before'))), [])

    def test_after_until_excluded(self):
        self.assertEqual(self.load(json.dumps(self.row('2026-10-22T00:00:01Z', 'after'))), [])

    def test_equivalent_offsets_and_order(self):
        rows = [self.row('2026-10-21T20:00:00+08:00', 'first'),
                self.row('2026-10-21T12:00:00Z', 'second'),
                self.row('2026-10-21T00:00:00Z', 'third')]
        self.assertEqual(replay.parse_time(rows[0]['ts']), replay.parse_time(rows[1]['ts']))
        self.assertEqual(self.load('\n'.join(map(json.dumps, rows))), rows)

    def test_blank_lines_are_skipped(self):
        self.assertEqual(self.load('\n  \n' + json.dumps(BASE) + '\n\t\n'), [BASE])

    def test_missing_required_keys(self):
        for key in ('ts', 'bot_id', 'dataset', 'query', 'ragflow_ids', 'ragflow_latency_ms'):
            with self.subTest(key=key):
                row = {k: v for k, v in BASE.items() if k != key}
                with self.assertRaises(ValueError) as error:
                    self.load('\n' + json.dumps(row))
                self.assertEqual(str(error.exception), 'line 2: missing ' + key)

    def test_ids_not_list(self):
        with self.assertRaises(ValueError) as error:
            self.load(json.dumps({**BASE, 'ragflow_ids': 'a'}))
        self.assertEqual(str(error.exception), 'line 1: ragflow_ids must be a string array')

    def test_ids_with_non_string(self):
        with self.assertRaises(ValueError) as error:
            self.load(json.dumps({**BASE, 'ragflow_ids': ['a', 1]}))
        self.assertEqual(str(error.exception), 'line 1: ragflow_ids must be a string array')

    def test_negative_latency(self):
        with self.assertRaises(ValueError) as error:
            self.load(json.dumps({**BASE, 'ragflow_latency_ms': -1}))
        self.assertEqual(str(error.exception), 'line 1: ragflow_latency_ms must be nonnegative')

    def test_naive_timestamp(self):
        with self.assertRaises(ValueError) as error:
            self.load(json.dumps({**BASE, 'ts': '2026-10-21T12:00:00'}))
        self.assertEqual(str(error.exception), 'timestamps must include a timezone')

    def test_zero_latency_and_empty_ids(self):
        row = {**BASE, 'ragflow_ids': [], 'ragflow_latency_ms': 0}
        self.assertEqual(self.load(json.dumps(row)), [row])

suite = unittest.defaultTestLoader.loadTestsFromTestCase(InputWindow)
result = unittest.TextTestRunner(verbosity=2).run(suite)
print('PYTHON_TESTS=%d SKIPPED=%d' % (result.testsRun, len(result.skipped)))
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
`;

test('corpus replay input window and validation', () => {
  const result = spawnSync('python3', ['-c', python, script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const output = `stdout:\n${result.stdout ?? ''}\nstderr:\n${result.stderr ?? ''}\n${result.error ?? ''}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /PYTHON_TESTS=([1-9]\d*) SKIPPED=0/, output);
  console.log(result.stdout.trim());
});
