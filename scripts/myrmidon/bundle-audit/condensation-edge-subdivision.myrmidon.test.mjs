import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('./import-report-condensation.mjs', import.meta.url).pathname;
const m = (path, bytes) => ({ path, bytes, eager: true });
const e = (from, to, specifier, kind = 'eager') => ({ from, to, specifier, kind });
const c = (id, paths, bytes) => ({ id, paths, bytes });
const edge = (from, to) => ({ from, to });

function check(report, mode, expected) {
  const original = JSON.stringify(report);
  const reversed = { ...report, modules: [...report.modules].reverse(), edges: [...report.edges].reverse() };
  let canonical;
  for (const input of [report, report, reversed]) {
    const result = spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /\n$/);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    if (canonical !== undefined) assert.equal(result.stdout, canonical);
    canonical = result.stdout;
  }
  assert.equal(JSON.stringify(report), original);
}

test('subdivide an internal SCC edge with a zero-byte module', () => {
  const baseline = { entry: 'a', modules: [m('a', 2), m('b', 3)], edges: [e('a', 'b', 'ab'), e('b', 'a', 'ba')] };
  const transformed = { entry: 'a', modules: [m('a', 2), m('b', 3), m('x', 0)], edges: [e('a', 'x', 'ax'), e('x', 'b', 'xb'), e('b', 'a', 'ba')] };
  for (const mode of ['eager', 'all']) {
    check(baseline, mode, { entry: 'a', components: [c('a', ['a', 'b'], 5)], edges: [] });
    check(transformed, mode, { entry: 'a', components: [c('a', ['a', 'b', 'x'], 5)], edges: [] });
  }
});

test('an earlier subdivision path becomes the SCC id', () => {
  const baseline = { entry: 'b', modules: [m('b', 4), m('c', 6)], edges: [e('b', 'c', 'bc'), e('c', 'b', 'cb')] };
  const transformed = { entry: 'b', modules: [m('b', 4), m('c', 6), m('a', 0)], edges: [e('b', 'a', 'ba'), e('a', 'c', 'ac'), e('c', 'b', 'cb')] };
  for (const mode of ['eager', 'all']) {
    check(baseline, mode, { entry: 'b', components: [c('b', ['b', 'c'], 10)], edges: [] });
    check(transformed, mode, { entry: 'b', components: [c('a', ['a', 'b', 'c'], 10)], edges: [] });
  }
});

test('subdivide a DAG edge while a lazy return edge only merges all-mode components', () => {
  const baseline = { entry: 'a', modules: [m('a', 2), m('b', 3), m('c', 4)], edges: [e('a', 'b', 'ab'), e('b', 'c', 'bc'), e('c', 'b', 'cb', 'lazy')] };
  const transformed = { entry: 'a', modules: [m('a', 2), m('b', 3), m('c', 4), m('x', 0)], edges: [e('a', 'x', 'ax'), e('x', 'b', 'xb'), e('b', 'c', 'bc'), e('c', 'b', 'cb', 'lazy')] };
  check(baseline, 'eager', { entry: 'a', components: [c('a', ['a'], 2), c('b', ['b'], 3), c('c', ['c'], 4)], edges: [edge('a', 'b'), edge('b', 'c')] });
  check(transformed, 'eager', { entry: 'a', components: [c('a', ['a'], 2), c('b', ['b'], 3), c('c', ['c'], 4), c('x', ['x'], 0)], edges: [edge('a', 'x'), edge('b', 'c'), edge('x', 'b')] });
  check(baseline, 'all', { entry: 'a', components: [c('a', ['a'], 2), c('b', ['b', 'c'], 7)], edges: [edge('a', 'b')] });
  check(transformed, 'all', { entry: 'a', components: [c('a', ['a'], 2), c('b', ['b', 'c'], 7), c('x', ['x'], 0)], edges: [edge('a', 'x'), edge('x', 'b')] });
});

test('reject a subdivision endpoint missing from modules', () => {
  const invalid = { entry: 'a', modules: [m('a', 2), m('b', 3)], edges: [e('a', 'x', 'ax'), e('x', 'b', 'xb')] };
  for (const mode of ['eager', 'all']) {
    const result = spawnSync(process.execPath, [cli, mode], { input: JSON.stringify(invalid), encoding: 'utf8', timeout: 5000 });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'graph\n');
  }
});
