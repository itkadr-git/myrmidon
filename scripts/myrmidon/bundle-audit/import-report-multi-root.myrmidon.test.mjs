import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-multi-root.mjs', import.meta.url).pathname;
const run = (input, roots) => spawnSync(process.execPath, [cli, ...roots], { input, encoding: 'utf8', timeout: 5000 });
const mod = (path, bytes, eager = false) => ({ path, bytes, eager });
const edge = (from, to, kind = 'eager') => ({ from, to, kind, specifier: to ?? 'external' });

function check(report, roots, expected) {
  const result = run(JSON.stringify(report), roots);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), expected);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  assert.equal(run(JSON.stringify(reversed), [...roots].reverse()).stdout, result.stdout);
}

test('single and disjoint roots count zero bytes and exclude disconnected modules', () => {
  const report = { entry: 'a', modules: [mod('a', 0), mod('b', 2), mod('z', 9)], edges: [] };
  check(report, ['a'], { roots: ['a'], paths: ['a'], bytes: 0, perRoot: [{ root: 'a', paths: ['a'], bytes: 0 }], sharedPaths: [], sharedBytes: 0 });
  check(report, ['b', 'a'], { roots: ['a', 'b'], paths: ['a', 'b'], bytes: 2, perRoot: [{ root: 'a', paths: ['a'], bytes: 0 }, { root: 'b', paths: ['b'], bytes: 2 }], sharedPaths: [], sharedBytes: 0 });
});

test('pairwise sharing, diamond, reachable root, cycles and lazy edges', () => {
  const report = { entry: 'a', modules: [mod('a', 1), mod('b', 2), mod('c', 3), mod('d', 4), mod('x', 5), mod('z', 8)], edges: [edge('a', 'b'), edge('a', 'd'), edge('b', 'd'), edge('d', 'a'), edge('c', 'x'), edge('b', 'x'), edge('a', 'z', 'lazy'), edge('a', null)] };
  check(report, ['c', 'a', 'b'], { roots: ['a', 'b', 'c'], paths: ['a', 'b', 'c', 'd', 'x'], bytes: 15, perRoot: [{ root: 'a', paths: ['a', 'b', 'd', 'x'], bytes: 12 }, { root: 'b', paths: ['a', 'b', 'd', 'x'], bytes: 12 }, { root: 'c', paths: ['c', 'x'], bytes: 8 }], sharedPaths: ['a', 'b', 'd', 'x'], sharedBytes: 12 });
});

test('invalid inputs fail closed with categories and no input disclosure', () => {
  const valid = { entry: 'secret', modules: [mod('secret', 1), mod('x', 2)], edges: [] };
  const cases = [
    ['argv', JSON.stringify(valid), []], ['argv', JSON.stringify(valid), ['secret', 'secret']],
    ['json', '{secret', ['secret']], ['shape', '{}', ['secret']],
    ['shape', JSON.stringify({ ...valid, modules: [mod('secret', -1)] }), ['secret']],
    ['graph', JSON.stringify(valid), ['missing-secret']],
    ['graph', JSON.stringify({ ...valid, entry: 'missing' }), ['secret']],
    ['graph', JSON.stringify({ ...valid, modules: [mod('secret', 1), mod('secret', 2)] }), ['secret']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('secret', 'x'), edge('secret', 'x')] }), ['secret']],
    ['graph', JSON.stringify({ ...valid, edges: [edge('secret', 'missing')] }), ['secret']],
    ['graph', JSON.stringify({ entry: 'a', modules: [mod('a', Number.MAX_SAFE_INTEGER), mod('b', 1)], edges: [] }), ['a', 'b']],
  ];
  for (const [category, input, roots] of cases) {
    const result = run(input, roots);
    assert.equal(result.status, 1, category);
    assert.equal(result.stdout, '', category);
    assert.equal(result.stderr, `${category}\n`);
  }
});
