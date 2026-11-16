import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./parse-sas.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}.txt`, import.meta.url));
const run = (input) => {
  const result = spawnSync(process.execPath, [cli], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

test('established and installed SAs expose counters without addresses', () => {
  const result = run(readFileSync(fixture('established'), 'utf8'));
  assert.equal(result.status, 'healthy');
  assert.deepEqual(result.ikeSas, [{ name: 'office', id: '1', state: 'ESTABLISHED', children: [{ name: 'office-net', id: '2', state: 'INSTALLED', installed: true, bytesIn: '1024', bytesOut: '2048' }] }]);
  assert.doesNotMatch(JSON.stringify(result), /192\.0\.2|local\.example/);
});

test('unknown metadata inside an otherwise healthy snapshot is not healthy', () => {
  const input = readFileSync(fixture('rekey'), 'utf8');
  assert.notEqual(run(input + '  UNKNOWN: garbage\n').status, 'healthy');
});

test('truncated records and corrupted tails inside healthy snapshots are unknown', () => {
  const input = readFileSync(fixture('established'), 'utf8');
  for (const [original, replacement] of [
    ['INSTALLED, TUNNEL, ESP:AES_GCM_16_128', 'INSTALLED,'],
    ['ESTABLISHED, IKEv2', 'ESTABLISHED, IKEv2 garbage'],
    ['INSTALLED, TUNNEL, ESP:AES_GCM_16_128', 'INSTALLED, TUNNEL, ESP:AES_GCM_16_128 garbage'],
    ['1024 bytes, 12 packets, 1s ago', '1024 bytes, garbage'],
    ["local  'local.example' @ 192.0.2.1[500]", 'local  garbage'],
  ]) {
    assert.equal(run(input.replace(original, replacement)).status, 'unknown', replacement);
  }
});

test('IKE without CHILD is not healthy even when named established', () => {
  assert.notEqual(run('office: #1, ESTABLISHED, IKEv2\n').status, 'healthy');
  assert.notEqual(run('office\n').status, 'healthy');
});

test('rekey keeps both CHILD SAs and accepts file input', () => {
  const result = spawnSync(process.execPath, [cli, fixture('rekey')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'healthy');
  assert.deepEqual(parsed.ikeSas[0].children.map((child) => child.id), ['2', '3']);
});

test('empty, unknown and malformed input cannot be healthy', () => {
  for (const input of ['', 'unrecognized output', 'office: #1, ESTABLISHED, IKEv2\n  office-net: #2, reqid 1, INSTALLED, TUNNEL\n    in broken bytes\n', 'office: #1, MYSTERY, IKEv2\n']) {
    assert.notEqual(run(input).status, 'healthy');
  }
});

test('non-installed CHILD and incomplete counters are not healthy', () => {
  assert.notEqual(run('office: #1, ESTABLISHED, IKEv2\n  office-net: #2, reqid 1, REKEYING, TUNNEL\n').status, 'healthy');
  assert.notEqual(run('office: #1, ESTABLISHED, IKEv2\n  office-net: #2, reqid 1, INSTALLED, TUNNEL\n').status, 'healthy');
});
