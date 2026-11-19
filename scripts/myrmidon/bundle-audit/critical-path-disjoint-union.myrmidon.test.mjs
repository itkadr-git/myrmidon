import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'import-report-critical-path.mjs');
const m = (path, bytes, eager = true) => ({ path, bytes, eager });
const e = (from, to) => ({ from, specifier: to, kind: 'eager', to });
const run = report => spawnSync(process.execPath, [cli], { input: JSON.stringify(report), encoding: 'utf8', cwd: homedir(), timeout: 10000 });
const success = (report, expected) => {
  const result = run(report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
};
const graph = report => {
  const result = run(report);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'graph\n');
};

test('disjoint unions preserve each entry closure', () => {
  const pairs = [
    {
      a: { entry: 'a', modules: [m('a', 2), m('a1', 3)], edges: [e('a', 'a1')] },
      b: { entry: 'b', modules: [m('b', 1000000), m('b1', 2000000)], edges: [e('b', 'b1'), e('b1', 'b')] },
      aExpected: { entry: 'a', paths: ['a', 'a1'], bytes: 5 }, bExpected: null,
    },
    {
      a: { entry: 'c', modules: [m('c', 1), m('c1', 5), m('c2', 2)], edges: [e('c', 'c1'), e('c', 'c2')] },
      b: { entry: 'd', modules: [m('d', 4), m('d1', 7), m('d2', 3)], edges: [e('d', 'd1'), e('d1', 'd2')] },
      aExpected: { entry: 'c', paths: ['c', 'c1'], bytes: 6 }, bExpected: { entry: 'd', paths: ['d', 'd1', 'd2'], bytes: 14 },
    },
    {
      a: { entry: 'x', modules: [m('x', 0), m('x1', 8), m('x2', 3)], edges: [e('x', 'x1'), e('x1', 'x2')] },
      b: { entry: 'y', modules: [m('y', Number.MAX_SAFE_INTEGER), m('y1', 1)], edges: [e('y', 'y1')] },
      aExpected: { entry: 'x', paths: ['x', 'x1', 'x2'], bytes: 11 }, bExpected: null,
    },
  ];
  const original = structuredClone(pairs);
  for (const { a, b, aExpected, bExpected } of pairs) {
    const union = { entry: a.entry, modules: [...a.modules, ...b.modules], edges: [...a.edges, ...b.edges] };
    const reversed = { ...union, modules: [...union.modules].reverse(), edges: [...union.edges].reverse() };
    success(a, aExpected);
    success(union, aExpected);
    success(reversed, aExpected);
    success(union, aExpected);
    const bUnion = { ...union, entry: b.entry };
    const bReversed = { ...reversed, entry: b.entry };
    if (bExpected) {
      success(b, bExpected);
      success(bUnion, bExpected);
      success(bReversed, bExpected);
      success(bUnion, bExpected);
    } else {
      graph(b);
      graph(bUnion);
      graph(bReversed);
      graph(bUnion);
    }
  }
  assert.deepEqual(pairs, original);
});

test('missing endpoints fail without leaking input', () => {
  const secret = 'SYNTHETIC_MISSING_ENDPOINT_SECRET';
  graph({ entry: 'a', modules: [m('a', 1), m('b', 2)], edges: [e('b', secret)] });
});
