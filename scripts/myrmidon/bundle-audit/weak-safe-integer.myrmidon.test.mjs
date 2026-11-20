import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = process.env.MYRMIDON_WEAK_TEST_CLI ?? join(dirname(fileURLToPath(import.meta.url)), 'import-report-weak-components.mjs');
const max = Number.MAX_SAFE_INTEGER;
const moduleAt = (path, bytes) => ({ path, bytes, eager: false });
const edge = (from, specifier, kind, to) => ({ from, specifier, kind, to });
const run = (report, mode = 'eager') => spawnSync(process.execPath, [cli, mode], {
  input: JSON.stringify(report), encoding: 'utf8', timeout: 10000,
});
function success(result, expected) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, JSON.stringify(expected) + '\n');
}
function failure(result, category) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, category + '\n');
}

test('individual byte values accept zero and max, reject unsafe or non-integers as shape', () => {
  for (const bytes of [0, max]) {
    success(run({ entry: 'a', modules: [moduleAt('a', bytes)], edges: [] }),
      { entry: 'a', components: [{ id: 'a', paths: ['a'], bytes }] });
  }
  for (const bytes of [max + 1, -1, 1.5, '1', null]) {
    failure(run({ entry: 'a', modules: [moduleAt('a', bytes)], edges: [] }), 'shape');
  }
});

test('component sum accepts max plus zero and rejects overflow without entry', () => {
  const report = { entry: 'a', modules: [moduleAt('a', 0), moduleAt('b', max), moduleAt('c', 0)],
    edges: [edge('b', 'c', 'eager', 'c')] };
  success(run(report), { entry: 'a', components: [
    { id: 'a', paths: ['a'], bytes: 0 }, { id: 'b', paths: ['b', 'c'], bytes: max },
  ] });
  failure(run({ ...report, modules: [moduleAt('a', 0), moduleAt('b', max), moduleAt('c', 1)] }), 'graph');
});

test('disconnected maximum sums remain local; lazy bridge overflows only in all mode', () => {
  const report = { entry: 'a', modules: [moduleAt('a', max), moduleAt('b', max)],
    edges: [edge('a', 'bridge', 'lazy', 'b')] };
  const expected = { entry: 'a', components: [
    { id: 'a', paths: ['a'], bytes: max }, { id: 'b', paths: ['b'], bytes: max },
  ] };
  success(run({ ...report, edges: [] }, 'all'), expected);
  success(run(report, 'eager'), expected);
  failure(run(report, 'all'), 'graph');
});

test('aliases and self-loops do not count module bytes twice', () => {
  const report = { entry: 'a', modules: [moduleAt('a', max), moduleAt('b', 0)], edges: [
    edge('a', 'first', 'eager', 'b'), edge('a', 'alias', 'eager', 'b'),
    edge('a', 'self', 'eager', 'a'), edge('b', 'self', 'eager', 'b'),
  ] };
  const expected = { entry: 'a', components: [{ id: 'a', paths: ['a', 'b'], bytes: max }] };
  success(run(report, 'eager'), expected);
  success(run(report, 'all'), expected);
});
