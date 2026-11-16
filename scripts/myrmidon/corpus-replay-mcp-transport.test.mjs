import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../corpus-replay.py', import.meta.url));
const python = String.raw`
import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('corpus_replay', sys.argv[1])
replay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(replay)

class TransportTest(unittest.TestCase):
    def call(self, envelope):
        response = io.BytesIO(json.dumps(envelope).encode())
        with patch('urllib.request.urlopen') as urlopen, patch('time.perf_counter', side_effect=[10.0, 10.125]):
            urlopen.return_value.__enter__.return_value = response
            result = replay.corpus_search('https://example.invalid/base/', 'synthetic-token', 'company-123', 'dataset-1', 'query text', 7.5)
        return result, urlopen

    def success(self, hits):
        return self.call({'result': {'structuredContent': {'hits': hits}}})

    def test_post_url(self):
        _, call = self.success([])
        self.assertEqual(call.call_args.args[0].full_url, 'https://example.invalid/base/api/myrmidon/companies/company-123/corpus/mcp')
        self.assertEqual(call.call_args.args[0].get_method(), 'POST')

    def test_headers(self):
        _, call = self.success([])
        req = call.call_args.args[0]
        self.assertEqual(req.get_header('Content-type'), 'application/json')
        self.assertEqual(req.get_header('Authorization'), 'Bearer synthetic-token')

    def test_timeout(self):
        _, call = self.success([])
        self.assertEqual(call.call_args.kwargs, {'timeout': 7.5})
        self.assertEqual(call.call_count, 1)

    def test_jsonrpc(self):
        _, call = self.success([])
        body = json.loads(call.call_args.args[0].data)
        self.assertEqual(body, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'corpus_search', 'arguments': {'dataset': 'dataset-1', 'query': 'query text', 'top_k': 10}}})

    def test_order_and_duplicates(self):
        (ids, _), _ = self.success([{'chunkId': 'b'}, {'chunkId': 'a'}, {'chunkId': 'b'}])
        self.assertEqual(ids, ['b', 'a', 'b'])

    def test_non_dict_hits_filtered(self):
        (ids, _), _ = self.success([None, 'x', 1, {'chunkId': 'valid'}, []])
        self.assertEqual(ids, ['valid'])

    def test_non_string_ids_filtered(self):
        (ids, _), _ = self.success([{}, {'chunkId': None}, {'chunkId': 1}, {'chunkId': []}, {'chunkId': 'valid'}])
        self.assertEqual(ids, ['valid'])

    def test_empty_hits(self):
        (ids, _), _ = self.success([])
        self.assertEqual(ids, [])

    def test_latency(self):
        (_, latency), _ = self.success([{'chunkId': 'x'}])
        self.assertEqual(latency, 125.0)
        self.assertGreaterEqual(latency, 0)

    def test_error_result(self):
        with self.assertRaisesRegex(ValueError, 'error or no structuredContent'):
            self.call({'result': {'isError': True, 'structuredContent': {'hits': []}}})

    def test_missing_structured(self):
        with self.assertRaisesRegex(ValueError, 'error or no structuredContent'):
            self.call({'result': {}})

    def test_non_dict_structured(self):
        with self.assertRaisesRegex(ValueError, 'error or no structuredContent'):
            self.call({'result': {'structuredContent': []}})

    def test_missing_hits(self):
        with self.assertRaisesRegex(ValueError, 'no hits array'):
            self.call({'result': {'structuredContent': {}}})

    def test_non_list_hits(self):
        with self.assertRaisesRegex(ValueError, 'no hits array'):
            self.call({'result': {'structuredContent': {'hits': {}}}})

    def test_url_error_propagates(self):
        error = urllib.error.URLError('synthetic failure')
        with patch('urllib.request.urlopen', side_effect=error), patch('time.perf_counter', return_value=10.0):
            with self.assertRaises(urllib.error.URLError) as caught:
                replay.corpus_search('https://example.invalid/', 'synthetic-token', 'company-123', 'dataset-1', 'query text', 7.5)
        self.assertIs(caught.exception, error)

suite = unittest.defaultTestLoader.loadTestsFromTestCase(TransportTest)
result = unittest.TextTestRunner(verbosity=2).run(suite)
print('PYTHON_COUNTS tests=%d skipped=%d' % (result.testsRun, len(result.skipped)), flush=True)
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
`;

test('corpus replay MCP transport executes Python cases without skips', () => {
  const result = spawnSync('python3', ['-c', python, script], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  const output = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
  assert.equal(result.status, 0, `${result.error ?? ''}\n${output}`);
  assert.match(result.stdout, /PYTHON_COUNTS tests=([1-9]\d*) skipped=0\b/, output);
  console.log(result.stdout.trim());
});
