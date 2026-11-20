import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const max = BigInt(Number.MAX_SAFE_INTEGER);
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to });

function run(t, report) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || homedir(), 'critical-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli], {
    input: JSON.stringify(report), encoding: 'utf8', cwd: dir,
    env: { ...process.env, HOME: dir, TMPDIR: dir }, shell: false,
    timeout: 10000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function check(t, report, paths, weights) {
  const sum = weights.reduce((a, b) => a + b, 0n);
  const safe = sum <= max;
  const result = run(t, report);
  assert.equal(result.status, safe ? 0 : 1);
  assert.equal(result.stderr, safe ? '' : 'graph\n');
  assert.equal(result.stdout, safe ? JSON.stringify({ entry: report.entry, paths, bytes: Number(sum) }) + '\n' : '');
}

test('safe integer boundaries and zero chains', t => {
  check(t, {entry:'a', modules:[m('a', Number(max))], edges:[]}, ['a'], [max]);
  check(t, {entry:'a', modules:[m('a', Number(max - 1n)), m('b', 1)], edges:[e('a','b')]}, ['a','b'], [max - 1n, 1n]);
  check(t, {entry:'a', modules:[m('a', Number(max - 1n)), m('b', 2)], edges:[e('a','b')]}, null, [max - 1n, 2n]);
  check(t, {entry:'a', modules:[m('a', 0), m('b', 0), m('c', 0)], edges:[e('a','b'), e('b','c')]}, ['a'], [0n, 0n, 0n]);
  check(t, {entry:'a', modules:[m('a', Number(max)), m('b', 0), m('c', 0)], edges:[e('a','b'), e('b','c')]}, ['a'], [max, 0n, 0n]);
});

test('overflow in a competing reachable branch fails the graph', t => {
  const report = {entry:'a', modules:[m('a', 1), m('b', 2), m('x', Number(max))], edges:[e('a','b'), e('a','x')]};
  check(t, report, null, [1n, max]);
});

test('disconnected and lazy-only overflow does not affect the eager result', t => {
  for (const edges of [[e('x','y')], [e('a','x','lazy'), e('x','y')]]) {
    const report = {entry:'a', modules:[m('a', 3), m('b', 4), m('x', Number(max), false), m('y', 1, false)], edges:[e('a','b'), ...edges]};
    assert.ok(max + 1n > max);
    check(t, report, ['a','b'], [3n, 4n]);
  }
});

test('invalid module bytes fail shape even outside the eager closure', t => {
  for (const bytes of [0.5, -1, Number(max + 1n), '1', null]) {
    for (const edges of [[], [e('a','x','lazy')]]) {
      const result = run(t, {entry:'a', modules:[m('a', 1), m('x', bytes, false)], edges});
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'shape\n');
    }
  }
});
